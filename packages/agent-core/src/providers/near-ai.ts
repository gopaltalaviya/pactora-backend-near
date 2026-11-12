import {createHash} from 'node:crypto';
import {ed25519} from '@noble/curves/ed25519';
import {secp256k1} from '@noble/curves/secp256k1';
import {keccak_256} from '@noble/hashes/sha3';
import {
  NEAR_AI_DEFAULT_BASE_URL,
  NEAR_AI_DEFAULT_MODEL,
  canonicalize,
  type JudgeAttestation,
} from '@pactora/shared';
import {JsonHttpBrain} from './json-provider.js';
import {JudgeAttestationFailed, type CompletionRequest, type CompletionResult} from '../brain.js';

/**
 * NEAR AI Cloud (docs.near.ai/cloud): OpenAI-compatible chat completions,
 * Bearer auth, base URL `https://cloud-api.near.ai/v1`. Used as the judge
 * when `JUDGE_PROVIDER=near-ai`; off by default.
 *
 * Retries, timeouts and the status mapping (401/403 auth, 429 rate limit,
 * 5xx outage) are the shared `JsonHttpBrain`'s, so this provider fails the
 * way every other one does and the fallback chain treats it the same.
 *
 * Attestation (2026-11-09, docs/24 §4): every response is signed inside the
 * provider's TEE, and `GET /v1/signature/<response id>` returns the
 * signature. The signed text is `sha256(request bytes):sha256(response
 * bytes)` (a model prefix is tolerated); the algorithm is `ed25519` or
 * `ecdsa` (a secp256k1 ECDSA (EIP-191) signing address). With `requireAttestation`
 * (the default) a verdict whose signature is missing or does not verify is
 * refused with JudgeAttestationFailed — not retried elsewhere, since a
 * recording cannot stand in for a signed ruling — and the verified
 * attestation travels with the result for the API to store.
 *
 * The key is an ES private field: it does not appear when the brain is
 * logged, inspected or serialised, and it is scrubbed from any error text
 * (a provider that echoes a request back would otherwise put it in a log).
 */
export class NearAiBrain extends JsonHttpBrain {
  readonly name = 'near-ai';
  protected readonly model: string;
  readonly #apiKey: string | undefined;
  readonly #baseUrl: string;
  readonly #requireAttestation: boolean;
  readonly #thinking: boolean;

  constructor(
    model: string | undefined = undefined,
    apiKey: string | undefined = undefined,
    baseUrl: string | undefined = undefined,
    requireAttestation = true,
    /**
     * Whether the model reasons before it answers. On for the judge, whose
     * verdict is worth the tokens; off for workers (2026-11-12), where it cost
     * ~10x the tokens and cut structured replies off at the limit.
     */
    thinking = true,
  ) {
    super();
    this.model = model || NEAR_AI_DEFAULT_MODEL;
    this.#apiKey = apiKey || undefined;
    this.#baseUrl = (baseUrl || NEAR_AI_DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.#requireAttestation = requireAttestation;
    this.#thinking = thinking;
  }

  override async complete<T>(req: CompletionRequest<T>): Promise<CompletionResult<T>> {
    try {
      return await super.complete(req);
    } catch (err) {
      const key = this.#apiKey;
      if (key && err instanceof Error && (err.message.includes(key) || err.stack?.includes(key))) {
        err.message = err.message.split(key).join('[redacted]');
        if (err.stack) err.stack = err.stack.split(key).join('[redacted]');
      }
      throw err;
    }
  }

  protected endpoint(): string | null {
    return this.#apiKey ? `${this.#baseUrl}/chat/completions` : null;
  }

