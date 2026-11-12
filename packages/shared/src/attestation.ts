import {z} from 'zod';

/**
 * A judge's attestation (2026-11-09): proof that a verdict came from the
 * model a provider says it did. NEAR AI Cloud signs every response from
 * inside its TEE (`GET /v1/signature/<response id>`, docs/24 §4): the signed
 * text is `sha256(request bytes):sha256(response bytes)` (model-prefixed on
 * some endpoints), with `ed25519` or `ecdsa` (EIP-191) over it, by the key
 * the attestation report names. The orchestrator verifies it before using
 * the verdict and sends it with the approve or dispute; the API stores it
 * with the job's event and shows it on the job and the run.
 */
export const JudgeAttestation = z.object({
  provider: z.string().min(1).max(64),
  model: z.string().min(1).max(200),
  responseId: z.string().min(1).max(200),
  signature: z.string().min(1).max(1000),
  signingAddress: z.string().min(1).max(200),
  signingAlgo: z.enum(['ed25519', 'ecdsa']),
  /** What was signed; the verifier recomputed it from the bytes it sent and received. */
  signedText: z.string().min(1).max(1000),
  verifiedAt: z.iso.datetime({offset: true}),
  /** sha256 of the canonical verdict JSON, so the stored verdict can be matched to this attestation. */
  verdictHash: z.string().regex(/^[0-9a-f]{64}$/),
  /**
   * The exact request and response bytes exchanged with the provider
   * (2026-11-12). The API re-hashes them against `signedText` and recomputes
   * `verdictHash` from the response, so the verdict is bound to what was
   * signed. Stored, never returned publicly: the request holds the job's work.
   */
  requestBody: z.string().min(1).max(200_000).optional(),
  responseBody: z.string().min(1).max(200_000).optional(),
});
export type JudgeAttestation = z.infer<typeof JudgeAttestation>;
