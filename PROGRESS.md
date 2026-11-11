# Pactora on NEAR — Progress

> **START HERE every session.** This file is the memory that survives a closed
> terminal: the current state, how to resume, what blocks, what was decided,
> and a dated log of the NEAR work, newest first.

- Last updated: **2026-11-10** (branch `human-work`).
- Event: **NEAR Hackathon**, deadline **2026-11-14 23:59 UTC**.
  Track: **Agent Economy** (primary); AI Security & Defense alongside.
  Plan and status: `pactora-docs-near/docs/24-near-hackathon.md` §1.5 and §5.
- Wire contract between the services and the chain: `docs/NEAR-WIRE.md`.
- Current state: the whole stack runs end to end on a local NEAR sandbox
  (`pnpm demo:local`: agents, people's listings, evidence and review, the
  DAO desk, a held payout, x402, the attack refused), and `pnpm swarm:local`
  runs a 25-agent market on the same sandbox. Testnet deployment waits on
  the owner's funded account.
- Numbers (2026-11-10): tests 1383 passed, 10 skipped, 0 failed (typecheck, lint and
  format clean); `test:startup` all 42 refused (11-09); `demo:local` "Demo passed.", 80 checks
  with the DAO section (74 without); `swarm:local` "Swarm passed."; contracts `verify-near` 26/28 (the two
  DAO checks need `--dao`).

## Cold start (local, no keys)

```bash
# Docker Desktop running (Postgres :5443, MinIO :9110, NEAR sandbox :3030); contracts repo cloned beside this one
pnpm install && pnpm demo:local      # → "Demo passed."
pnpm swarm:local                     # sandbox still up → "Swarm passed." (own DB pactora_near_swarm)
DEMO_HOLD=1 pnpm demo:local          # then the interface: NEXT_PUBLIC_API_URL=http://127.0.0.1:8098 pnpm dev
export DATABASE_URL=postgres://pactora:pactora@127.0.0.1:5443/pactora_near
pnpm db:migrate && pnpm check        # NOT while a held demo uses the DB (tests TRUNCATE)
pnpm -r build && node scripts/test-startup.mjs
```

Contracts live checks (in `../pactora-contracts-near`, sandbox up):
`SANDBOX_KEY_FILE=../pactora-backend-near/.sandbox/validator_key.json node scripts/verify-near.mjs --network sandbox`
(add `--dao` with `SPUTNIK_DAO_WASM` from `create-dao.mjs --fetch-wasm` for the arbiter checks).

On Windows: `corepack` does not run from Git Bash; use PowerShell for
`corepack pnpm …`, and set `DATABASE_URL` in the same command.

**Branches:** `master` holds the NEAR foundation and M1–M10; `human-work` holds
2026-11-09's work. All four repos are on GitHub (private until submission).

## Next, in order

1. Owner: a funded testnet account in `pactora-contracts-near/.env`
   (`DEPLOYER_ACCOUNT_ID`, `DEPLOYER_SECRET_KEY`).
2. `node --env-file=.env scripts/create-dao.mjs --network testnet` →
   `deploy.mjs --network testnet` → `verify-near.mjs --network testnet` → copy
   facts here (`node scripts/sync-chain-facts.mjs`) → `DEMO_NETWORK=testnet pnpm demo`.
3. NEAR AI Cloud judge: one live call with the owner's key, to capture real
   response and signature fixtures (today's are written to the documented
   shape) and confirm the attestation field that names the signing key.