  protected buildRequest(req: CompletionRequest<unknown>, jsonSchema: object) {
    return {
      url: this.endpoint()!,
      headers: {authorization: `Bearer ${this.#apiKey}`},
      body: {
        model: this.model,
        // The hosted models reason before they answer, and the reasoning
        // counts against max_tokens (as Groq's gpt-oss and Gemini 3.x do); 4,096
        // cut real Qwen3.6 replies off (2026-11-12), so the floor is 8,192.
        max_tokens: Math.max(req.maxTokens ?? 2_000, 8_192),
        messages: [
          {role: 'system', content: req.system},
          {role: 'user', content: req.prompt},
        ],
        // "Structured outputs" per the OpenAI-compatibility guide. Not strict:
        // the answer is validated against the schema here either way.
        response_format: {
          type: 'json_schema',
          json_schema: {name: req.schemaName, schema: jsonSchema, strict: false},
        },
        ...(this.#thinking ? {} : {chat_template_kwargs: {enable_thinking: false}}),
      },
    };
  }

  protected extractText(payload: unknown): string | null {
    const p = payload as {choices?: {message?: {content?: string}}[]};
    return p.choices?.[0]?.message?.content ?? null;
  }

  protected override isTruncated(payload: unknown): boolean {
    const p = payload as {choices?: {finish_reason?: string}[]};
    return p.choices?.[0]?.finish_reason === 'length';
  }

  /**
   * Fetch and check the response's signature (when required). Answers the
   * attestation to carry with the result; throws JudgeAttestationFailed when
   * the signature is missing, malformed, over other bytes, or does not
   * verify. With the check off (JUDGE_REQUIRE_ATTESTATION=0) nothing is
   * fetched and the verdict carries no attestation.
   */
  protected override async attest(
    requestBody: string,
    responseBody: string,
    payload: unknown,
    value: unknown,
  ): Promise<JudgeAttestation | undefined> {
    if (!this.#requireAttestation) return undefined;
    const fail = (why: string) => new JudgeAttestationFailed(this.name, why);
    const id = (payload as {id?: unknown}).id;
    if (typeof id !== 'string' || id.length === 0)
      throw fail('the response carries no id to fetch a signature for');
    let res: Response;
    try {
      res = await fetch(`${this.#baseUrl}/signature/${encodeURIComponent(id)}`, {
        headers: {authorization: `Bearer ${this.#apiKey}`},
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw fail(`the signature could not be fetched: ${(err as Error).message}`);
    }
    if (!res.ok) throw fail(`the signature endpoint answered ${res.status}`);
    const raw = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    const text = raw?.['text'];
    const signature = raw?.['signature'];
    const address = raw?.['signing_address'];
    const algo = raw?.['signing_algo'];
    if (
      typeof text !== 'string' ||
      typeof signature !== 'string' ||
      typeof address !== 'string' ||
      (algo !== 'ed25519' && algo !== 'ecdsa')
    ) {
      throw fail('the signature response is not in the documented shape');
    }
    const expected = `${sha256Hex(requestBody)}:${sha256Hex(responseBody)}`;
    // Exactly the bytes exchanged; a model prefix (`<model>:`) is tolerated.
    if (text !== expected && !text.endsWith(`:${expected}`)) {
      throw fail('the signed text is not the hash of the request and response that were exchanged');
    }
    const ok =
      algo === 'ed25519' ? verifyEd25519(text, signature, address) : verifyEip191(text, signature, address);
    if (!ok) throw fail(`the ${algo} signature does not verify against ${address}`);
    return {
      provider: this.name,
      model: this.model,
      responseId: id,
      signature,
      signingAddress: address,
      signingAlgo: algo,
      signedText: text,
      verifiedAt: new Date().toISOString(),
      verdictHash: sha256Hex(canonicalize(value)),
      // The bytes themselves, so whoever stores this can check it too.
      requestBody,
      responseBody,
    };
  }
}

const sha256Hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/** Bytes from hex (with or without 0x) or base64; null when neither parses to the wanted length. */
function bytesOf(s: string, wanted?: number): Uint8Array | null {
  const hex = s.startsWith('0x') ? s.slice(2) : s;
  let out: Uint8Array | null = null;
  if (/^[0-9a-fA-F]+$/.test(hex) && hex.length % 2 === 0) out = Uint8Array.from(Buffer.from(hex, 'hex'));
  else if (/^[A-Za-z0-9+/=_-]+$/.test(s)) out = Uint8Array.from(Buffer.from(s, 'base64'));
  if (out && wanted !== undefined && out.length !== wanted) return null;
  return out;
}

/** ed25519 over the UTF-8 text; the address is the 32-byte public key (hex or base64, `ed25519:` prefix allowed). */
export function verifyEd25519(text: string, signature: string, signingAddress: string): boolean {
  const pub = bytesOf(signingAddress.replace(/^ed25519:/, ''), 32);
  const sig = bytesOf(signature, 64);
  if (!pub || !sig) return false;
  try {
    return ed25519.verify(sig, new TextEncoder().encode(text), pub);
  } catch {
    return false;
  }
}

/** EIP-191 personal_sign: keccak256("\x19Ethereum Signed Message:\n<len><text>"), a 65-byte r‖s‖v signature, a secp256k1 ECDSA (EIP-191) signing address. */
export function verifyEip191(text: string, signature: string, signingAddress: string): boolean {
  const sig = bytesOf(signature, 65);
  if (!sig || !/^0x[0-9a-fA-F]{40}$/.test(signingAddress)) return false;
  try {
    const body = new TextEncoder().encode(text);
    const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${body.length}`);
    const digest = keccak_256(concat(prefix, body));
    let v = sig[64]!;
    if (v >= 27) v -= 27;
    if (v !== 0 && v !== 1) return false;
    const point = secp256k1.Signature.fromCompact(sig.slice(0, 64))
      .addRecoveryBit(v)
      .recoverPublicKey(digest);
    const uncompressed = point.toRawBytes(false).slice(1);
    const address = `0x${Buffer.from(keccak_256(uncompressed).slice(-20)).toString('hex')}`;
    return address.toLowerCase() === signingAddress.toLowerCase();
  } catch {
    return false;
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
