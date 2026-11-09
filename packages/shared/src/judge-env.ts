import {z} from 'zod';

/**
 * Who judges returned work (the orchestrator's `Judge`), as configuration.
 *
 * - `chain` (the default): the orchestrator's own brain, `BRAIN_CHAIN_ORCHESTRATOR`.
 * - `near-ai`: NEAR AI Cloud's OpenAI-compatible chat completions
 *   (docs.near.ai/cloud), with `NEAR_AI_API_KEY`. Off unless chosen.
 *
 * `AGENT_MODE` still decides whether tokens are spent at all: with
 * `cached` (the default) the judge replays recordings whatever this says, so
 * nothing reaches the network.
 *
 * Kept here, not in one service, because the API validates it at boot and
 * `@pactora/agent-core` validates it again for the processes that have no
 * boot schema (the orchestrator CLI, the demo). Two copies of a rule drift.
 */
export const JUDGE_PROVIDERS = ['chain', 'near-ai'] as const;
export type JudgeProvider = (typeof JUDGE_PROVIDERS)[number];

/** Documented at docs.near.ai/cloud/quickstart (2026-11). */
export const NEAR_AI_DEFAULT_BASE_URL = 'https://cloud-api.near.ai/v1';
export const NEAR_AI_DEFAULT_MODEL = 'zai-org/GLM-5.1-FP8';

export const JudgeEnv = z.object({
  JUDGE_PROVIDER: z
    .enum(JUDGE_PROVIDERS, {message: `JUDGE_PROVIDER must be one of ${JUDGE_PROVIDERS.join(', ')}`})
    .default('chain'),
  /** Required with JUDGE_PROVIDER=near-ai. A secret: `.env` only, never logged. */
  NEAR_AI_API_KEY: z.string().min(1).optional(),
  NEAR_AI_MODEL: z.string().min(1).optional(),
  NEAR_AI_BASE_URL: z
    .string()
    .url()
    .regex(/^https:\/\//, 'NEAR_AI_BASE_URL must be an https URL')
    .optional(),
  /**
   * Refuse a NEAR AI verdict whose response signature is missing or does not
   * verify (docs/24 §4). Default on when the provider is near-ai; `0` lets an
   * unsigned verdict through (development against a provider without the
   * signature endpoint).
   */
  JUDGE_REQUIRE_ATTESTATION: z
    .enum(['0', '1', 'true', 'false'], {message: 'JUDGE_REQUIRE_ATTESTATION must be 0 or 1'})
    .optional(),
});

/** Whether a NEAR AI verdict needs a verified signature: on unless set to 0/false. */
export function requireAttestation(env: Pick<JudgeEnv, 'JUDGE_REQUIRE_ATTESTATION'>): boolean {
  const v = env.JUDGE_REQUIRE_ATTESTATION;
  return v === undefined || v === '1' || v === 'true';
}
export type JudgeEnv = z.infer<typeof JudgeEnv>;

/** The rule a shape cannot say: the provider needs its key. */
export const judgeKeyRule = {
  check: (e: {JUDGE_PROVIDER: JudgeProvider; NEAR_AI_API_KEY?: string | undefined}) =>
    e.JUDGE_PROVIDER !== 'near-ai' || Boolean(e.NEAR_AI_API_KEY),
  message: 'JUDGE_PROVIDER=near-ai needs NEAR_AI_API_KEY',
  path: ['NEAR_AI_API_KEY'],
};

/**
 * Parse the judge settings from an environment, throwing one error that
 * names every problem. Values are never echoed: the key is a secret.
 */
export function parseJudgeEnv(env: Record<string, string | undefined>): JudgeEnv {
  // As loadEnv does: `.env` files leave unused names as the empty string.
  const cleaned = Object.fromEntries(
    Object.keys(JudgeEnv.shape)
      .map((k) => [k, env[k]] as const)
      .filter(([, v]) => v !== undefined && v !== ''),
  );
  const result = JudgeEnv.refine(judgeKeyRule.check, {
    message: judgeKeyRule.message,
    path: judgeKeyRule.path,
  }).safeParse(cleaned);
  if (result.success) return result.data;
  throw new Error(
    `invalid judge settings: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
  );
}