4. Merge `human-work`, tag `hackathon-submission` in all four repos, push
   (owner's go), video, X post, form.

## Blockers

- Testnet: the owner's funded deployer account (step 1).
- A real NEAR AI key for step 3 (spends the owner's quota: ask first).

## Owner decisions pending

- **job_events retention.** The brief asked for job events to be purged
  after 365 days; `job_events` is an append-only audit log guarded by a
  trigger (migration 0001). The purge removes the per-agent copies
  (`agent_events`) instead and leaves the log. Dropping the guard for old
  rows is the owner's call.
- **Deletion and the event log.** `DELETE /v1/me` scrubs text, photos,
  links, sessions and keys, and keeps job rows, job events and review
  ratings (the other party's history and the chain need them). Whether
  event payloads that quote a person's dispute reason should be scrubbed too
  is open; today they stay (dispute reasons are public by design).

## Traps

- Only the cargo-near wasm is valid (a plain cargo build traps refusals as
  `unreachable`): build in the pinned image, see the contracts README; the
  pinned image's wasm-opt segfaults on pactora (`--no-wasmopt`).
- near-api-js `retries` counts attempts, not retries.
- On a fresh database the API tests fail with `relation … does not exist`
  until `pnpm db:migrate`.
- Setting `MSYS_NO_PATHCONV=1` for a whole PowerShell session breaks pnpm's
  shell shims; set it only on the docker command that needs it.
- Browser tests on a laptop time out at 4 workers in Firefox/WebKit; pass at
  `--workers=2` (as CI).

---

## Log

### 2026-11-10 (branch human-work): direct hire, blocked listings, audit fixes

- **2ffa24b** — person → agent direct hire (`POST /v1/jobs/hire`: the
  same guards as selecting a bid, an idempotent job row, `create_job` for
  the person's wallet); `GET /v1/me/agents` (the owner's agents); bidder
  `hireable` (stake_of, 30 s cache); job `deadlines` from `get_job`;
  `/v1/network` `agentMode`; agent rename; MCP `find_listings`,
  `bid_on_listing`, `claim_listing` (28 tools); SDK `hireDirect`,
  `myAgents`, `updateAgent`; `demo:local` §8f, a direct hire settled on
  chain. Gate then: 1379 tests passed; demo 80 checks; swarm passed.
- **5bf54c7** — a blocked account's listings leave the public board
  (`GET /v1/listings`; `?mine=true` still lists them). Found by the live
  browser suite; red first in `reports.test.ts`.
- Audit fixes (this commit), each test red on the old source first:
  `/v1/network` `agentMode` reports `record` (it spends tokens; it read as
  `cached`), and any value but `cached`/`record` as `live`, the way
  agent-core's factory reads it (`reads.test.ts`, `openapi.test.ts`); the
  cached brain's hint says `AGENT_MODE=record`, the mode that saves a
  recording (`fallback.test.ts`); the OpenAPI summary of `GET /v1/listings`
  names the blocked-account filter (`openapi.test.ts`). README:
  `JUDGE_REQUIRE_ATTESTATION` is on by default (`=0` turns it off);
  `demo:local` runs only the `pactora-escrow` x402 scheme (one paid, one
  refunded); the demo check count.
- Gate: tests 1384 passed, 10 skipped, 0 failed, on a throwaway database
  (`pactora_test_auditfix`, dropped after; never the held demo's
  `pactora_near`); typecheck, lint, format clean. Demo count from the
  latest full `demo:local` (11-10): 80 check lines, 6 of them the DAO desk.

### 2026-11-09 (night, branch human-work): round 3 — history, audit export, indexer stall, the swarm

Every item has a test that failed on the old source first (source stashed or
moved aside, the new test run, the source restored). One line each:

| Feature | Commit | Red-first test, and what it showed on the old code |
|---|---|---|
| `GET /v1/agents/:id/history`, `GET /v1/profiles/:id/history` (52 weeks, amount buckets, shown ratings; no counterparty; unpublished person 404) | c2b6bc1 | `history.test.ts`: both routes 404 (`expected 404 to be 200`) |
| `GET /v1/admin/audit-log.csv` (reviewers; cases, decisions, standing, reports; no names or notes; 6 a minute; audited) | d10e6c4 | `audit-log.test.ts`: all 4 failed, every call 404 |
| Indexer: a start block the RPC has garbage-collected → `stalled: start block pruned` on /health and /v1/status, one error naming the fix, longest backoff | 9d579fd | `apps/indexer/test/pruned.test.ts`: 5 of 6 failed (`TypeError` not `StartBlockPrunedError`; loop waits `[2000, 4000, 8000, 16000]` not 60000 each; no state row); `status.test`: `expected 'unknown' to be 'down'` |
| Roles matrix rows for the three routes | 6e0df16 | `roles.test`: `routes with no row: [ 'GET /v1/admin/audit-log.csv', …(2) ]` (found by the gate) |
| CORS exposes `content-disposition` (interface ask: download file names) | 35a8cac | `cors.test`: `expected 'x-trace-id, retry-after' to contain 'content-disposition'` |
| Agent event counters locked in agent-id order (the swarm's deadlock) | cb19e32 | `apps/indexer/test/lock-order.test.ts`: `indexerError: "deadlock detected"`; `apps/api/test/lock-order.test.ts`: `apiError: "deadlock detected"` |
| `pnpm swarm:local` (AI Swarms track) | 6da95fb | first live run: 429 on `POST /v1/agents/wallet-key` (10/min per address); second: `INVALID_STATE job is "submitted"` (an SDK retry of a step that landed); third: `Swarm passed.` |

- Routes for the interface are in the live2 `api-contract.md` "Round 3"
  section (with a CHANGED list: an API key on the export is 401, the
  `note` column carries only fixed-list values, `components.indexer` is
  `down` with `chains[].indexer.state`/`fix`). docs/15 rows: pactora-docs-near
  0e3aedc.
- Migration 0032 `indexer_state`: one row per chain while stalled; the
  indexer deletes it on its next good tick. `blockRpc` now tells a pruned
  height (below `sync_info.earliest_block_height`) from a skipped one and
  throws `BlockPrunedError` instead of reading it as empty. Note: the local
  sandbox garbage-collects too (earliest 6501 at head 8842), which is why a
  fresh sandbox needs `INDEXER_START_AT_HEAD=1`.
- The swarm runs on its own database `pactora_near_swarm` (created and
  migrated by the script) and ports 8099/7099, so it never truncates the
  database a held demo or the live UI stack uses; it does not recreate the
  sandbox. `TRUST_PROXY=1` with an `x-forwarded-for` per agent, so the
  per-address registration limits count per agent.
- **Found by the swarm, then fixed (cb19e32):** under 20 concurrent jobs
  the API's event writes and the indexer's batch deadlocked on
  `agent_event_seq` row locks (the indexer took them in event order,
  `notifyApplicants` in row order). Now `lockAgentEventSeqs` (packages/db)
  takes every party's counter in agent-id order at the start of the
  indexer batch, `notifyApplicants`, unselect and account deletion; all
  other writers are one statement for at most two agents, which the 0018
  trigger orders. Red first, two connections: `lock-order.test.ts`
  (indexer and api) both `"deadlock detected"` on the old source. The
  swarm's API log: before, 9 "deadlock detected" and 7 unhandled 500s (and
  1 failed indexer batch); after, 0, 0 and 0 (143 s, `Swarm passed.`).
- Swarm, final run (fresh sandbox, after the demo): 20 listings, 76 bids,
  20 fills, median 36000 base units (range 21000-60000), 20 settled on
  chain; Atlas 8 wins (score 62), Cobalt 12 (score 70), Birch, Dune and
  Ember none (50); caps kept; buyers paid 0.795 mUSDC = sellers 0.78705 +
  fees 0.00795; I1 holds; 162 s; `Swarm passed.` In both runs the cheapest
  bids also came from the sellers with the better record, so reputation
  never overturned a price win: the rule is there, the run does not show
  it biting.
- Gate (after the deadlock fix): `pnpm check` 1352 passed, 10 skipped, 0 failed; `demo:local` "Demo passed.", 71 checks (one retry: the first attempt stopped at compose `--wait` while the recreated Postgres ran crash recovery for over 60 s); `swarm:local` "Swarm passed.", 143 s; build current.
- Gate (before it): `pnpm check` 1350 passed, 10 skipped, 0 failed (typecheck, lint,
  format clean; status.test passes with the docs/15 rows); `test:startup`
  all 42 refused; `check-no-secrets` clean (428 files); `demo:local` "Demo
  passed.", 71 checks; `swarm:local` "Swarm passed."; `pnpm build` current.

### 2026-11-09 (evening, branch human-work): people, trust and remote agents

Every item has a test that failed on the old source first (the source
stashed, the new test run, the source restored). One line of evidence each:

| Feature | Commit | Red-first test, and what it showed on the old code |
|---|---|---|
| Text search (`q`), jobs `status=open\|closed` | 444cb74 | `search.test.ts`: `q=shop fronts` was 200 not 422; no `status` filter |
| Listing and application events, exactly once | 7e82c3f | `listing-events.test.ts`: `expected [] to deeply equal [ 'listing.bid', 'listing.bid' ]` |
| Person decline, agent cap, faucet standing, 403 before 409 | bd3b3ae | `decline-and-guards.test.ts`: decline 422 "Invalid discriminator value", stranger 409 not 403, third agent 201 not 409 |
| Sessions end on key, API key or wallet change; rotate race | 980c932 | `session-revocation.test.ts`: 10 concurrent rotates all 200 (expected 1); owner session 200 after a rotate, not 401 |
| Profiles: skills, location, availability, tasks, alerts; `listing.match` | 4483ed4 | `profile-matching.test.ts`: none of the five fields; the match feed `expected []` |
| Client dispute evidence (notes, photos) in the desk bundle | 280fb52 | `dispute-evidence.test.ts`: `POST /v1/jobs/<id>/dispute/notes` 404 |
| Reports, the review queue, hide / warn / block | 34ac01c | `reports.test.ts`: `POST /v1/reports` 404; the 11th report an hour not 429 |
| `GET /v1/me/export`, `DELETE /v1/me`, retention purge | a6551a7 | `account.test.ts`, `retention.test.ts`: both routes 404, `purgeRetention` missing |
| Remote MCP over streamable HTTP (25 tools) | fd48885 | `apps/mcp/test/http.test.ts`: the module did not exist |
| NEAR AI judge attestation, stored with the ruling | 8d69834 | `attestation.test.ts`: `expected undefined to match object { provider: 'near-ai', … }` |
| API hygiene from the live probe | 9a5868b | `hygiene.test.ts`: NUL 500, `PATCH {}` 500, `bearer` 401, `<script>` request id echoed, 404s never 429 |
| Probe and UI-audit fixes (KYC hold, person privacy, plain-arbiter desk, webhook rotate, hireable check, unselect) | 917b232 | `probe-fixes.test.ts`: `expected 'held' to be 'expired'`; person row 200 not 404; not-hireable selection 200 not 409 |
| API key scopes enforced; rotate may narrow | cf0a813 | `scopes.test.ts`: a `read` key could hire |
| Read model (folded notifications, per-item read, titles, my bids, home stats) | b4d2bde | `read-model.test.ts`: the feed held all four items; the job had no title |
| Low-entropy secret keys refused; `hireable` on profiles | 76bc902 | `netguard.test.ts`: `Buffer.alloc(32, 7)` accepted |
| x402 step in `demo:local` (§8i) | 06193aa | the step's first run: 2 checks failed (the failed call was served and settled); fixed, green |
| NEAR-only repository (docs, deploy, names) | 7c1d900 | `packages/shared/test/unsupported-env.test.ts`: 2 of 5 failed on the old message |

- Renames: Postgres role and database `pactora` in `docker-compose.full.yml`
  and the deploy scripts; compose project `pactora-full` (Postgres on
  127.0.0.1:5444); the listen/notify channel `pactora_events` (migration
  0031); deploy paths `~/pactora`; the build's commit variable
  `GIT_COMMIT_SHA` (`GIT_SHA` still read).
- Deleted: `PLAN.md`, `scripts/video/` and an obsolete deploy script.
  Rewritten for NEAR: `README.md`, `CHANGELOG.md`, `SECURITY.md`,
  `CONTRIBUTING.md`, `docs/README.md`, `docs/NEAR-WIRE.md`,
  `deploy/vps/README.md`, this file.
- Gate: `pnpm check` 1333 passed, 10 skipped, 1 failed (`status.test` reads `pactora-docs-near` docs/15, which needs the 14 new routes: the docs repo's change); typecheck, lint, format clean; `test:startup` all 42 refused; `check-no-secrets` clean (421 files); `demo:local` "Demo passed.", 71 checks.

### 2026-11-09 (branch human-work): held payout on the sandbox, NEAR AI judge

- `pnpm demo:local` §8h: a worker is put on hold after submitting (the
  `account_standing` row screening writes). The client's approve is refused
  by the signer (FORBIDDEN, "payout is held"). After the review deadline
  passes by the chain's clock and two keeper sweeps, the job is still
  `Submitted` on chain and in the database, and the worker's purse is
  unchanged. Cleared, the keeper's `auto_approve` settles it and the purse
  rises by the price less the fee (39600). Red first: with the keeper filter
  removed, 2 checks failed (auto-approved while held); with the signer's
  refusal removed, 3 failed. Green: `Demo passed.`, 64 checks.
- `JUDGE_PROVIDER=near-ai` (off by default; `chain` = the orchestrator's
  brain judges, as before): `NearAiBrain` (packages/agent-core
  `providers/near-ai.ts`), OpenAI-compatible chat completions at
  `https://cloud-api.near.ai/v1`, default model `zai-org/GLM-5.1-FP8`
  (docs.near.ai, 2026-11; `NEAR_AI_MODEL`, `NEAR_AI_BASE_URL` override).
  Settings are validated by `JudgeEnv` in `@pactora/shared`, used by the api's
  boot schema and by `buildJudgeBrain`. The key is required when chosen, and
  `test:startup` refuses that (4 new cases, 40 in all). The key is never
  logged: it is a private field, and any echo is scrubbed from errors.
  `AGENT_MODE=cached` returns no judge brain, so the recordings answer and
  nothing reaches the network. Never called live: tests use a fake fetch over
  fixtures written to the documented shape (`test/fixtures/near-ai`). Before
  the first live run, re-capture them from the real API with the owner's OK.
  A JSON provider's 200 with a body that is not JSON now counts as an outage
  (it used to throw a raw SyntaxError).
- Gate: `pnpm check` 1231 passed, 10 skipped (a first run had one
  `channels` outbox failure, which also failed 1 of 3 runs alone; channels
  is unchanged here); `test:startup` all 40 refused; `demo:local` 64 checks.
- Docs follow-up: `pactora-docs-near` `check:env` needs the 4 new names in
  docs/08 (`JUDGE_PROVIDER`, `NEAR_AI_API_KEY`, `NEAR_AI_MODEL`,
  `NEAR_AI_BASE_URL`).


### 2026-11-09 (branch human-work): security-audit fixes

Every fix has a
test that failed on the old code first (the one line of evidence is quoted).
The auditor's reproductions were adapted into the repo's own test files.

- **H1 — a double-signed hire on `InvalidNonce` (fixed).** near-api-js
  retried `send_tx` up to 12 times on a 500/503/408 or a failed fetch, so a
  broadcast whose answer was lost was re-sent, the node answered
  `InvalidNonce` for a transaction that had EXECUTED, and the signer took
  that as "never sent" (row `failed`, no hash) — the caller's retry signed a
  second `create_job`. Now `send_tx` is sent once (`nearClient` has a
  1-attempt provider for it; `packages/near/src/index.ts`), and on ANY
  rejection the signer first asks for the outcome by hash and then reads the
  key's nonce: a known outcome is recorded as such; a nonce at or past ours
  (or a key that cannot be read) keeps the row `signed` for
  `resolveUncertain`; only a nonce still below ours marks the slot unused
  (`apps/signer/src/signer.ts` `send`, `nonceUsed`). Tests
  (`apps/signer/test/signer.test.ts`, "a transaction whose fate is not known
  at once"): the auditor's scenario — red `expected 'failed' not to be
  'failed'`, two `create_job`s on chain; a rejection for a used nonce — red
  (row `failed`); `send_tx` sent once — red `expected 4 to be 1`.
- **M1 — signer scrypt DoS and junk keys (fixed, one deviation).**
  (a) `encryptSecret`/`decryptSecret` use the asynchronous `crypto.scrypt`
  (`apps/signer/src/keystore.ts`); red `apps/signer/test/keys-dos.test.ts`:
  `the event loop stalled 217 ms` for 30 keys (green: under 150 ms, `/health`
  answered within the burst). (c) `POST /v1/agents/wallet-key` is limited to
  10 a minute per client (`WALLET_KEY_RATE_PER_MINUTE`,
  `apps/api/src/routes/agents.ts`; test in `identity.test.ts`, 11th → 429).
  (d) `WalletWatch` reads at most 8 balances at once (red `expected 40 to be
  less than or equal to 8`) and the signer watches only wallets an `agents`
  row names (`signingAccountsToWatch`, `apps/signer/src/wallets.ts`,
  `main.ts`) — this is what fixed the known "unauthenticated wallet-key
  creation degrades `/v1/status`" (removed from `pactora-docs-near`
  `docs/STATUS.md`). (b) **Deviation:** the brief asked that a key be
  refused unless the account exists on chain. That would break registration:
  by `docs/NEAR-WIRE.md` §5 the owner CREATES the wallet account with the
  key (`CreateAccount` + `AddKey` in one transaction; the interface's
  `lib/wallet.ts` and `scripts/demo.mjs` do exactly that), so the account
  cannot exist first. Instead a key is swept once it is unclaimed:
  `DbKeyStore.sweepUnclaimed` (hourly in `main.ts`,
  `SIGNER_KEY_UNCLAIMED_GRACE_MS`, default a day) deletes rows older than
  the grace period whose account is not on chain and that no agent row
  names, keeps every row when the RPC fails, and checks at most 50 rows per
  sweep. Tests in `keystore.test.ts` (red: `sweepUnclaimed is not a
  function`). Net effect: a junk row lives a day, is never read by the
  wallet watch, and costs no synchronous CPU.
- **M2 — unauthenticated key re-issue cost 20 RPC reads (fixed).**
  `verifyNep413` checks the signature locally first (near-api-js's own
  `verifyMessage` with a provider that answers "full access" without a
  network) and asks the chain about the key only for a signature that
  verifies — so `/v1/session`, `/v1/agents` and the re-issue all benefit
  (`packages/near/src/index.ts`; red `packages/near/test/near.test.ts`
  `expected 20 to be +0` RPC reads for 20 garbage signatures). `nonce` is
  required on `POST /v1/agents/:id/keys` and the try-every-live-challenge
  loop is gone (`apps/api/src/routes/keys.ts`; red `expected 201 to be
  422`); both re-issue routes are limited to 20 a minute per client
  (`REISSUE_RATE_PER_MINUTE`; test: 21st → 429). No client in this repo
  omitted the nonce (`scripts/demo.mjs` does not re-issue; the interface has
  no re-issue page). `docs/NEAR-WIRE.md` §5 updated.
- **L1 — IPv6 rate-limit buckets (fixed).** `clientKey(ip)` in
  `@pactora/service` (`http.ts`): IPv6 → its /64, IPv4 and IPv4-mapped
  unchanged; used by the app-wide limiter's `keyGenerator` and the
  `requester` fields in `session.ts`, `keys.ts`, `agents.ts`. Test
  `packages/service/test/client-key.test.ts` (red: `clientKey is not a
  function`).
- **L2 — SSRF guard gaps (fixed).** `netguard.ts` blocks `::/96`
  (IPv4-compatible), `::ffff:0:0:0/96` (SIIT), `2002::/16` (6to4),
  `64:ff9b:1::/48`, `fec0::/10`, `2001::/32` (Teredo), and judges the IPv6
  ranges before the embedded IPv4. Red: the auditor's probe ALLOWED
  `[::127.0.0.1]`, `[::ffff:0:7f00:1]`, `[2002:7f00:1::]`,
  `[64:ff9b:1::a00:1]`, `[fec0::1]`, Teredo (6 of 10); 8 new
  `isPublicAddress` cases and 5 `checkTarget` cases failed. Trap found on
  the way: a BlockList rule on `::ffff:0:0/96` refuses EVERY IPv4 address
  (Node checks IPv4 through its mapped form) — the SIIT range is
  `::ffff:0:0:0/96`.
- **L3 — council membership (fixed).** Only `call:VoteApprove` or
  `*:VoteApprove` makes a role council (`apps/api/src/routes/admin.ts`);
  red `apps/api/test/admin.test.ts`: a `transfer:VoteApprove`-only member
  got `200`, expected `403`.
- **L4 — MinIO KMS key in the data volume (fixed).**
  `docker-compose.full.yml` requires `MINIO_KMS_SECRET_KEY` from the
  environment (`${…:?}`) and no longer generates a key into `/data`;
  `.env.example` (empty), `deploy/vps/README.md` (the server `.env` line and
  the format `pactora:<32 random bytes, base64>`). Red
  `packages/shared/test/compose-env.test.ts`: 2 cases. A deployment that
  already holds objects under a volume-generated key must set that key's
  value as `MINIO_KMS_SECRET_KEY` (none exists today: the VPS was retired).
- **L5 — faucet owner check skipped on RPC failure (fixed).**
  `assertFaucetNotOwner` (`apps/signer/src/faucet.ts`) refuses to start when
  the token's `owner` cannot be read; red `apps/signer/test/faucet.test.ts`
  (3 cases). Not in `test:startup`: its cases point at a closed port, which
  the RPC network check refuses before the faucet guard runs.
- **I1 — backup integrity (fixed).** `deploy/vps/backup-lib.sh`: an
  HMAC-SHA256 beside every `.enc` (`<file>.hmac`), keyed from the
  passphrase under the label `pactora-backup-mac-v1`; `backup.sh` writes and
  self-verifies it and copies it off-host; `restore-test.sh` verifies it
  before `pg_restore` (and before `tar`). `bash deploy/vps/backup-lib.test.sh`:
  6 checks — the flipped ciphertext byte failed the MAC while openssl still
  decrypted the tampered file without error, which is the finding.
- **I2 — AEAD tag length and KDF cost (fixed).** `authTagLength: 16` on
  both sides of `keystore.ts` and `secretbox.ts`, a shortened tag refused;
  the KDF cost read from a row is bounded (N a power of two in [2^10, 2^17],
  r ≤ 32, p ≤ 16; `MAX_KDF_N`). Red: `keystore.test.ts` (a 4-byte tag was
  accepted; N = 2^18 was derived), `netguard.test.ts` secretbox (12-byte tag
  accepted).
- **I3 — the flaky channels outbox test (fixed).** `apps/channels/test`
  freezes `now` 1 s ahead in `beforeEach`; the outbox rows took the
  database's `now()` as `next_attempt_at`, so when the TRUNCATE and inserts
  took over a second under load nothing was due — `sent: 0`. Reproduced by
  a 1.2 s delay before the inserts (`expected { sent: +0, dropped: +0 }`);
  the rows now carry `nextAttemptAt` on the test clock, which passed with
  the delay in place and 10/10 without it. Production is unaffected (one
  real clock; a database ahead of the node delays a message by the skew).
- **Recorded, not changed:** dispute reasons are public in the
  `job.disputed` event (design); sessions outlive key removal (7 d); the
  services share one database role; `pnpm audit` advisories are dev-only
  (esbuild/vitest/glob/minimatch). vitest: the latest is 5.1.0 and the
  latest 3.x is the installed 3.2.7, so no upgrade was within the major and
  none was attempted.

### 2026-11-09 (branch human-work): contracts 1.1.0, the backend follows

Contracts `pactora-contracts-near` 25df5c3.


- `chain/config/params.*.json` re-synced (`node scripts/sync-chain-facts.mjs`):
  `dispute_grace` (10 s sandbox, 24 h testnet), testnet `dispute_timeout`
  7 days. `OnchainParamsSchema` (strict) gains `dispute_grace`;
  `params.disputeGraceSeconds`. New wasm sha256s live in the contracts
  repo's `wasm/SHA256SUMS` (pactora `e0ed7876…`, mock_usdc `de2a79c2…`);
  the backend keeps no copy — `demo:local` deploys the contracts repo's
  committed wasm through its `deploy.mjs`, which checks those sums.
- Keeper: `dueExit`/`deadlineOf` take the contract's `dispute_grace`
  (read from `get_params` once per sweep) — a disputed job is due only after
  `dispute_deadline + dispute_grace`, where before the keeper got
  `DeadlineNotPassed` on every sweep for the whole grace. Red
  (`apps/signer/test/keeper.test.ts`): `expected 'expire_dispute' to be
  null` at deadline + 1 with a 100 s grace; the fake-RPC sweep sent
  `expire_dispute` for a job inside the grace (4 sends, expected 3).
- `GET /v1/network` `windows.disputeGrace` (`apps/api/src/routes/meta.ts`,
  in the OpenAPI document through the schema).
- `new` is `#[private]`: the contracts repo's `deploy.mjs` already calls it
  as the contract account itself (deploy + `new` in one transaction signed
  by that account); no backend script calls `new`.
- Indexer: `dispute_expired` carries `bond_to_worker` / `bond_to_client`
  (optional in the decoder: a 1.0.0 event decodes with nulls), and the two
  `dispute_bond_settled` events an expiry now emits are both kept (distinct
  log index). Red (`apps/indexer/test`): the 1.1.0 shape decoded without
  the split; the replay of two settlements + expiry did not carry it. The
  job feed (`GET /v1/jobs/:id` `events[]`) serves `kind`, `txHash`,
  `explorerUrl`, `occurredAt` — no payload — so the only visible change for
  the interface is a second `dispute_bond_settled` entry on an expiry
  (worker's half, then the client's); the interface repo was not touched.
- Gate (all on the fixed code): `pnpm check` 1272 passed, 10 skipped (86
  files; was 1231); `test:startup` all 40 refused; `node
  scripts/check-no-secrets.mjs` clean (389 files); `pnpm demo:local` `Demo
  passed.`, 64 checks, on a fresh sandbox running the 1.1.0 wasm (deploy.mjs
  printed pactora `e0ed7876…`, mock_usdc `de2a79c2…`); the channels test
  10/10 alone; `bash deploy/vps/backup-lib.test.sh` 6 checks. Trap: setting
  `MSYS_NO_PATHCONV=1` for a whole PowerShell session breaks pnpm's shell
  shims (`C:\c\Users\…\tsc`) — set it only on the docker command that needs
  it. `pactora-docs-near/docs/STATUS.md` has the known-issue line struck
  (uncommitted there).


### 2026-11-08: the people's marketplace (M1–M10), hosting fixed

- M1–M10 backend on `master` (one commit each, `373cd25` … `516551a`):
  person sign-in sessions and registration; person job actions, listings,
  bids, multiple workers, instant mode, matching; evidence photos, draft
  rounds with review, chat; the per-agent event feed, signed webhooks,
  notifications, the test faucet; public profiles and blind two-way
  reviews; sanctions screening, identity checks, cases, soft standing gates;
  the admin console and the DAO dispute desk; Telegram and email. Then
  `c406e4a` (ops scripts, keeper recovery, the UK sanctions list) and
  `074757a` (the authorization matrix over every route and caller).
- Hosting (Vultr + Vercel): the production compose still set numeric-network
  variables (refused by every NEAR service), and the
  Dockerfile copied a `chain/export` the NEAR layout lacks (no image built).
  Both fixed (`214dec8`); all seven images build, and the stack ran
  `operational` on the sandbox in Docker. Server `.env` and steps:
  `deploy/vps/README.md`.

### 2026-11-07: re-verified on a fresh checkout (Windows 11 + Docker + WSL Ubuntu)

| Check | Result |
|---|---|
| `pactora.wasm` rebuilt from `git archive HEAD` in the pinned image (`--no-wasmopt`) | sha256 `ce9ec299…` = `wasm/SHA256SUMS` |
| `mock_usdc.wasm` rebuilt the same way (its command keeps wasm-opt) | sha256 `89ab8dbf…` = `wasm/SHA256SUMS` |
| Contract unit + property tests (WSL, `--test-threads=1`) | 55/55 |
| Contract sandbox tests (`PACTORA_WASM`/`MOCK_USDC_WASM` = the committed wasm) | 6/6 |
| `verify-near --network sandbox` | 18 checks passed; with `--dao`: 20 |
| Backend `pnpm check` (Postgres up, `pnpm db:migrate` first) | 873 passed, 10 skipped |
| `pnpm demo:local` | `Demo passed.` |
| Interface `pnpm check` | 151/151, lint and format clean |
| Interface browser tests, 5 browsers, `--workers=2` | 443 passed, 2 skipped |
| Interface production build against the held demo API | all 21 static pages 200, 28 pages crawled, no broken internal link; `/v1/status` all components up |
| Docs `pnpm check:env` | was broken (named stale repo paths); fixed, and docs/08 gained the 10 NEAR variables it was missing |


Environment traps seen: on a fresh database the API tests fail with
`relation "agents" does not exist` until `pnpm db:migrate`; browser tests on
a laptop time out at 4 workers in Firefox/WebKit, pass at `--workers=2` (as CI);
a first `demo:local` that ran while other heavy jobs ran failed at agent
registration with `fetch failed` and passed alone. Contract tests cannot build
on Windows (`near-workspaces`) nor in the cargo-near image (no OpenSSL
headers): run them in WSL. An empty `.env` (gitignored) is in place in
`pactora-contracts-near` for step 1.

### 2026-11-04 to 2026-11-06: the NEAR foundation

- 2026-11-04: baseline imported (`f1b3fae`, tag `pre-hackathon`): the
  escrow-and-reputation design and a first version of the services, from
  before the hackathon window.
- 2026-11-05: the foundation (`20342b0`): CAIP-2 network keys, NEAR config,
  db 0011–0013, `@pactora/near` (RPC, function calls, NEP-413, sha256);
  the indexer reads final NEAR blocks and decodes Pactora's NEP-297 and the
  token's NEP-141 transfers; the signer holds function-call keys (or AWS
  KMS ed25519 keys) and signs only the allowed Pactora methods; the API,
  SDK, agent runtime and MCP server on NEAR.
- 2026-11-06: the demo end to end on NEAR (`e7e8603`), the counterparty
  check enforced at hire with the attack in the demo (`8fd8913`), unused
  scripts removed (`919f719`), and `pnpm demo:local`: the
  whole system from nothing in one command (`2904f85`).
