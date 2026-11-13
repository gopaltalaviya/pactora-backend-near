# Changelog

Notable changes, newest first. Dates are UTC. Evidence (red-first tests,
live checks, counts) is in `PROGRESS.md` and the commit messages.

## 2026-11-10 to 2026-11-13 — testnet, hosting, NEAR AI judge, credentials

- Deployed and run on NEAR testnet (`pactora.gopalt.testnet`, DAO
  `pactora-arbiter-gopalt.sputnikv2.testnet`); hosted API and three hosted
  agents whose brain is NEAR AI Cloud.
- NEAR AI judge: the API verifies the attested signature and binds it to the
  exact request and response bytes before an approval writes the verdict hash
  on chain as `review_hash`.
- Work credentials: the worker of a settled escrow job can claim a soulbound
  NEP-171 token on `credentials.gopalt.testnet` (`POST /v1/jobs/:id/credential`),
  idempotent, metadata read from the chain job; two MCP tools (33 in all).
- Receipts show the fee and what the worker received; job pages show bonds.
- Agent workers deliver listing jobs through draft rounds.

## 2026-11-09 — people, trust and remote agents

- Text search (`q`) on listings and jobs; `status=open|closed` on jobs.
- Listing and application events in the per-agent feed (bids, selections,
  rejections, closes, reopens, cancels, claims, expiries, matches), exactly
  once, through webhooks, notifications and Telegram.
- A person can decline an assigned job; a declined listing job gives its
  slot back. Per-owner agent cap (`MAX_AGENTS_PER_OWNER`, 100).
- Sessions end when an account's full-access keys, its agent's API key or
  its agent's wallet change. Key rotation is race-safe; key scopes
  (`read`, `client`, `worker`) are enforced.
- Profiles gain skills, location, availability, a task list, alerts and the
  chain's `hireable`; a new listing alerts the people it matches.
- Client dispute evidence (notes and photos) in the DAO desk's bundle and
  hash. Reports, a moderation queue, and blocks that write standing.
- `GET /v1/me/export`, `DELETE /v1/me`; a scheduled retention purge.
- Remote MCP over streamable HTTP. The NEAR AI judge verifies the response
  signature and the attestation is stored with the ruling.
- An x402 step in `pnpm demo:local`: a refundable escrow payment, settled
  and refunded on the sandbox.
- From a live probe and a UI audit: NUL bytes, empty PATCH, bearer case,
  request ids, 404 rate limits, unknown transactions, person privacy, the
  plain-arbiter desk, webhook secret rotation, a hireability check before
  selection, `unselect`, folded notifications, job titles, my bids, home
  stats.
- Earlier the same day: a held payout end to end on the sandbox; the NEAR AI
  Cloud judge (off by default); the security-audit fixes (H1, M1, M2,
  L1–L5, I1–I3) and the contracts 1.1.0 follow-up.

## 2026-11-08 — the people's marketplace (M1–M10)

- People sign in with NEP-413 and act on jobs by signing in their own
  wallet (prepare → sign → confirm). Listings with bids, multiple workers
  and instant claims; matching by skills and location.
- Evidence photos with metadata removed, draft rounds with review, chat.
- A per-agent event feed, signed webhooks, notifications, a test-token
  faucet; public profiles and blind two-way reviews.
- Sanctions screening, identity checks, compliance cases and soft standing
  gates; the admin console and the DAO dispute desk; Telegram and email.
- Ops scripts, keeper recovery, the UK sanctions list; an authorization
  matrix over every route and every kind of caller.
- The production compose file and Dockerfile carry the NEAR variables.

## 2026-11-05 to 2026-11-07 — Pactora on NEAR

- CAIP-2 network keys, NEAR config, `@pactora/near` (RPC, function calls,
  NEP-413, sha256).
- The indexer reads final NEAR blocks: Pactora's NEP-297 events and the
  payment token's NEP-141 transfers.
- The signer holds the agents' function-call keys (or AWS KMS ed25519 keys)
  and signs only the allowed Pactora methods.
- The API, SDK, agent runtime and MCP server on NEAR; the counterparty
  check (allow / warn / block) enforced at hire.
- `pnpm demo:local`: the whole system on a local NEAR sandbox in one
  command, with the attack (prompt injection, a stolen key) refused.
