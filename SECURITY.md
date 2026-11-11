# Security

## Status

Pactora on NEAR runs on a **local NEAR sandbox and NEAR testnet only**, with a
test stablecoin. Neither this backend nor the NEAR contract has had an
external audit; one is required before mainnet. The NEAR build was reviewed
internally on 2026-11-07 (fixes listed in `PROGRESS.md`).

An internal security audit of the backend on 2026-11-09 (findings H1, M1,
M2, L1–L5, I1–I3) is fixed, each with a test that fails on the code before
the fix; the evidence is in `PROGRESS.md`. None of it replaces an external
audit.

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private vulnerability reporting
on this repository ("Security" tab → "Report a vulnerability") with the
component, the request or call that triggers it, and a reproduction if you have
one. Testnet deployments hold no real value, so there is no bounty; credit is
given in the fix commit. (The owner still has to switch private reporting on in
the repository settings — docs/21 §0.)

## How the backend is built to fail safe

| Property | Where |
|---|---|
| **Only the signer holds a key.** The API encodes a transaction and hands it over private networking; a compromised API can propose, never sign. | `apps/signer`, `apps/api/src/submit.ts` |
| **The signer is not public.** Without `SIGNER_TOKEN` it binds to loopback and refuses to listen wider; with one, every request must present it (constant-time compare). | `apps/signer/src/auth.ts` |
| **Spending caps hold even if the signer is compromised**: they live in the Pactora contract, per agent — per task and a **rolling 24 h** daily cap — and an agent's wallet key is a function-call key scoped to Pactora, which cannot attach a deposit, so it can never withdraw. | `pactora-contracts-near/contracts/pactora`, `apps/signer/src/signer.ts` |
| **API keys:** `ax_<keyId>_<secret>`, 192 random bits; only a SHA-256 of the key is stored; one indexed lookup per request (no work amplification); shown once. | `apps/api/src/auth.ts` |
| **Rate limited per client IP before authentication**, so garbage keys cannot buy fresh buckets. | `apps/api/src/app.ts` |
| **Unguessable public ids** for jobs and runs; a serial id names nothing (404). | migration `0005` |
| **Every input validated** with zod — API bodies and queries, the signer's `/sign`, the environment at boot. RFC 7807 errors; a 500 never returns an internal message. | `apps/*/src` |
| **Secrets:** `.env` only; redacted from every log line (`authorization`, `x-payment`, key material); a pre-commit hook and CI scan tracked files; gitleaks scans the full history. | `scripts/check-no-secrets.mjs`, `packages/service/src/http.ts` |
| **Agent output is untrusted data**, never instructions: results are shape-checked before any model sees them and passed to models inside a delimited, instruction-free wrapper. | `packages/agent-core` (docs/04 §7.3) |
| **Supply chain:** frozen lockfile; `pnpm audit --prod` at high in CI; CodeQL; Dependabot. | `.github/` |
| **Containers** run as an unprivileged user with production dependencies only and no `.env`. | `Dockerfile` |

The full threat model is `docs/04-how-it-works.md` §9.

## Known limits

- Disputes are ruled by the arbiter, a **2-of-3 Sputnik DAO** (pactora-contracts-near
  `scripts/create-dao.mjs`). Until ownership is handed to the DAO, the
  contract's owner (the deployer key on testnet) can still `set_arbiter`, so
  one key can decide a dispute; the contracts README states this. A dispute
  nobody rules on expires in the worker's favour after the dispute timeout.
- Rate limiting and the SSE bus are per process. With more than one API
  replica the effective limit is N× the configured one; idempotency is
  unaffected (a UNIQUE constraint in Postgres).
- Jobs, specs and paid results are publicly readable by id (docs/22 L1,
  accepted): results meant to be private should not go through a public
  marketplace.
- Keys: raw keys are for testnet only and refused on any other chain. Off
  testnet the signer signs with **AWS KMS** ed25519 keys that never leave
  AWS (the agents' wallet keys and the keeper's), or with keys it generated
  and keeps encrypted under `SIGNER_KEY_PASSPHRASE`
  (`apps/signer/src/keysource.ts`). The KMS path is tested against a
  stand-in that answers as KMS does, not yet a real AWS key.
