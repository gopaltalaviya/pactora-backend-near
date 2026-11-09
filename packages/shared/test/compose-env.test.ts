/**
 * `docker-compose.full.yml` is the production recipe (deploy/vps). A service
 * reads only the variables compose passes it, so a setting its config schema
 * has but compose leaves out cannot be set on a server at all: the server's
 * `.env` reaches compose, not the container. That is how the api once could
 * not start in production — its schema requires COMPLIANCE_REVIEWERS there,
 * and compose never passed it. Every schema variable must be passed, or be
 * named below with the reason it is not.
 */
import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const compose = readFileSync(join(ROOT, 'docker-compose.full.yml'), 'utf8');

/**
 * Tuning knobs keep their defaults on the one-server recipe (pool sizes,
 * intervals, timeouts, stream caps); an operator who needs one adds it. Every
 * feature switch, secret and policy must be passed.
 */
const TUNING = /(_MS|_MAX|POOL_MAX|_PER_MINUTE|_PER_CLIENT|_MAX_STREAMS|_LAG_BLOCKS|CONCURRENCY)$/;

/** Deliberately not passed, by service, each with its reason. */
const ALL: Record<string, string> = {
  NODE_ENV: 'the image sets NODE_ENV=production (Dockerfile)',
};
const NOT_PASSED: Record<string, Record<string, string>> = {
  api: {
    ...ALL,
    PORT: 'the healthcheck and Caddy expect the default 8080',
    HOST: 'the container binds 0.0.0.0, the default',
    PACTORA_SIGN_RECIPIENT: 'the message recipient people sign for; changing it breaks every login',
    PACTORA_SELF_URL: "the api's own address for internal calls; the default is right in a container",
    WEBHOOK_ALLOW_PRIVATE: 'local demos only: production refuses it',
  },
  signer: {
    ...ALL,
    SIGNER_PORT: 'the api reaches the signer on its default port (SIGNER_URL)',
    SIGNER_HOST: 'the container binds 0.0.0.0, the default',
    TRUST_PROXY: 'nothing proxies the signer: it has no public port',
  },
  indexer: {...ALL},
  notifier: {...ALL, WEBHOOK_ALLOW_PRIVATE: 'local demos only: production refuses it'},
  channels: {...ALL, EMAIL_PROVIDER: 'only `fake` exists, and production refuses it'},
};

/** Environment keys of one service, with the `<<: *anchor` blocks it merges. */
function composeKeys(service: string): Set<string> {
  const anchors = new Map<string, string[]>();
  for (const m of compose.matchAll(/^x-[a-z-]+: &([a-z-]+)\n((?: {2}.*\n)+)/gm)) {
    anchors.set(
      m[1]!,
      [...m[2]!.matchAll(/^ {2}([A-Z_][A-Z0-9_]*):/gm)].map((k) => k[1]!),
    );
  }
  const start = compose.search(new RegExp(`^ {2}${service}:\\n`, 'm'));
  if (start < 0) throw new Error(`no service ${service} in docker-compose.full.yml`);
  const rest = compose.slice(start + 1);
  const end = rest.search(/^ {2}[a-z][a-z0-9-]*:\n|^[a-z]/m);
  const block = end < 0 ? rest : rest.slice(0, end);
  const keys = new Set([...block.matchAll(/^ {6}([A-Z_][A-Z0-9_]*):/gm)].map((k) => k[1]!));
  for (const a of block.matchAll(/<<: \*([a-z-]+)/g)) for (const k of anchors.get(a[1]!) ?? []) keys.add(k);
  return keys;
}

/** Variables a service's config schema (its `loadEnv` object in main.ts) reads, shared fields (`JudgeEnv.shape.X`) included. */
function schemaKeys(app: string): string[] {
  const src = readFileSync(join(ROOT, 'apps', app, 'src', 'main.ts'), 'utf8');
  return [
    ...new Set(
      [...src.matchAll(/^\s+([A-Z][A-Z0-9_]*): (?:z\b|env\.|[A-Z][A-Za-z]*Env\.shape\.)/gm)].map(
        (m) => m[1]!,
      ),
    ),
  ];
}

/**
 * Audit L4. The evidence store's encryption key was generated into the data
 * volume (`/data/.pactora-kms/key`), beside the data it protects: a copy of
 * the volume, or a backup of it, carried both. It is a secret the operator
 * holds, required at start, never derived or stored in the volume.
 */
describe('the evidence store’s KMS key', () => {
  const minio = compose.slice(compose.indexOf('\n  minio:\n'), compose.indexOf('\n  minio-setup:\n'));

  it('is required from the environment, like the other secrets', () => {
    expect(minio).toMatch(/MINIO_KMS_SECRET_KEY: \$\{MINIO_KMS_SECRET_KEY:\?/);
  });

  it('is never generated into, or read from, the data volume', () => {
    expect(minio).not.toMatch(/\.pactora-kms|\/dev\/urandom/);
  });
});

describe('docker-compose.full.yml passes every setting the services read', () => {
  for (const app of ['api', 'signer', 'indexer', 'notifier', 'channels']) {
    it(app, () => {
      const schema = schemaKeys(app);
      expect(schema.length, `found no schema in apps/${app}/src/main.ts`).toBeGreaterThan(0);
      const passed = composeKeys(app);
      const skipped = NOT_PASSED[app] ?? {};
      expect(schema.filter((k) => !passed.has(k) && !(k in skipped) && !TUNING.test(k))).toEqual([]);
      // A reason for a variable the schema no longer reads is a stale reason.
      expect(Object.keys(skipped).filter((k) => !(k in ALL) && !schema.includes(k))).toEqual([]);
    });
  }
});
