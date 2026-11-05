import {z} from 'zod';

/**
 * Environment, validated once at boot.
 *
 * Every service used to read `process.env` wherever it needed a value:
 * `DATABASE_URL!` with a non-null assertion, `Number(process.env.PORT)` that
 * becomes `NaN` on a typo, about two dozen variables across ten files. A
 * missing value then failed at the first request that needed it — minutes
 * into a deploy, with an error about something else. Now a service states
 * the environment it needs as a schema and refuses to start without it,
 * naming every problem at once.
 */
export class EnvError extends Error {
  constructor(readonly issues: string[]) {
    super(`invalid environment:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'EnvError';
  }
}

/** Parse `env` against `schema`; throw an `EnvError` listing every issue. */
export function loadEnv<S extends z.ZodTypeAny>(
  schema: S,
  env: Record<string, string | undefined> = process.env,
): z.infer<S> {
  // `.env` files set unused variables to the empty string; treat that as unset,
  // so a `.default()` applies instead of a confusing "invalid" error.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));
  const result = schema.safeParse(cleaned);
  if (result.success) return result.data;
  throw new EnvError(
    result.error.issues.map((i: z.ZodIssue) => `${i.path.join('.') || '(env)'}: ${i.message}`),
  );
}

/** Building blocks for service schemas. */
export const env = {
  postgresUrl: () => z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgres:// URL'),
  httpUrl: () =>
    z
      .string()
      .url()
      .regex(/^https?:\/\//, 'must be an http(s) URL'),
  port: (fallback: number) => z.coerce.number().int().min(1).max(65_535).default(fallback),
  positiveInt: (fallback: number) => z.coerce.number().int().positive().default(fallback),
  flag: () =>
    z
      .enum(['0', '1', 'true', 'false'])
      .default('0')
      .transform((v) => v === '1' || v === 'true'),
  /**
   * How far to believe `X-Forwarded-For`. A number is the count of proxies in
   * front of the service (Railway: `1`); `true` believes every hop and
   * `false`/`0` none. `true` lets a client name its own address — the
   * per-IP limits then count whatever it says — so it is kept only so an
   * existing deployment still boots.
   */
  trustProxy: () =>
    z
      .string()
      .regex(/^(true|false|\d{1,2})$/, 'must be a number of proxy hops, or true/false')
      .default('false')
      .transform((v): boolean | number => {
        if (v === 'true') return true;
        if (v === 'false') return false;
        const hops = Number(v);
        return hops === 0 ? false : hops;
      }),
  csv: () =>
    z
      .string()
      .default('')
      .transform((s) =>
        s
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean),
      ),
  logLevel: () => z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  nodeEnv: () => z.enum(['development', 'test', 'production']).default('development'),
  /** A NEAR secret key as near-cli and near-api-js write it: `ed25519:<base58>`. */
  nearSecretKey: () =>
    z.string().regex(/^ed25519:[1-9A-HJ-NP-Za-km-z]{43,90}$/, 'must be a NEAR key, ed25519:<base58>'),
};
