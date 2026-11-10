/**
 * Unsupported environment variables: names an older `.env` may still carry.
 *
 * Such a `.env` would otherwise boot quietly: the service finds nothing under
 * the name it reads and falls back to a default — a network nobody chose —
 * failing later with an error about something else. Every entrypoint refuses
 * instead, naming the variable to use. A variable that is set but empty counts
 * too.
 */

/**
 * Networks are keyed by CAIP-2 id (`near:testnet`, docs/NEAR-PORT.md §1),
 * never by number; a numeric-network variable would otherwise boot on the
 * defaults and talk to a network nobody chose.
 */
const NUMERIC_NETWORK_VARS: Record<string, string> = {
  ENABLED_CHAIN_IDS: 'use ENABLED_CHAINS (CAIP-2 ids such as near:testnet)',
  DEFAULT_CHAIN_ID: 'use DEFAULT_CHAIN (a CAIP-2 id such as near:testnet)',
};
const NUMERIC_RPC_VAR = /^RPC_URL_\d+$/;

function problemOf(name: string): string | null {
  const numeric = NUMERIC_NETWORK_VARS[name];
  if (numeric) return `${name} is an unsupported variable — ${numeric}`;
  if (NUMERIC_RPC_VAR.test(name))
    return `${name} is an unsupported variable — use RPC_URL_<SLUG>, e.g. RPC_URL_TESTNET`;
  return null;
}

/** One message per stale variable, sorted; empty when there are none. */
export function legacyEnvProblems(env: Record<string, string | undefined>): string[] {
  return Object.keys(env)
    .sort()
    .map(problemOf)
    .filter((p): p is string => p !== null);
}

export class LegacyEnvError extends Error {
  constructor(readonly problems: string[]) {
    super(
      `refusing to start — unsupported environment variables are set:\n${problems.map((p) => `  - ${p}`).join('\n')}`,
    );
    this.name = 'LegacyEnvError';
  }
}

/** Throw a `LegacyEnvError` if any unsupported variable is set. */
export function assertNoLegacyEnv(env: Record<string, string | undefined> = process.env): void {
  const problems = legacyEnvProblems(env);
  if (problems.length > 0) throw new LegacyEnvError(problems);
}
