# Security

## Status

Pactora on NEAR runs on a **local NEAR sandbox and NEAR testnet only**, with a
test stablecoin. Neither this backend nor the NEAR contract has had an
external audit; one is required before mainnet. The NEAR port was reviewed
internally on 2026-11-07 (fixes listed in `PROGRESS.md`).

Before the port, the Monad baseline had an **internal pre-launch audit of v3 on
2026-10-26** (agentx-docs `docs/22-security-audit.md`) covering the contracts
and this backend — the signer (keys, KMS, policy), the API (auth, idempotency,
x402, SSE), the indexer, the agents and MCP, and the deploy files. Of its
backend findings, all three Highs and all three Mediums are fixed, each with a
test that fails on the code before the fix; the lower ones are fixed or
accepted there with reasons. What is left for the external audit is its §5.
None of it replaces an audit.

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
| **Spending caps hold even if the signer is compromised**, for every demo agent: they live in the agent's `AgentAccount` on chain — per task and a **rolling 24 h** daily cap. For a plain-EOA agent the signer enforces them off-chain (atomic reserve under a per-agent lock). | `agentx-contracts/src/AgentAccount.sol`, `apps/signer/src/signer.ts` |
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
  testnet the signer signs with **AWS KMS** keys that never leave AWS (agents'
  session keys, the keeper, the session manager); an encrypted keystore is
  still accepted there only one per agent, never one shared by every agent
  (`apps/signer/src/keysource.ts`, docs/21 §2). The KMS path was checked live
  against a stand-in that answers as KMS does, not yet a real AWS key
  (docs/22 §5).
