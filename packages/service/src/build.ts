import {readFileSync} from 'node:fs';

/**
 * What is running: the service, its package version, the commit it was built
 * from and when.
 *
 * "Which code is live?" had no answer short of reading Railway's dashboard.
 * The image now records it at build time (`/app/build-info.json`, written by
 * the Dockerfile from `GIT_SHA`, which defaults to Railway's
 * `RAILWAY_GIT_COMMIT_SHA`), and every service reports it on `/health`.
 *
 * Every field is safe to publish: a commit of a public repository, a version
 * number and a timestamp. Anything that does not look like one is reported as
 * unknown rather than echoed, so a stray value in the environment can never
 * reach a response.
 */
export interface BuildInfo {
  service: string;
  version: string;
  /** Short git commit (12 hex characters), or 'unknown' — e.g. a local build. */
  commit: string;
  /** ISO-8601 build time, or null when not built as an image. */
  builtAt: string | null;
}

const SHA = /^[0-9a-f]{7,40}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const SEMVER = /^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/;

export function buildInfo(opts: {
  service: string;
  /** The service's package.json; its build-info.json sits beside it in an image. */
  packageJsonUrl?: URL;
  env?: Record<string, string | undefined>;
  /** Injected for tests. */
  readFile?: (url: URL) => string;
}): BuildInfo {
  const env = opts.env ?? process.env;
  const read = (url: URL): Record<string, unknown> => {
    try {
      return JSON.parse((opts.readFile ?? ((u) => readFileSync(u, 'utf8')))(url)) as Record<string, unknown>;
    } catch {
      return {};
    }
  };

  const pkg = opts.packageJsonUrl ? read(opts.packageJsonUrl) : {};
  const baked = opts.packageJsonUrl ? read(new URL('build-info.json', opts.packageJsonUrl)) : {};

  const commit = [baked['commit'], env['GIT_SHA'], env['RAILWAY_GIT_COMMIT_SHA']].find(
    (c): c is string => typeof c === 'string' && SHA.test(c),
  );
  const builtAt = [baked['builtAt'], env['BUILD_TIME']].find(
    (t): t is string => typeof t === 'string' && ISO.test(t),
  );
  const version =
    typeof pkg['version'] === 'string' && SEMVER.test(pkg['version']) ? pkg['version'] : 'unknown';

  return {
    service: opts.service,
    version,
    commit: commit ? commit.slice(0, 12).toLowerCase() : 'unknown',
    builtAt: builtAt ?? null,
  };
}
