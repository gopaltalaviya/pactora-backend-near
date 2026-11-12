import {createHash} from 'node:crypto';
import {verdictHashOfResponse, verifyEd25519, verifyEip191} from '@pactora/agent-core';
import {NEAR_AI_DEFAULT_BASE_URL, type JudgeAttestation} from '@pactora/shared';

/**
 * Checking a judge's attestation on the API (2026-11-12), not just storing it.
 *
 * A client sends `judge` with its approve or dispute. Before this the API
 * stored whatever arrived, so any client could put a "Judged on NEAR AI" badge
 * on its own job. Now:
 *
 * - the request and response bytes the judge exchanged must come with it:
 *   they must hash to the signed text (`[model:]sha256(req):sha256(res)`,
 *   the model prefix naming this model), and the verdict read out of the
 *   response must hash to `verdictHash`. So the verdict is the one NEAR AI
 *   signed, not any verdict next to any signature. Without the bytes the
 *   judge is not stored; with bytes that do not match, the call is refused;
 * - the signature must verify over the signed text, by the address given:
 *   if not, the call is refused (422), since the client sent something false;
 * - that address must be the one NEAR AI's public attestation report
 *   (`GET /v1/attestation/report?model=…`) gives for the model, the key held
 *   inside the model's enclave. If it is not, or the report cannot be read,
 *   the job is still approved, as the client asked, but no judge is stored,
 *   so no badge is shown and nothing is committed on chain.
 */

/** The signing address NEAR AI attests for a model, or null when it lists none. */
export type JudgeSigningAddress = (model: string, algo: 'ed25519' | 'ecdsa') => Promise<string | null>;

export type JudgeCheck = {ok: true} | {ok: false; refuse: string} | {ok: false; drop: string};

const bare = (a: string) => a.replace(/^ed25519:/, '').toLowerCase();

const sha256Hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

export async function checkJudge(j: JudgeAttestation, lookup?: JudgeSigningAddress): Promise<JudgeCheck> {
  if (!j.requestBody || !j.responseBody) {
    return {ok: false, drop: 'the request and response the judge exchanged were not sent with it'};
  }
  const exchanged = `${sha256Hex(j.requestBody)}:${sha256Hex(j.responseBody)}`;
  if (j.signedText !== exchanged && j.signedText !== `${j.model}:${exchanged}`) {
    return {ok: false, refuse: 'the signed text is not the hash of the request and response sent with it'};
  }
  if (verdictHashOfResponse(j.responseBody) !== j.verdictHash) {
    return {ok: false, refuse: 'the verdict hash is not the hash of the verdict in the signed response'};
  }
  const verifies =
    j.signingAlgo === 'ed25519'
      ? verifyEd25519(j.signedText, j.signature, j.signingAddress)
      : verifyEip191(j.signedText, j.signature, j.signingAddress);
  if (!verifies) {
    return {
      ok: false,
      refuse: `the judge's ${j.signingAlgo} signature does not verify against ${j.signingAddress}`,
    };
  }
  if (!lookup) return {ok: false, drop: 'no attestation report is configured'};
  let attested: string | null;
  try {
    attested = await lookup(j.model, j.signingAlgo);
  } catch (err) {
    return {ok: false, drop: `the attestation report could not be read: ${(err as Error).message}`};
  }
  if (!attested) return {ok: false, drop: `NEAR AI attests no ${j.signingAlgo} key for ${j.model}`};
  if (bare(attested) !== bare(j.signingAddress)) {
    return {ok: false, drop: `${j.signingAddress} is not the key NEAR AI attests for ${j.model}`};
  }
  return {ok: true};
}

/** Reads NEAR AI's public attestation report (no key needed), cached for 10 minutes per model. */
export function nearAiSigningAddress(
  baseUrl: string = NEAR_AI_DEFAULT_BASE_URL,
  fetchImpl: typeof fetch = fetch,
): JudgeSigningAddress {
  const base = baseUrl.replace(/\/+$/, '');
  const cache = new Map<string, {at: number; address: string | null}>();
  return async (model, algo) => {
    const key = `${model}|${algo}`;
    // Bounded: the model name comes from the client.
    if (cache.size > 64) cache.clear();
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.address;
    const res = await fetchImpl(
      `${base}/attestation/report?model=${encodeURIComponent(model)}&signing_algo=${algo}`,
      {signal: AbortSignal.timeout(10_000)},
    );
    if (!res.ok) throw new Error(`the report answered ${res.status}`);
    const body = (await res.json()) as {
      model_attestations?: {model_name?: string; signing_address?: string; signing_algo?: string}[];
    };
    const m = body.model_attestations?.find(
      (x) => x.model_name === model && (x.signing_algo === undefined || x.signing_algo === algo),
    );
    const address = typeof m?.signing_address === 'string' ? m.signing_address : null;
    cache.set(key, {at: Date.now(), address});
    return address;
  };
}
