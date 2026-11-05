/**
 * The env vars were renamed `AGENTX_*` → `PACTORA_*` on 2026-11-01.
 *
 * A `.env` written before then would otherwise boot quietly: the service reads
 * `PACTORA_API_URL`, finds nothing, and falls back to a default — talking to
 * the wrong API, or reading the wrong contracts checkout, and failing later
 * with an error about something else. Every entrypoint refuses instead, naming
 * the new variable. A variable that is set but empty counts too: a `.env`
 * copied from the old `.env.example` has those.
 */
const LEGACY_PREFIX = 'AGENTX_';
const PREFIX = 'PACTORA_';

/**
 * The EVM build keyed networks by number (`ENABLED_CHAIN_IDS=10143`). The NEAR
 * build keys them by CAIP-2 id (docs/NEAR-PORT.md §1). An old `.env` would
 * otherwise boot on the defaults and talk to a network nobody chose.
 */
const EVM_NETWORK_VARS: Record<string, string> = {
  ENABLED_CHAIN_IDS: 'use ENABLED_CHAINS (CAIP-2 ids such as near:testnet)',
  DEFAULT_CHAIN_ID: 'use DEFAULT_CHAIN (a CAIP-2 id such as near:testnet)',
};
const EVM_RPC_VAR = /^RPC_URL_\d+$/;

function problemOf(name: string): string | null {
  if (name.startsWith(LEGACY_PREFIX)) {
    return `${name} was renamed ${PREFIX}${name.slice(LEGACY_PREFIX.length)} on 2026-11-01 — rename it in your environment`;
  }
  const evm = EVM_NETWORK_VARS[name];
  if (evm) return `${name} is from the EVM build — ${evm}`;
  if (EVM_RPC_VAR.test(name))
    return `${name} is from the EVM build — use RPC_URL_<SLUG>, e.g. RPC_URL_TESTNET`;
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
      `refusing to start — pre-rename environment variables are set:\n${problems.map((p) => `  - ${p}`).join('\n')}`,
    );
    this.name = 'LegacyEnvError';
  }
}

/** Throw a `LegacyEnvError` if any `AGENTX_*` or EVM-era network variable is set. */
export function assertNoLegacyEnv(env: Record<string, string | undefined> = process.env): void {
  const problems = legacyEnvProblems(env);
  if (problems.length > 0) throw new LegacyEnvError(problems);
}
