# Pactora — Progress

> **START HERE every session.** This file is the memory that survives a closed
> terminal. Read it top to bottom before doing anything else.
>
> **NEAR Hackathon (current work): jump to "🟢 NEAR port" below.** The
> bullets directly under this note describe the Monad/AGENTX baseline (history).

- Last updated: **2026-11-01** (Session 39 — code-level rename to Pactora; afterwards every suite and every live testnet check re-run green on the renamed code, see "Counts on `v3`" below). Before that: 2026-10-26 (Session 37, internal security audit, agentx-docs `docs/22`)
- Deadline: **2026-10-13, 11:59 PM ET** (verified)
- Target track: **4 — Trust, Identity & AI Infrastructure** ($30,000)
- Current state: **v2 live on Monad testnet, end to end, re-verified.** The
  escrow now refuses self-hires (`SameOwner`) and dust jobs, never traps a
  payout, and a `DISPUTED` job can no longer hang forever — all proven on
  chain, including a real dispute expired by the keeper after its 1 h
  timeout. Backend and interface have lint, formatting, coverage floors, CI,
  containers, metrics, graceful shutdown and a browser smoke test.
- Overall (v2 on `master`, as submitted): **862 tests green** (184 contracts ·
  591 backend · 87 interface) + 72 browser tests in 5 browsers (360 runs).
  **v3 on the local `v3` branches (re-measured 2026-11-02): 1,310 tests green**
  (414 contracts · 773 backend · 123 interface; the 6-test fork suite skips
  without `FORK_RPC_10143`) + 443 browser runs across 5 browsers (+2 skipped)
  — not pushed

## 🟢 NEAR port — current state (2026-11-06)

NEAR Hackathon, deadline **2026-11-14 23:59 UTC**. Plan and status:
`pactora-docs-near/docs/24` §1.5 and §5. Wire contract: `docs/NEAR-PORT.md`.
Everything below `---` is the Monad/EVM history (baseline, tag `pre-hackathon`).

**Cold start (local, no keys):**

```bash
# Docker Desktop running; contracts repo cloned beside this one
pnpm install && pnpm demo:local      # → "Demo passed." (Postgres :5443, NEAR sandbox :3030)
DEMO_HOLD=1 pnpm demo:local          # then the interface: NEXT_PUBLIC_API_URL=http://127.0.0.1:8098 pnpm dev
pnpm check                           # 873 tests — NOT while a held demo uses the DB (tests TRUNCATE)
```

Contracts live checks (in `../pactora-contracts-near`, sandbox up):
`SANDBOX_KEY_FILE=../pactora-backend-near/.sandbox/validator_key.json node scripts/verify-near.mjs --network sandbox`
(18 checks; with `--dao` and `SPUTNIK_DAO_WASM` from `create-dao.mjs --fetch-wasm`, 20).

**Branches:** backend work is on `master` (fast-forwarded from `near-port`);
contracts, interface, docs on `master`. All four repos are pushed to GitHub
(private until submission, 2026-11-07).

**Next, in order:**
1. Owner: funded testnet account in `pactora-contracts-near/.env`
   (`DEPLOYER_ACCOUNT_ID`, `DEPLOYER_SECRET_KEY`).
2. `node --env-file=.env scripts/create-dao.mjs --network testnet` → `deploy.mjs
   --network testnet` → `verify-near.mjs --network testnet` → copy facts here
   (`node scripts/sync-chain-facts.mjs`) → `DEMO_NETWORK=testnet pnpm demo`.
3. NEAR AI Cloud judge (needs the owner's key). Optional: Intents dry quote.
4. Tag `hackathon-submission` in all four repos, push (owner's go), video, X
   post, form.

**Traps found:** only the cargo-near wasm is valid (plain cargo build traps
refusals as `unreachable`) — build in the pinned image, see the contracts
README; near-api-js `retries` = attempts; the pinned image's wasm-opt
segfaults on pactora (`--no-wasmopt`).

---

## 🏷 Rebrand: AGENTX → Pactora (decided 2026-10-30)

Name **Pactora** (pact + agora), tagline "where AI agents make deals they
can't break", domain **pactoragents.com**. The whole order of what is left —
owner steps, rebrand, merge after 2026-11-03, mainnet — is
[agentx-docs docs/23](https://github.com/gopaltalaviya/agentx-docs/blob/master/docs/23-launch-and-rebrand-plan.md).
Every name a person reads was rebranded first (Session 38). On 2026-11-01
(Session 39) the code-level names followed: `@agentx/*` → `@pactora/*`,
`AGENTX_*` → `PACTORA_*` (a service that still sees an `AGENTX_*` variable
refuses to start and names the replacement), `AgentxClient`/`AgentxError`/
`AgentxConfig` → `Pactora*`. Still `agentx`, by rule: on-chain tags, the
ERC-7201 slot, x402 scheme ids, DB/docker/volume names, `ax_`, repo and
folder names (those wait for docs/23 §3b). Local `v3` branches only; v2 stays
frozen.

## 🧪 v3 — in progress on local `v3` branches (started 2026-10-25)

**v2 is frozen** — judges use it (TaskEscrow `0x4feE…370D`, the VPS and
Vercel) until Monad Metropolis winners on **2026-11-03**. v3 lives on a local
`v3` branch in all four repos; **nothing is pushed**. Plan:
the owner's local plan file. Owner decisions (2026-10-25):
testnet-only launch readiness plus a mainnet checklist; local Ollama and cached
models only; worker bond = % of job; dispute timeout pays the worker and
returns the client's bond; arbiter = 2-of-3 Safe over DEPLOYER/AGENT_A/AGENT_B
(testnet); strict rolling 24 h cap.

Phase 1 (contracts) — done, every change red-first, then green:

| Step | What | Evidence |
|---|---|---|
| 1.1 | `maxJobAmount` per-job ceiling | V3MaxJob |
| 1.2 | **Bug fixed:** a caller could starve `giveFeedback` inside `try` and settle without the review (worker could erase its own FAILED). Proven on old code against a registry costing what the canonical one does (278,485 gas measured); never reproduced on our mock | V3FeedbackGas, fork test |
| 1.3 | Refuse workers that made the escrow their ERC-8004 operator; escrow keeps its own `recordOf` | V3OperatorGuard, I10 |
| 1.4 | Per-job worker bond locked on accept, seized to the client if undelivered (`StakeVault` lock/release/seize) | V3StakeLocks, V3JobBonds, I11 |
| 1.5 | Client dispute bond | V3DisputeBond, I12 |
| 1.6 | Clients rated from a separate `ClientReputationWriter` | V3ClientReputation |
| 1.7 | Arbiter → 2-of-3 Safe (`script/ArbiterSafe.s.sol`); Safe 1.4.1 verified on 10143 | fork test |
| 1.8 | **Rolling** daily cap (2× across the old boundary proven on old code) | AgentAccount.t.sol, invariant |
| 1.9 | Backend follows: `nextReleaseAt`, dispute spend = bond, indexer bond events | 595 backend tests |
| 1.10 | `AgentAccount` ERC-1271, so it can be a **canonical** ERC-8004 wallet | fork test on real registry |

Facts found on the way: the **canonical ERC-8004 registries are now on Monad
testnet** (identity `0x8004A818…`, same implementation as mainnet's pinned
`0x7274…`; reputation `0x8004B663…` v2.0.0) — docs/09 §8 said they were not.
Their `register()` makes the owner the wallet and ids start at 0;
`setAgentWallet` needs the wallet's signature (ERC-1271 for contracts).

Counts on `v3`: **278 contracts** (+1 fork suite, skipped unless
`FORK_RPC_10143` is set) · **648 backend** · 87 interface · 72 Playwright.
Settlements now reserve two review budgets (~1.1 M gas ≈ 0.11 MON at 102 gwei
on testnet), about 3–4× v2; `feedbackGas` (500 k) is tunable by `setParams`.

**v3 is live on Monad testnet (2026-10-25), beside v2.** `deployments/10143.json`
on `v3` now records v3 (TaskEscrow `0xff74c4de…`, StakeVault `0x08ac20d6…`,
ClientReputationWriter `0xae0bd967…`, AgentAccountFactory `0xfb07cdec…`,
MockUSDC `0xb743f689…`, startBlock 73978102) on the **canonical** ERC-8004
registries; v2's record is in `deployments/history/`. Arbiter: Safe
`0xEaB8aB0E8A7f5b95510EDd84ECFCC0EB14678e8e` (2-of-3, verified on chain; the
deployer no longer holds ARBITER_ROLE). `node scripts/verify-v3.mjs` (backend,
with `.env` loaded) passed all 24 live checks; gas on Monad: approve 1.02 M,
expireUndelivered 0.74 M, Safe ruling 1.04 M. Deploy cost ≈2.7 MON from
DEPLOYER. *Superseded 2026-10-26 by the redeploy with `PAUSER_ROLE`
(TaskEscrow `0xbd0bb7f5…`, see "v3 launch readiness — Session 36"); this
record is in `deployments/history/10143-2026-10-25-96233f7.json`.*

Phase 2 (anti-Sybil) — done: `token_transfers` funding graph from the payment
token's own Transfer logs (indexer, same chunks); `readTrust`/`verdictOf` in
`@agentx/db` (self-funded / new / failing / concentrated / trusted, with
numbers); `GET /v1/agents/:id/trust`, SDK `trust()`, MCP `check_trust` (nine
tools now); the orchestrator drops self-funded and failing agents from the pool
before the model chooses (never in a prompt — replays still match). Live:
`node scripts/verify-funding-graph.mjs <block> --truncates-the-dev-db` → 18/18
transfers match the chain. **620 backend tests.** Still to prove end to end:
a farmed worker flagged through API-created jobs — **done 2026-10-25**, see `verify-farm.mjs` below.

**v3 demo passed end to end** (2026-10-25, testnet, canonical registries, local
Ollama, `AGENT_MODE=live`): 4 agents on the canonical registry, 2 steps
settled, every refusal held. The scripts register via `registerAgent(...,
{canonical, walletSigner})` (ERC-1271 for AgentAccount wallets).

Phase 5 (backend hardening) — done: key rotate/revoke + owner re-issue by a
signed single-use challenge (`key_challenges`, 0007); signer gas watch →
`/v1/status.gas` + `signer_wallet_balance` (verified to the wei vs `cast`);
discovery lists only chain-confirmed agents; SSE ids + `Last-Event-ID` resume;
cursor pagination on jobs/runs; opt-in shared rate limit
(`RATE_LIMIT_STORE=postgres`, `rate_limits`, 0008); `scripts/reindex.mjs`.
Later on 2026-10-25, also done: OpenAPI (`GET /v1/openapi.json`, generated
from the handlers' zod schemas — no refactor needed); live SSE across
processes (Postgres LISTEN/NOTIFY, 0009 — indexer events now arrive live);
the dispute reason's hash on chain. Left, with reasons:
alerting, error tracking, staging, retention, release tags (owner decisions,
🧑‍💻 in docs/17). **648 backend tests.** Trap: `pnpm -s lint | tail -1` prints a
blank line even on errors — check the exit code (the pre-commit hook does).

Phase 3–4 (standards, accounts) — done where the facts allowed, 2026-10-25.
Everything below is live on testnet beside the v3 escrow; `docs/19-v3.md` in
agentx-docs is the one-page account, `docs/20-mainnet-checklist.md` the launch
list.

| What | Live proof |
|---|---|
| **x402 `agentx-escrow`** — refundable scheme: settle = `createJob`; worker works first, then accepts + submits; on failure declines → SDK cancels for a full refund (`refunded` = broadcast, `refundTx` to wait on) | demo `DEMO_X402=1`: both endings, balance read after the cancel is mined |
| **`SettlementValidator`** `0x50dfc9d6…0309` — answers the ERC-8004 Validation Registry (deployed on Monad, upstream 2.0.0, all 8 selectors matched, impl pinned) from escrow state only: 100 settled-undisputed, 0 dispute upheld, refuse the rest | `scripts/verify-validation.mjs` (twice) |
| **Anti-Sybil, end to end** — a worker whose owner funds three sock-puppet clients that hire it through the API, beside an honest worker with the same shape | `scripts/verify-farm.mjs --truncates-the-dev-db`: farmed → `self-funded` (3/3), honest → `trusted`, trust score 50 vs 53 |
| **`AgentDelegate`** `0x2b4c0b05…e63f` — EIP-7702: an EOA keeps its funds and gets AgentAccount's caps for its agent; core refactor `AgentAccountCore` (ERC-7201 namespace, AgentAccount ABI byte-identical); factory redeployed `0x12933799…b085` | `scripts/spike-7702.mjs`, `verify-delegate.mjs`, `verify-v3.mjs` re-run, demo `DEMO_ORCHESTRATOR=delegate` |

Found only by running live, each fixed red-first:
- SDK cancelled before the indexer saw the job → waits out `INVALID_STATE` (bounded).
- Demo read the refund balance before the refund's block → waits on `refundTx`.
- **A delegated EOA could not register on the canonical identity registry**:
  `_safeMint` → `ERC721InvalidReceiver` (it has code now). AgentDelegate gained
  ERC-721/1155 receiver hooks; first delegate `0xf45a6c47…` replaced.
- Demo's orchestrator hot key ran dry at 0.5 MON under v3 gas → `hotGas` 1.5 MON.
- Demo's SameOwner probe gave its puppet the orchestrator's own wallet in
  delegate mode → `SelfDealing` (correct, wrong test) → the puppet gets its own.
- Mutation testing found two untested guards (wildcard self-target in
  `execute` — critical for a delegate, whose owner IS `address(this)`; the
  reentrancy lock). Both tested now, for both wallets.

Monad gotcha, measured: sending from a wallet in the blocks right after it
was funded fails ("Signer had insufficient balance") 2 of 4 times; waiting 3
blocks, 0 of 4. Scripts that fund fresh keys wait. ERC-4337 EntryPoint v0.6/
v0.7 on testnet are byte-identical to Ethereum's; v0.8 differs.

2026-10-26: the interface's `/docs/api` table had drifted from docs/15
(no `decline`, no `metrics`, `/health`+`/ready` merged, out of order); a new
test (`lib/api-routes.test.ts`, red on the old table) now holds it to the
docs/15 index; interface CI fetches that one file.

**Decisions taken 2026-10-26** (the owner asked Claude to pick the standard
option): Circle USDC `0x754704Bc…fb603` on 143; mainnet bond floors 1 USDC;
`feedbackGas` 500 k kept (measured ≤ 296 k on 143); 10% dispute bond
confirmed; ERC-8183 waits for Final; ERC-4337 deferred; a pause-only role
built. 0.1 testnet MON was stranded by two failed spike runs (keys in
memory); the scripts now sweep in `finally`.

### v3 launch readiness — Session 36, 2026-10-26

Goal from the owner: v3 ready for the owner to launch — every repo-side item
of docs/20 done, mainnet a sequence of owner-run commands (agentx-docs
`docs/21-launch-runbook.md`), and the hosted testnet stack ready to switch to
v3 after judging. Nothing sent to mainnet; everything committed on local `v3`,
not pushed. Account: docs/19 §9.

- **Contracts**: `PAUSER_ROLE` (pause only; unpause stays admin);
  `Deploy.s.sol` refuses, off testnet, an unset or code-less arbiter, fee,
  slash or pauser; `script/Handover.s.sol` + `make handover` /
  `handover-accept`; `scripts/check-launch.mjs` (read-only launch check);
  drift checker covers all 16 params; 143 config: Circle USDC, 1 USDC bond
  floors, `maxLogRange` 100 measured. **Bug found by the mainnet fork dry
  run**: `foundry.toml`'s `[etherscan] chain = 143` made every `forge script`
  on 143 fail — `make deploy-mainnet` would have failed. Fixed.
- **Testnet redeploy 2026-10-26**: TaskEscrow `0xbd0bb7f5…1b64`, StakeVault
  `0x71939696…da98`, startBlock 74325130; admin, arbiter, pauser, fee, slash =
  Safe `0xEaB8…8e8e`. Hand-over done live: `check-launch.mjs` 11 ✗ before, all
  ✓ after. `verify-v3`, `verify-validation`, `verify-delegate`, the new
  `verify-pause` and the full demo (`DEMO_X402=1`, live Ollama: 3/3 settled,
  every x402 ending, every refusal) all passed on it.
- **Backend**: AWS KMS key source (`apps/signer/src/kms.ts`,
  `keysource.ts`; keeper and renewer too) — live `verify-kms.mjs`; a shared
  keystore refused off testnet; config refuses a mainnet with no token;
  zod 3 → 4.6.7 (the advisory was real for us: 167 MB heap from one 2 MB
  body on zod 3); body-parser ≥ 2.4.0; `pnpm audit` high clean.
- **Interface**: Next 15.5.28 (audit clean; the live v2 site was not exposed
  — no Server Actions, sharp already 0.35.5); `/docs/api` held to docs/15 by a
  test; reporting route on `/docs/security` + SECURITY.md.
- **Hosted switch rehearsed** (`deploy/vps/switch-to-v3.sh`, README
  "Switching to v3", docs/16 R13): production images, VPS layout, fresh DB,
  seed on the canonical registry, a live run from the site settled 2/2. The
  seed now prints `env.compose` (hand-mapping worker keys went wrong once).
  Rehearsal keys reclaimed (10.46 MON to FUNDER). Locally left behind: docker
  volume `agentx-v2-pg-archive` and images tagged `agentx-full-*:v2` from the
  rehearsal — harmless, delete when convenient.

### Internal security audit — Session 37, 2026-10-26

The owner asked to run everything, complete everything and audit it. Three
independent reviewers (escrow; accounts, vault and deploy; backend), every
finding checked against the code and fixed test-first or accepted in writing
— agentx-docs `docs/22-security-audit.md` is the record. 4 High, 5 Medium,
all fixed.

- **Contracts** (`cb14474`): F1 — the hosted renewer held the accounts' OWNER
  key and every re-grant refilled a stolen key's budget → `setSessionManager`
  / `extendSessionKey` (keeps `spent`); M-1 — operator approval toggled on
  just for bad reviews dropped them → kept reviews, `retryFeedback`,
  `ReviewUnwritten` blocks hiring; F2 — a role or locker planted in the
  hand-over window was invisible → enumerable roles, `lockerCount`,
  `removeLocker`, `check-launch.mjs` asserts the exact holder sets; F4, I-1,
  I-3, I-4, `claimOwed` forbidden through `execute`.
- **Testnet redeployed** (`4dc8c38`): TaskEscrow `0x14b93e92…7dc6`, StakeVault
  `0x4c531925…3206`, startBlock 74376426; every role the Safe. The hand-over
  was rehearsed with a planted locker: check-launch red on exactly that line,
  the Safe removed it, green.
- **Backend** (`bf4a17b`): H1 idempotency keys per agent and payload; H2 no
  unpaid rows offered to workers; H3 wallets classified by code
  (`apps/signer/src/accounts.ts`); M1 registration signed by the owner
  (`POST /v1/agents/challenge`); M2 RPC chain id checked; M3 EOA agents sign
  escrow calls only; L2–L4; TRUST_PROXY hop count. The renewer is now the
  accounts' **session manager** — `SESSION_MANAGER_*` (old `SESSION_OWNER_*`
  still read, with a warning); the hosted seed keeps the owner key in the
  seed file. The keeper writes refused reviews. Migrations 0009, 0010.
- **Interface** (`2f9b38d`, `5913c84`): the register page signs the API's
  challenge; vitest 3.2.7, happy-dom 21 (dev-only advisories).
- **Live**: new `scripts/verify-audit.mjs` (M-1 and F1 on the canonical
  registries) passed; `verify-v3`, `-validation`, `-delegate`, `-kms`,
  `-pause`, the demo (Ollama, `DEMO_X402=1`, 3/3) and `verify-farm` all
  passed on the redeploy.
- **Accepted, owner may revisit** (docs/22): F3 bond self-seizure (Medium if
  a slasher is ever appointed); L-1 mainnet `minFee` makes a manufactured
  review cheap; L-2 unsolicited `directPay` reviews; L1 public job reads.

**Left — all the owner's** (docs/21): external audit (give the auditors docs/22) · mainnet Safes with
hardware signers · AWS KMS keys · fund the deployer (~3.3 MON + margin) ·
the mainnet deploy, hand-over and every mainnet transaction · switch on
GitHub private vulnerability reporting · `EXPLORER_API_KEY` · after
2026-11-03: merge and push `v3`, run the hosted switch, destroy the old VPS.

Counts on `v3` (re-run 2026-11-01 after the Session 39 rename): **414 contracts** (+6 fork) · **771 backend** · **99 interface** · **378 Playwright (+2 skipped) across Chromium, Firefox, WebKit, iPhone, Android** (`E2E_ALL_BROWSERS=1`; build the site with `NEXT_PUBLIC_API_URL=http://127.0.0.1:8787` first — a stale build pointing elsewhere fails ~93 tests).
**2026-11-02:** screenshots and guide videos re-recorded with the final Pactora + Keystone Arch brand (8 PNGs in `agentx-interface/docs/screenshots/`, 6 guides in `public/guides/`; a held `DEMO_HOLD=ui AGENT_MODE=cached` demo on fresh testnet agents, 4/4 settled, ~1.37 test MON). Interface after it: typecheck and lint clean, vitest 123, Playwright 89 in Chromium and 443 (+2 skipped) with `E2E_ALL_BROWSERS=1`, built against a mock API on :18787 with `E2E_PORT=13200 MOCK_API_PORT=18787`.

**Re-verified 2026-11-02 (independent audit pass):** contracts 414 passed + 1 skipped (`FOUNDRY_PROFILE=ci`) · backend 773 · interface vitest 123 · Playwright 89 in Chromium and 443 (+2 skipped) with `E2E_ALL_BROWSERS=1` · `scripts/e2e.mjs` on 10143 passed (`AGENT_MODE=cached`, ~0.17 test MON) · `check:contract` against a local API held.

Live on 10143 after the rename, same day, only `PACTORA_*` set: `verify-v3`, `verify-validation`, `verify-delegate`, `verify-kms`, `verify-pause`, `verify-audit`, the demo (`DEMO_X402=1`, `AGENT_MODE=live` on local Ollama llama3 — no API quota) and `verify-farm` (farmed 50 vs honest 53) all passed; contract gates (fmt, solhint, slither, snapshot, secrets) and backend lint, format, `pnpm audit` high clean.

Also fixed after the live runs: the indexer drops funding transfers from an orphaned block on a reorg (they could have flagged a payment self-funded); the landing page's loading skeleton had invalid ARIA (axe now scans the loading state). Not built, each with its reason: `docs/19 §8`.

Trap found: `forge coverage` had stopped compiling and the floor check read a
stale `lcov.info`; `check-coverage.mjs` now refuses a report older than the
sources.

---

## ⏭ Next actions

### 👤 You — everything left is yours, and none of it is code

1. **Repos public — done (2026-10-06).** Four repos, default branch
   `master`: contracts, backend, interface, and the new
   [`agentx-docs`](https://github.com/gopaltalaviya/agentx-docs) (specification, deck, video). contracts and
   backend were deleted and recreated empty first, so the old closed
   dependabot PRs — which still pointed at pre-rewrite commits carrying
   personal info — are gone. A full-history scan of all four for every real
   secret in `.env` and for personal info found none (Session 32).
2. **The video is made: [`docs/video/agentx-demo.mp4`](https://github.com/gopaltalaviya/agentx-docs/blob/master/docs/video/agentx-demo.mp4)** — 2:35, 1080p, a live testnet run started from the site. It lives in `agentx-docs` now. **Uploaded 2026-10-06: https://youtu.be/IQESfGqXn1M** (unlisted, channel "ZeroXAGENTX"); the link is in docs/11 §"For the submission form". To re-record: [docs/video/README.md](https://github.com/gopaltalaviya/agentx-docs/blob/master/docs/video/README.md). For your own terminal recording: `.agent-cache/` holds a
   fresh **v2** Ollama recording (Session 26; the v1 one no longer matches).
   `DEMO_X402=1 AGENT_MODE=cached` replays everything — 4 settlements, x402,
   stolen key, `SameOwner`, below-minimum — in ~232 s at the recorded pace, or
   **162 s** with `AGENT_REPLAY_MAX_MS=2000`. Screenshots:
   `agentx-interface/docs/screenshots/`.
   **To film the website itself running a live run** (verified Sep 30):
   build the site with `NEXT_PUBLIC_API_URL=http://127.0.0.1:8098`, serve it
   (e.g. `next start -p 13300`), then run the demo with `DEMO_HOLD=ui
   CORS_ORIGINS=http://127.0.0.1:13300 AGENT_MODE=cached
   AGENT_REPLAY_MAX_MS=2000`. It registers fresh agents and waits; paste the
   key from `artifacts/demo-hold.json` into `/demo` and press **Run** — the
   trace streams live and settles 4/4 in ~76 s. It must be the first run on
   those agents (a second run's prompts differ, so the cached replay misses).
3. **Testnet MON** (2026-10-12): DEPLOYER **71.7 MON**
   (~140 demo runs at ~0.5), FUNDER **3.2 MON** — low; top it up from DEPLOYER before more local demos — the keeper and the agents'
   gas top-ups run from it again. If FUNDER ever drains, the demo now says so
   before sending anything.
4. **Hosted — LIVE (2026-10-07).** Site: **https://agentx-interface-iota.vercel.app**
   (Vercel, deploys from `master`); API: `https://api.64-177-41-175.sslip.io` on one
   Vultr VPS (2 vCPU / 4 GB, $250 credit for 30 days — **destroy it after judging**
   or it bills ~$24/month). Files: `deploy/vps/`; steps: [docs/13 §5](https://github.com/gopaltalaviya/agentx-docs/blob/master/docs/13-deploy.md#5-a-single-vps-the-live-deployment).
   SSH: `root@64.177.41.175`, key-only (the key stays on the owner's machine). Hosted agents:
   orchestrator 229, workers 230–232 (`artifacts/hosted-agents.json`, gitignored;
   the judges' key is `env.orchestratorApiKeyForJudges` — submission form only).
   Railway: the unused `agentx` project was deleted on 2026-10-07 (Railway
   removes it for good on 2026-10-09).
5. **`EXPLORER_API_KEY`** in `agentx-contracts/.env` for verified source.
   Deployed source is untouched on purpose so verification still matches.
6. **Gemini — tried, as asked; not used for the video.** The key works. The
   default model `gemini-2.5-flash` had been retired (404, "no longer
   available to new users"), which is very likely why Session 23's requests
   failed too; it is now `gemini-3.8-flash`. With it, Gemini planned well but
   answered 503 "high demand" on two consecutive runs, so the recording is the
   Ollama one. Re-try any time: `BRAIN_CHAIN=gemini BRAIN_CHAIN_ORCHESTRATOR=gemini AGENT_MODE=record`.
7. **Arbiter / fee recipient** — left on DEPLOYER, as you decided (Sep 30).
8. **Operations decisions** — [docs/17 §14](https://github.com/gopaltalaviya/agentx-docs/blob/master/docs/17-production-readiness.md):
   when you deploy, enable Railway Postgres backups and point an uptime
   monitor at `/v1/status`; set `METRICS_TOKEN` if metrics will be scraped.
   The site's `/status` page reads the same endpoint.

### 🤖 Claude — nothing left that is mine to do before the deadline

Done in Session 26: contracts v2 and the hardening of all three repos.
Done in Session 29: docs search, six video guides at `/docs/guides`, the edge
/ hostile-HTTP / one-dependency-down testing and its 14 fixes — all pushed.
If asked for more, good candidates: re-record the guides after any UI change
(`scripts/video/guides.mjs`), and re-run the chaos and worst-case matrices
after any change to the signer, API or indexer. Post-hackathon only:

1. ERC-8183 conformance — a new kernel with AGENTX as evaluator + hook
   ([docs/12 §7](https://github.com/gopaltalaviya/agentx-docs/blob/master/docs/12-erc8183-mapping.md#7-what-conformance-would-look-like)).
2. Self-dealing through a *second* owner still works — v2 makes it cost a
   fee floor per review, not impossible. Sybil resistance needs identity
   attestations or stake-weighted scores.

## 🚧 Blockers

| # | Blocked | Blocked by | Since | Owner |
|---|---|---|---|---|
| B10 | Verified source on the explorer | `EXPLORER_API_KEY` empty | Sep 28 | 👤 |


Cleared: ~~B1 scaffolding~~ · ~~B2 funded wallets~~ · ~~B3 schedule~~ ·
~~B4 deploy target~~ · ~~B5 git push~~ · ~~B8 hosting~~ (VPS + Vercel, 2026-10-07) · ~~B11 repos private~~ (public 2026-10-06) · ~~B9 docs and plan unbacked~~
(moved into `agentx-backend` on Sep 25, which also fixed a README link that
was broken on GitHub) · ~~B6 no model~~ (Sep 29 — local Ollama instead of a
hosted key; the full path now runs and settles on testnet) · ~~B7 interface
never viewed~~ (Sep 29 — headless Chrome; the first render found the API sent
no CORS headers).

> **B6 cleared the way it was predicted to matter.** The first real runs of
> orchestrator → worker → judge → settle found sixteen defects on exactly
> that path, none of them caught by the tests passing at the time. The audit
> and chaos work that followed found as many again.

## 🔌 Cold start — resuming after the terminal closed

Everything a fresh session needs, assuming it knows nothing. Verified
2026-09-25; commands and counts re-checked 2026-10-01 (Session 29).

> **2026-11-01:** `master` is pushed; the `v3` branch in all four repos is
> **local only** until the owner says to push (after 2026-11-03). Commands
> below now use the renamed env vars (`PACTORA_CONTRACTS_ROOT`, …) and
> packages (`@pactora/*`); a service refuses to start if any `AGENTX_*` is set.

### ✅ Everything is backed up (resolved 2026-09-25)

| Path | In git? |
|---|---|
| `agentx-contracts/` | ✅ pushed |
| `agentx-backend/` — including `PLAN.md`, `PROGRESS.md` | ✅ pushed |
| `agentx-interface/` | ✅ pushed |
| `agentx-docs/` — the specification, deck, workbook, video (from 2026-10-06) | ✅ pushed |

Until 2026-09-25 the specification, the plan and this file lived in **no
repository** — ten documents in one folder, on one machine, named `temp`. The
code was safe on GitHub; the thinking behind it was one `rm` away. They now
live in `agentx-backend`, which also fixed a README link that was broken on
GitHub because it pointed at a `docs/` the repo did not contain.

On 2026-10-06 the owner created a fourth repository, `agentx-docs`, and the
`docs/` folder moved into it with its history (`git filter-repo --path docs/`),
at the same paths. `agentx-backend/docs/README.md` is a pointer.

### Where things are

```
<workspace>\agentx\
├── agentx-contracts\   Foundry
├── agentx-interface\   Next.js
├── agentx-docs\        the specification (docs\00..17), deck, workbook, video
└── agentx-backend\     pnpm workspace — and the project's memory
    ├── PROGRESS.md     <- this file. Start here.
    └── PLAN.md         <- ~115 tasks, owners, dependencies
```

`docs/07-what-i-need-from-you.md` is the checklist of things only you can
supply. Scratch files belong in the session scratchpad, never in the project.

### Bring everything up from cold

```bash
# 1. Infrastructure (from agentx-backend/)
docker compose up -d                       # Postgres :5442, Redis :6381
pnpm install
pnpm --filter @pactora/db migrate
pnpm -r build

# 2. Contracts
cd ../agentx-contracts && forge build

# 3. Prove it is all still green
FOUNDRY_PROFILE=ci forge test              # expect 184 passed
cd ../agentx-backend && npx tsc -b && npx vitest run   # expect 528 passed
cd ../agentx-interface && npx tsc --noEmit && npx vitest run   # expect 77 passed
# Browser tests: build against the mock API, then 63 Playwright tests (E2E_ALL_BROWSERS=1 adds Firefox, WebKit and two phones: 315).
# --workers=2: other projects' test harnesses on this machine cause timeouts at full parallelism.
NEXT_PUBLIC_API_URL=http://127.0.0.1:18787 npx next build
E2E_PORT=13200 MOCK_API_PORT=18787 npx playwright test --workers=2   # expect 63 passed
```

Expected totals as of 2026-10-12: **184 contracts + 591 backend + 87 interface = 862** (Session 35), plus 72 Playwright tests.
If a number is lower, something regressed — find out what before building on
it.

### Running the stack locally

```bash
# API (needs no key; serves the marketplace with orchestrator: false)
cd agentx-backend
DATABASE_URL=postgres://agentx:agentx@127.0.0.1:5442/agentx \
ENABLED_CHAIN_IDS=10143 DEFAULT_CHAIN_ID=10143 \
PACTORA_CONTRACTS_ROOT=../agentx-contracts \
PORT=8080 node apps/api/dist/main.js

# Interface against it
cd agentx-interface
NEXT_PUBLIC_API_URL=http://127.0.0.1:8080 pnpm dev

# Contract check (needs the API running)
NEXT_PUBLIC_API_URL=http://127.0.0.1:8080 pnpm check:contract
```

Secrets live in `agentx-contracts/.env` (exists). Every live script loads it
with `set -a; . ../agentx-contracts/.env; set +a` — there is no
`agentx-backend/.env`, and none is needed.

### The site + a held demo, for clicking through it yourself

Two terminals. In the user's own terminal they run as long as needed (a
Claude background task is killed after 2 h, and its child processes can
outlive it — `demo.mjs` now refuses to start if :7098 or :8098 is taken).

```bash
# 1 — agentx-backend: fresh agents on testnet, held open
set -a; . ../agentx-contracts/.env; set +a
unset GEMINI_API_KEY MAINNET_DEPLOYER_PRIVATE_KEY   # (unset FUNDER_PRIVATE_KEY too if FUNDER is ever empty)
VERIFY_CHAIN_ID=10143 PACTORA_CONTRACTS_ROOT=../agentx-contracts DATABASE_URL=postgres://agentx:agentx@127.0.0.1:5442/agentx BRAIN_CHAIN=ollama BRAIN_CHAIN_ORCHESTRATOR=ollama OLLAMA_MODEL=llama3:latest CORS_ORIGINS=http://localhost:3300,http://127.0.0.1:3300 DEMO_HOLD=ui AGENT_MODE=cached AGENT_REPLAY_MAX_MS=2000 node scripts/demo.mjs

# 2 — agentx-interface: the site against it
NEXT_PUBLIC_API_URL=http://127.0.0.1:8098 npx next build
NEXT_PUBLIC_API_URL=http://127.0.0.1:8098 npx next start -p 3300
```

Open http://localhost:3300, paste the key from
`agentx-backend/artifacts/demo-hold.json` into `/demo`, press Run: 4/4
settle in ~80 s. Only the FIRST run on a fresh stack matches the cached
replay; for another, restart step 1.

### Live-chain checks need the deployer key

```bash
cd agentx-backend
set -a; . ../agentx-contracts/.env; set +a      # <- without this it silently
DATABASE_URL=postgres://agentx:agentx@127.0.0.1:5442/agentx VERIFY_CHAIN_ID=10143 PACTORA_CONTRACTS_ROOT=../agentx-contracts node scripts/verify-indexer.mjs                  #    uses the Anvil account
```

Without the env loaded the script falls back to the well-known Anvil key
`0xf39F…2266`, which has no funds on Monad, and fails on the first write with
a confusing revert.

### The demo, end to end on testnet — verified 2026-09-29

```bash
cd agentx-backend
docker compose up -d && pnpm -r build           # demo imports from dist/
set -a; . ../agentx-contracts/.env; set +a
unset GEMINI_API_KEY                            # <- the contracts .env has one; see Session 23
export VERIFY_CHAIN_ID=10143 PACTORA_CONTRACTS_ROOT=../agentx-contracts \
       DATABASE_URL=postgres://agentx:agentx@127.0.0.1:5442/agentx \
       BRAIN_CHAIN=ollama BRAIN_CHAIN_ORCHESTRATOR=ollama OLLAMA_MODEL=llama3:latest

# Live, local model, no API quota spent (needs Ollama with llama3 pulled)
AGENT_MODE=record node scripts/demo.mjs

# Replay that recording — no model at all. ~162 s with AGENT_REPLAY_MAX_MS=2000.
# DEMO_X402=1 adds the x402 stage (402 → pay → serve → replay refused);
# the Sep 30 recording in .agent-cache/ was made with it on.
DEMO_X402=1 AGENT_MODE=cached node scripts/demo.mjs

# Chaos: a broken fourth worker. Both pass live.
AGENT_MODE=live DEMO_CHAOS=no-accept node scripts/demo.mjs
AGENT_MODE=live DEMO_CHAOS=mid-job   node scripts/demo.mjs
#   mid-job prints a chain job id held in escrow ~35 min; after that:
node scripts/keeper-sweep.mjs <chainJobId>

# Full stack e2e, asserted on balances and reputation
node scripts/e2e.mjs
```

**`BRAIN_CHAIN` only covers workers.** The orchestrator and judge read
`BRAIN_CHAIN_ORCHESTRATOR`; unset, they try Claude → Gemini → Groq → Ollama
and will use any key in the environment. That is how the Gemini requests in
Session 23 happened.

Each run spends a little testnet MON and registers fresh agents. The demo's
signer runs the keeper on the FUNDER key; do not run `keeper-sweep.mjs` with
the same key while a demo is running (nonce race) — unset `FUNDER_PRIVATE_KEY`
for the demo in that case. The recording lives in `.agent-cache/`
(gitignored). **Any change to a prompt or a schema invalidates it** —
re-record before relying on `cached`. The test suites TRUNCATE the same
database: never run them while a demo or a UI check is using it.

**Since Session 26:** `pnpm db:migrate` needs `DATABASE_URL` set (no silent
default); a production API needs `CORS_ORIGINS`; the interface's production
build needs `NEXT_PUBLIC_API_URL`. `AGENT_REPLAY_MAX_MS=2000` shortens a
cached replay without re-recording. The recording in `.agent-cache/` is the
v2 one — any prompt or schema change still invalidates it.

### Environment gotchas — each of these cost real time

| Trap | What to do |
|---|---|
| Bash heredocs break on backticks and quotes | Use the Write tool for any file with them. This has bitten repeatedly. |
| `localhost` resolves to `::1` on Node 24 while Docker binds IPv4 | Always `127.0.0.1` in connection strings. |
| Ports 5432 / 6379 are taken by other projects on this machine | We use **5442** and **6381**. A native Postgres on 5432 silently shadowed the container once. |
| Node's `fetch` aborts the process at exit on Windows (0xC0000409) | Scripts whose exit code matters use `node:http`. |
| Python printing unicode to this shell throws `cp1252` errors | Write files with `encoding="utf-8"`; do not `print()` the content. |
| SSH picks the wrong key from the global config | Each repo pins `core.sshCommand` to the owner's GitHub key (a per-repo setting, not committed). |
| Monad's RPC rejects `eth_getLogs` over 100 blocks | `maxLogRange` per network in config — never hardcode a span. |
| `forge test` needs `via_ir` | Already set; ERC-8004's 11-arg event overflows the stack without it. |
| `EADDRINUSE 127.0.0.1:5442` in a test, once in ~15 full runs | **Not our code.** Windows ran out of ephemeral ports: an unrelated process on this machine held ~1,800 sockets and churned ~7,000 into TIME_WAIT (Sep 30). This is almost certainly the old "`meta.test.ts` flake" — its first query is the first connection a file opens. Re-run; if it recurs, check `Get-NetTCPConnection -State TimeWait`. |
| `cp "$TEMP"/…/*` copies nothing in Git Bash | `$TEMP` is a Windows path; globs do not expand through backslashes. Use `$(cygpath -u "$TEMP")`. |
| A demo run drains DEPLOYER | ~0.5 MON a run since worker accounts. Check balances before recording; top up from FUNDER. |
| FUNDER drained → "transaction 0x… reverted" | Fixed to a clear preflight message. If it happens: `unset FUNDER_PRIVATE_KEY` so the deployer pays, or top FUNDER up (it was, Oct 5). |
| Claude background tasks die at 2 h, children survive | A stopped demo left its signer on :7098; the next demo's hires all failed 401. `demo.mjs` now refuses taken ports. Kill leftovers by process tree (`taskkill //PID <pid> //F //T`), checking the command line first. |
| `:4010` / `:3100` / `:8787` belong to another project on this machine | Its API is also `apps/api/dist/main.js` — check the parent command line before killing anything. |
| Playwright timeouts / "Failed to find context" across many tests | Contention from other projects' harnesses, not our code. `--workers=2`. One test passing alone confirms it. |
| Two `next start` on one `.next` | Rebuilding `.next` under a running server gave `ChunkLoadError`s. Stop every `next start` of this repo before `next build`. |
| `docker compose -f docker-compose.full.yml up --build` → BuildKit `EOF` | Four parallel image builds crashed Docker Desktop's builder (once taking the dev Postgres down, exit 255). `COMPOSE_PARALLEL_LIMIT=1`. Restart `agentx-backend-postgres-1` if it is down. |
| Backend tests TRUNCATE the dev database | Never run `pnpm test` (or one API test file) while a demo is holding — it wipes the demo's agents and keys. |

### Standing rules — do not re-derive these

- **Testnet only.** Any mainnet action needs explicit per-action confirmation.
- **Never create a git repository or a remote.** The four that exist were
  created by the user. The production branch is `master` in all four.
- **Private keys never leave `.env`.** Never in chat, never in `.env.example`
  (which is tracked), never in a log.
- **`AGENT_MODE=cached` by default.** Ask before any run that spends the
  user's API quota.
- **A mock that agrees with your assumptions proves nothing.** Every
  milestone gets a live-chain check.
- **Run a new test against the old code first.** If it passes either way it
  proves nothing — this caught four defects that unit tests had missed.

### In-flight work right now

**None in progress.** Session 32 (2026-10-06) is committed and pushed in all
four repos; push again only when the owner says so. No process is left running; the
hosted rehearsal stack was removed and its keys retired (`--reclaim` returned
6.38 MON to FUNDER; the file is `artifacts/hosted-agents.rehearsal-2026-10-05.json`,
gitignored). The Railway deploy waits on the owner's plan (Next actions 4).
The dev Postgres container `agentx-backend-postgres-1` is up. There is no
half-finished edit, no stashed change, no branch to reconcile. A fresh session can start from the Next actions list at the top of
this file.

---

## 📋 Facts & Config

**Fill these in as they arrive.** Everything downstream reads from here, and
this is the first thing a fresh session needs.

### Repos

| Repo | URL | Status |
|---|---|---|
| `agentx-contracts` | `git@github.com:gopaltalaviya/agentx-contracts.git` | ✅ public, `master` |
| `agentx-backend` | `git@github.com:gopaltalaviya/agentx-backend.git` | ✅ public, `master` |
| `agentx-interface` | `git@github.com:gopaltalaviya/agentx-interface.git` | ✅ public, `master` |
| `agentx-docs` | `git@github.com:gopaltalaviya/agentx-docs.git` | ✅ public, `master` (created 2026-10-06) |
| GitHub owner | `gopaltalaviya` | ✅ |
| Commit author name | `gopaltalaviya` | ✅ |
| Commit author email | the owner's GitHub email | ✅ |

> **Third repo is `agentx-interface`, not `agentx-web`.** All docs renamed
> 2026-09-22 to match. Access is SSH (`git@github.com:…`), so pushes need an
> SSH key loaded on this machine.

**Git dependency form** (D1 — no registry needed):

```jsonc
"@agentx/contracts": "github:gopaltalaviya/agentx-contracts#v0.1.0"
```

> ⚠️ **Claude does not run `git init` or `git remote add`** — the global
> instruction in `~/.claude/CLAUDE.md` forbids creating repositories and
> remotes. You run those three commands once per repo; Claude commits and
> pushes normally afterwards.

### Monad — verified 2026-09-22 by web lookup

> ⚠️ **Still confirm these yourself against docs.monad.xyz before deploying.**
> Verified from the official docs and Chainlist, but a chain config is the one
> thing worth double-checking with your own eyes.

**Testnet** (chain ID **10143**)

| Key | Value | Status |
|---|---|---|
| Chain ID | `10143` | ✅ |
| RPC URL | `https://testnet-rpc.monad.xyz` | ✅ |
| Explorer | `https://testnet.monadexplorer.com` (also `testnet.monadscan.com`) | ✅ |
| Faucet | `https://faucet.monad.xyz` | ✅ |
| Native currency | `MON` | ✅ |
| Faucet daily limit | not needed — MON was sent by the owner | — |
| Verification: API key needed? | yes — `EXPLORER_API_KEY` in `agentx-contracts/.env` ([07 §A1](https://github.com/gopaltalaviya/agentx-docs/blob/master/docs/07-what-i-need-from-you.md#a1-explorer-api-key--for-verified-contract-source)) | ⬜ key not set yet |
| Canonical USDC on testnet | none used — our `MockUSDC` (deployed) | ✅ |

**Mainnet** (chain ID **143**) — live, `v0.15.2 / MONAD_NINE`

| Key | Value |
|---|---|
| Chain ID | `143` |
| RPC URLs | `rpc.monad.xyz`, `rpc1`–`rpc3.monad.xyz`, `rpc-mainnet.monadinfra.com` |
| Explorers | `https://monadvision.com`, `https://monadscan.com` |
| Wrapped MON | `0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A` |

### ✅ RESOLVED: testnet first, both networks supported

**Decided 2026-09-22.** Ship and demo on **testnet (10143)**. **Mainnet (143)
is supported by the same code from day one** — the network is configuration,
never a code path.

What that buys, beyond covering the "MonadChain (ID: 143)" ambiguity on the
hackathon site: if mainnet turns out to be required, or you simply want to
show a mainnet transaction in the video, it is `make deploy-mainnet` plus one
env var. Not a migration.

Design: [08 — Configuration Architecture](https://github.com/gopaltalaviya/agentx-docs/blob/master/docs/08-configuration.md).

Still worth asking the organisers whether mainnet is required — but it is no
longer a blocker, only a deploy target.

### Wallets — addresses only, never keys

| Role | Address | MON (checked 2026-10-05) |
|---|---|---|
| `DEPLOYER` | `0xd5b812EFb94124E737c3520739d04539a8441137` | **40.68** ✅ |
| `FUNDER` | `0x5c03DB6fb41c0F42777dDE051d07EAb9F54fCc54` | **15.01** ✅ (topped up Oct 5) |
| `AGENT_A` | `0xfB95885d3A72A82836f3fCAC720Bf80A4155F6c2` | 29.00 |
| `AGENT_B` | `0x2Ff72eE6B8de27dD8F2D9FbFf7102EfbaD8D37D6` | 18.91 |

> **The faucet cannot be automated.** `faucet.monad.xyz` runs a bot-detection
> check and gates larger drips behind X/Discord linking. Claude does not
> complete bot-detection challenges. It is also unnecessary: 1 MON is ample for
> testnet, so DEPLOYER distributes to the other three with `cast send`.

### Deployed contracts

> Do not maintain this table by hand. It is a **copy for reading**; the real
> source is `deployments/<chainId>.json`, generated by the deploy script
> ([08 §4](https://github.com/gopaltalaviya/agentx-docs/blob/master/docs/08-configuration.md#4-deployments--deploymentschainidjson)).

**ERC-8004 registries — verified on-chain 2026-09-22**

| Registry | Mainnet 143 | Testnet 10143 |
|---|---|---|
| Identity | ✅ `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` — ERC-721 `AgentIdentity` / `AGENT` | ❌ **not deployed** |
| Reputation | ✅ `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` | ❌ **not deployed** |
| Validation | *coming soon* | — |

Both mainnet registries are **ERC-1967 upgradeable proxies**; Identity
implementation is `0x7274e874ca62410a93bd8bf61c69d8045e399c02` — pin it and
CI-check it has not moved (M1-00d).

> **Because they are absent on testnet, we deploy the open-source reference
> implementation there ourselves** (M1-00c). Config handles it: the `erc8004`
> block in `deployments/<chainId>.json` is per-chain, so testnet points at our
> deployment and mainnet at the canonical one, with identical code.
> Rationale: [09 §8](https://github.com/gopaltalaviya/agentx-docs/blob/master/docs/09-landscape.md#8-m1-00-verification--results-2026-09-22-on-chain)

**Ours (deployed):**

| Contract | Testnet 10143 ✅ LIVE — **v2**, 2026-09-30 | Mainnet 143 |
|---|---|---|
| `TaskEscrow` | `0x4feED0338761817417Fd1dDdFC8331D16AEB370D` | ⬜ not deployed |
| `StakeVault` | `0x9E4Da70C473cCA89cbA871A89B4c604B278BF0c7` | ⬜ |
| `AgentAccountFactory` | `0xcCa4464071B71beE85D8390073492048721849ca` | ⬜ |
| `MockIdentityRegistry` | `0xeD34Ffc39Ee69c780586b85d930368Bc29B30ef1` | canonical `0x8004A1…` |
| `MockReputationRegistry` | `0xCdB4be378D4B276184923E7ad8C11007fd0247bd` | canonical `0x8004BA…` |
| Payment token (MockUSDC) | `0x35Ca89EA58b292BF8D66eFEC2c086501a3802980` | ⬜ canonical USDC |
| `startBlock` | 66905096 | — |

> **v1 → v2 (Session 26).** Everything was redeployed, registries included,
> so **reputation history split**: every v2 score starts from settlements on
> the v2 escrow. v1 (`TaskEscrow 0x1b0959…027c`, start block 65027889) stays
> on chain, unused.

> `AgentAccountFactory` was **redeployed 2026-09-24** (was
> `0x580f093c…`) to pick up `AgentAccount.MAX_SESSION_KEY_TTL`. It is
> standalone — `TaskEscrow` and `StakeVault` do not reference it, so nothing
> else moved. No `AgentAccount` instances exist yet: the signer uses an EOA
> under its own policy checks.

> Addresses are **generated** into `deployments/10143.json`; this table is a
> copy for reading. The escrow was redeployed twice during the adversarial
> pass, so trust the file, not a number pasted anywhere.

~~`AgentRegistry`~~ ~~`ReputationRegistry`~~ — **not built**; ERC-8004's are
used instead ([09](https://github.com/gopaltalaviya/agentx-docs/blob/master/docs/09-landscape.md)). Fallback specs retained in
[04 §2.1 / §2.3](https://github.com/gopaltalaviya/agentx-docs/blob/master/docs/04-how-it-works.md).

### Services

| Service | URL | Status |
|---|---|---|
| Railway project | `_______` | ⬜ not created |
| API | `_______` | ⬜ runs locally on :8080 |
| MCP endpoint | stdio (`apps/mcp`) | ✅ built — stdio, not hosted |
| Vercel web | `_______` | ⬜ not created |
| Local Postgres | `127.0.0.1:5442` | ✅ docker, migrated |
| Local Redis | `127.0.0.1:6381` | ✅ docker |

> Ports are deliberate: 5432 and 6379 were already taken on this machine by
> other projects, and a native Postgres on 5432 silently shadowed the
> container once already. `127.0.0.1` rather than `localhost`, because Node 24
> resolves `localhost` to `::1` while Docker binds IPv4.

---

## 📦 Complete status — 2026-09-30

Everything built and everything outstanding, by area. `✅` done and verified
live · `👤` needs you. Rewritten on Sep 30; the Sep 25 version had gone stale
(it still called the interface "never viewed").

### 1. Development

#### Contracts — `agentx-contracts` · ✅ v2, deployed Sep 30

| Piece | State |
|---|---|
| `TaskEscrow` | ✅ state machine, escrow + `directPay`, four permissionless exits (incl. `expireDispute`), `SameOwner` + `minJobAmount` + `minFee` floor, undeliverable payouts held in `owed` and claimable, per-job windows, two-step delayed admin · 96.5% branch |
| `StakeVault` | ✅ bonds per `agentId`, withdrawal delay, `cancelWithdraw`, slashed tokens actually leave to `slashRecipient` · 100% branch |
| `AgentAccount` | ✅ caps, per-(target, selector) allowlist that can never allow `approve`-style calls, `sweepNative`, two-step ownership, SafeCast · 100% branch |
| `AgentAccountFactory` | ✅ only an owner can create their own account · 100% branch |
| Tooling | ✅ solhint, Slither, `forge fmt`, gas snapshot, coverage floor, pinned Foundry in CI; LICENSE, SECURITY, DEPLOYMENT |

#### Backend — `agentx-backend` · ✅ built, live-verified

| Piece | State |
|---|---|
| `apps/api` | ✅ agents, jobs, meta, runs, SSE, **x402 facilitator** (`/v1/x402/settle`, `/verify`, `/redeem`) |
| `apps/signer` | ✅ the only process with a key; routes AgentAccount wallets through `execute` with the key the account granted; off-chain caps for EOAs; keeper |
| `apps/indexer` | ✅ reorg-aware, replay-safe |
| `apps/mcp` | ✅ eight tools over stdio |
| `@agentx/agent-core` | ✅ orchestrator (never hires itself; a model outage ends a step, not the run; says why a plan failed), workers, judge, **`serveX402`** |
| `@agentx/sdk` | ✅ typed client incl. **`payX402`** |
| `scripts/demo.mjs` | ✅ every agent on an `AgentAccount`, each worker its own owner, stolen-worker-key + `SameOwner` + below-minimum checks, owner sweep, `DEMO_X402=1`, survives a lossy RPC |
| `@agentx/service` | ✅ validated env, pino with redaction, request ids, `/health` + `/ready`, Prometheus `/metrics`, graceful shutdown — every service |
| Engineering | ✅ ESLint (strict type-checked) + Prettier, typed tests, coverage floors, pre-commit hook, Dockerfile + full-stack compose, CI with audit, gitleaks, CodeQL, Dependabot |

#### Interface — `agentx-interface` · ✅ built, hardened, smoke-tested

`/`, `/agents`, `/agents/[id]`, `/register`, `/runs`, `/runs/[id]`. Session 26:
CSP and security headers, explorer links behind an https allowlist, uuid ids
validated server-side (real 404s), money shown as money, error boundaries,
Open Graph metadata, accessibility pass, ESLint + jsx-a11y, 40 unit tests, a
Playwright smoke test of every page in CI.

### 2. Setup

| | Item | Detail |
|---|---|---|
| ✅ | 3 GitHub repos, per-repo SSH identity, secret-scanning hooks | full-history scan for real secrets: clean (Sep 30) |
| ✅ | Wallets | end of Session 27: DEPLOYER ~23 (topped up by you), FUNDER 3.82, AGENT_A 4.00, AGENT_B 3.95 MON — a run costs ~0.5 |
| ✅ | Docker Postgres 16 | `127.0.0.1:5442`, migrations `0000`…`0005` (`0004` = `api_keys.key_id`, `0005` = `public_id` on jobs and runs) |
| ✅ | Local model | Ollama `llama3:latest` |
| 👤 | Railway, Vercel, repos public, `EXPLORER_API_KEY` | see Next actions |

### 3. Configuration

v2 parameters: `minJobAmount` 10000 (0.01 USDC), `minFee` 100,
`disputeTimeoutSeconds` 3600 on testnet (259200 on mainnet),
`adminDelaySeconds`. Drift-checked after the v2 deploy and again at the end of
Session 26 → no drift. New knobs: `AGENT_REPLAY_MAX_MS` (cached pacing),
`CORS_ORIGINS` (required in production), `TRUST_PROXY`, per-service health
and metrics ports; every service validates its environment at boot.

### 4. Testing

| Suite | Count | State |
|---|---|---|
| Contracts — unit, fuzz, invariant (3 suites), adversarial, v2 findings | **184** | ✅ 100% branch on StakeVault/AgentAccount/Factory, 96.5% TaskEscrow |
| Backend — 35 files | **528** | ✅ lint, format, typecheck of tests, coverage floors 75/78/74/75 |
| Interface — unit | **77** | ✅ plus lint, `next build`, audit |
| Interface — Playwright | **63** | ✅ smoke + axe on every page, docs search, video guides, 21 edge and worst cases; all 63 also pass in Firefox, WebKit, iPhone 13 and Pixel 7; production build, mocked API |
| **Total** | **789** + 63 | |

Every test that guards a Session 26 fix was run against the old code first
and seen to fail.

**Live on Monad testnet, v2, Sep 30 (Session 26)**

| | Check | Result |
|---|---|---|
| ✅ | Demo, Ollama, recorded, `DEMO_X402=1` | 4/4 settled through worker accounts · x402 paid + served + replay refused · stolen key refused 3/3 · **`SameOwner` and `AmountBelowMinimum` refused on chain** · owner sweep |
| ✅ | Cached replay of it | all checks · 232 s at recorded pace · **162 s** with `AGENT_REPLAY_MAX_MS=2000` |
| ✅ | **Dispute expiry** | chain job 1 disputed, 1 h timeout waited out, keeper `expireDispute` → SETTLED, outcome `UNRESOLVED`, worker paid 0.0495, no feedback written |
| ✅ | `e2e.mjs` | passed · idempotent replay, fee 0.0002 withheld, reputation written |
| ✅ | Chaos: worker never accepts | cancelled + refunded, re-hired, settled |
| ✅ | Chaos: worker silent after accepting | re-hired; chain job 23 refunded by the keeper at its deadline |
| ✅ | Chaos: slow, lossy RPC (5%) | first run **failed — found a real worker defect** (fixed, `c781ea8`); re-run 4/4 settled |
| ✅ | Chaos: slow, lossy RPC (20%) | Session 27. First run **2/4 — the signer called an HTTP 503 `INVALID_STATE`**, so a worker gave up an accept and another finished work (fixed, `e5023d5`); second run **3/4 — a late accept made the cancel fail and the orchestrator abandoned the delivery** (fixed, `77620fe`); third run 4/4. Then 20% + **30% on broadcasts** (25/78 failed): a submit hit a 503, was retried, 4/4 settled · 858 s |
| ✅ | **M5-06: three consecutive timed runs** (the video command) | first attempt 2/3 — **found the indexer walking a job backwards** (fixed, `0044e77`); then 3/3 clean, 25/25 checks each · **149 / 153 / 168 s** |
| ✅ | Deploy rehearsal | production images built from `agentx-backend` alone; API migrates an empty DB pre-deploy; signer + API bound to `::`; `check-deployment.mjs` all green against a production interface build, and red on a wrong CORS origin |
| ✅ | `verify-indexer.mjs` | Session 27, v2: directPay job 41 decoded, linked, projected; reputation from settlement; replay a no-op; reorg rewind clean |
| ✅ | Param drift · secret scan (tracked + full history) | no drift · clean in all three repos |

### 5. Defects found and fixed during hardening

Kept because the pattern matters more than the list: **five mitigations were
documented before they were built**, and one bug survived because a test had
encoded it.

| Severity | Defect | Found by |
|---|---|---|
| 🟠 | The **indexer walked a job's state backwards** (it trails the head; the API writes ahead of it) — a delivered job read `accepted` and the approve was refused | M5-06 timed runs, normal RPC, Session 27 |
| 🟠 | **A Railway build could not have built**: the Dockerfile read chain facts from a sibling checkout a hosted build does not have | deploy rehearsal, Session 27 |
| 🟠 | An **HTTP 503 from the RPC was reported `INVALID_STATE`** (viem puts the status on the error, not in its words) — workers were told not to retry, and gave up an accept and a finished submit | 20%-lossy chaos run, Session 27 |
| 🟠 | When a late accept made the cancel fail, the orchestrator **abandoned the worker's delivery** unjudged | the same chaos run, once the first fix let accepts retry |
| 🔴 | The signer's per-agent **advisory lock could stay held forever** (taken and released on different pooled connections) — a deadlock of that agent | Session 26 audit, reproduced in a test |
| 🔴 | **API auth ran scrypt against every key** on every request — 12.9 s per request at a few hundred keys, a DoS lever | Session 26 audit |
| 🔴 | Reputation farming by self-hire; a payout to a bad wallet **trapped the job**; `DISPUTED` had no exit | contract audit → v2 |
| 🟠 | **Jobs and runs were enumerable** by serial id | Session 26 audit |
| 🟠 | A worker **abandoned finished work** when a submit failed transiently (silent failure, then a re-accept of its own job) | slow-RPC chaos run on v2 |
| 🟠 | Explorer links from the API went straight into `href` (a `javascript:` URL would run) | interface audit |
| 🟡 | An unreachable signer was reported as `INSUFFICIENT_FUNDS`; the indexer halted on one RPC 503 as if for a reorg; SSE sent no headers until the 25 s heartbeat | tests written for the audit |
| 🔴 | Every escrow job would have been **disputed** — the API stored the delivery envelope as `result`, so good work failed the required-field check | auditing docs §5 against the routes |
| 🔴 | An **indexer restart could manufacture reputation** — the bump was not idempotent, while replays are routine | chaos item 2 |
| 🔴 | The on-chain commitment was the **spec** hash, not the result hash — T4's claim was false | the same docs audit |
| 🟠 | A failed broadcast **burned the idempotency key forever**; topping up the wallet did not help | chaos item 7 |
| 🟠 | A malformed result was **stored and signed for**, despite a comment claiming it was validated | chaos item 4 |
| 🟠 | Session keys had **no lifetime bound**, though T7 claimed 24h — fixed on-chain and redeployed | security pass |
| 🟠 | T15's **SSRF guard never existed** — nothing fetches those URLs, so the threat does not apply, but the claim was wrong | security pass |
| 🟡 | The indexer retried a failing RPC every 2s forever — a retry storm against a rate limiter | chaos item 5 |
| 🟡 | The secret scanner fired on **ordinary English**, training everyone to bypass the hook that guards real keys | writing a README |
| 🟡 | Postgres 23505 reported "duplicate wallet" for **every** unique violation | tripping over it |

Earlier defects are recorded in the session log below; these are the ones since
the adversarial pass.

---

## 📊 Milestone board

| # | Milestone | Dates | Status | Done |
|---|---|---|---|---|
| M0 | Foundations | Sep 22–24 | ✅ done | 23 / 23 |
| M1 | Contracts | Sep 25–28 | ✅ done | 26 / 26 |
| M2 | Backend spine | Sep 29 – Oct 2 | 🟡 in progress | 21 / 25 |
| M3 | Agents + MCP | Oct 3–5 | ✅ done | 15 / 15 |
| M4 | Frontend | Oct 6–8 | 🟡 in progress | 9 / 11 |
| M5 | Harden | Oct 9–11 | 🟡 in progress | 6 / 7 |
| M6 | Submit | Oct 12–13 | 🟡 in progress | 5 / 8 |

Status key: ⬜ not started · 🟡 in progress · ✅ done · 🔴 blocked · ⏭ deferred · ❌ cut

---

## ✅ M0 — Foundations (task detail)

Kept for the record. Per-task detail for M1 onwards lives in the session log
and in `PLAN.md`; the rolled-up state is the Complete status section above.

| ID | Task | Who | Status | Notes |
|---|---|---|---|---|
| M0-01 | Confirm deadline + submission format | 👤 | ✅ | Oct 13 2026 11:59 PM ET; Track 4 |
| M0-02 | Monad chain facts | 🤖 | ✅ | testnet 10143 / mainnet 143, verified Sep 22 |
| M0-02b | Testnet vs mainnet | 👤 | ✅ | **testnet first, both supported** |
| M0-03 | Create 3 GitHub repos | 👤 | ✅ | ✅ `gopaltalaviya/agentx-{contracts,backend,interface}` |
| M0-04 | Create + fund 4 wallets | 👤 | 🔴 | faucet.monad.xyz |
| M0-05 | Scaffold `agentx-contracts` | 🤖 | ✅ | ✅ Foundry + remappings + Makefile + CI; `forge build` green |
| M0-06 | Scaffold `agentx-backend` | 🤖 | ✅ | ✅ pnpm workspace + docker-compose + tsconfig; builds |
| M0-07 | Scaffold `agentx-interface` | 🤖 | ⬜ | ready, waiting on M0-03 |
| M0-08 | `MockUSDC.sol` + test | 🤖 | ✅ | ✅ `MockUSDC.sol` + 5 tests, all passing |
| M0-09 | `Deploy.s.sol` + Makefile | 🤖 | ✅ | ✅ `Deploy.s.sol` — network-agnostic, dry-run verified on 31337 |
| M0-10 | Deploy + verify MockUSDC | 👤 | ⬜ | |
| M0-11 | ABI export script | 🤖 | ⬜ | |
| M0-12 | Decide package registry (D1) | 👤 | ⬜ | timebox to 30 min |
| M0-13 | Publish `@agentx/contracts` v0.0.1 | 👤 | ⬜ | |
| M0-14 | Install in B + W, prove wiring | 🤖 | ⬜ | |
| M0-15 | `packages/shared` zod schemas | 🤖 | ✅ | ✅ `@agentx/shared` — JobSpec/JobResult/errors, zod-derived |
| M0-16 | `.env.example` × 3 | 🤖 | ✅ | ✅ `.env.example` (contracts repo) |
| M0-17 | `config/networks.json` | 🤖 | ✅ | ✅ `config/networks.json` — 31337 / 10143 / 143 |
| M0-18 | `config/params.<chainId>.json` × 3 | 🤖 | ✅ | ✅ `config/params.*.json` × 3, key-parity enforced |
| M0-19 | `foundry.toml` aliases + `Makefile NETWORK=` | 🤖 | ✅ | ✅ `foundry.toml` aliases + `Makefile NETWORK=` |
| M0-20 | `write-deployment.mjs` | 🤖 | ✅ | ✅ `write-deployment.mjs` — proven on a real anvil deploy |
| M0-21 | `@agentx/config` — validated, frozen | 🤖 | ✅ | ✅ `@agentx/config` — validated + frozen; 8 money tests pass |
| M0-22 | Fail-fast boot validation | 🤖 | ✅ | ✅ fail-fast boot check, negative-tested |

Full task list for every milestone: [PLAN.md](PLAN.md)

---

## 🧭 Decisions log

Append-only. Never rewrite a decision — supersede it with a new row.

| Date | # | Decision | Rationale |
|---|---|---|---|
| Sep 22 | — | 3 separate repos | Contracts must never enter a Vercel/Railway build container ([docs/06](https://github.com/gopaltalaviya/agentx-docs/blob/master/docs/06-repo-structure.md)) |
| Sep 22 | — | You hold all keys; you run all deploys | No private key reaches this session or any repo |
| Sep 22 | — | Vercel (web) + Railway (backend + Postgres + Redis) | Indexer and signer are long-running; Vercel cannot host them |
| Sep 22 | — | Claude writes code; you review, run, decide scope | |
| Sep 22 | — | Standard conventions everywhere | Conventional Commits, semver, `main` + short branches, tool defaults, no bespoke rules |
| Sep 22 | D1 | **Resolved: git dependency.** GitHub Packages forces the npm scope to equal the GitHub owner, which would rename `@agentx/contracts` to `@<owner>/contracts`. A git dep keeps the name, needs no registry setup | ✅ |
| Sep 22 | D2 | **Resolved: yes, public.** Submission rules require "a link to the code" | ✅ |
| Sep 22 | — | Target **Track 4 — Trust, Identity & AI Infrastructure** ($30k) | Track description names "agent trust" and "agent reputation systems" |
| Sep 22 | D6 | **Resolved: testnet first, both networks supported.** Network is config, never a code path | ✅ |
| — | D3 | Protocol fee paid by worker or client | ⬜ open — needed Sep 26 (rec: worker) |
| — | D4 | Name `AGENTX` available? | ⬜ open — needed Sep 25 |
| — | D5 | Demo domain | ⬜ open — needed Oct 6 |
| Sep 23 | M1 | **Agent models: orchestrator `claude-opus-5`, workers `claude-haiku-4-5`.** Planning and result-judgement are where a weaker model shows, and they are the visible part; workers do schema-constrained extraction, which Haiku handles 5x cheaper and faster (~$0.02/run vs ~$0.15) | ✅ |
| Sep 23 | M2 | **`AGENT_MODE=cached` is the development default.** One live run seeds the cache; Claude asks before any further live run. Dev cost ~$0.10 rather than ~$4–30 | ✅ |
| Sep 23 | C1 | **Resolved: encrypted keystore in a Railway env var**, passphrase in a separate var. Signer is built against a `Signer` interface so KMS can replace it without touching call sites. Documented as a known limitation in the submission | ✅ |
| Sep 23 | M3 | **The injection claim is bounded, not absolute.** "We do not prevent prompt injection; a successful one cannot spend more than the on-chain daily cap or pay a non-allowlisted address." Layer 4 is arithmetic, the rest is mitigation. No keyword filtering — it fails to paraphrase while manufacturing the look of safety | ✅ |
| Sep 23 | M3 | **System prompts are frozen module constants.** A prompt cache is a prefix match; one interpolated value invalidates every call. Dynamic context goes in the user turn. Enforced by a test, not a convention | ✅ |
| Sep 23 | M3 | **A failed judgement neither pays nor disputes.** Paying on an unread result rewards a worker for our outage; disputing punishes them for it. The escrow's review window settling in their favour is the only neutral option | ✅ |
| Sep 23 | M3 | **BUDGET_EXCEEDED is never retryable**, despite carrying a reset time. A cap is the owner's decision; an agent reports hitting it rather than sleeping until it lifts | ✅ |
| Sep 28 | M6 | **Name ERC-8183 in the submission rather than let a judge find it.** It standardises the job-escrow layer AGENTX independently built (Open → Funded → Submitted → terminal, permissionless refund). Positioning moves from "an escrow for agents" to settlement-backed reputation plus the bounds a spender needs — caps, stake, disputes — which 8183 leaves unspecified | ✅ |
| Sep 28 | M6 | **Lead with the published numbers.** Xiong et al. 2026 measured the live ERC-8004 ecosystem: $0.0027 median to move a score on Base, 90.6% of reviewers Sybil, 98.7–100% of feedback with no payment proof. Their first recommendation is evidence-backed interactions — which is what this project is | ✅ |
| Sep 28 | M6 | **Mapping TaskEscrow onto the ACP Job interface is post-hackathon.** Obvious next step, explicitly out of scope with 15 days left and the demo not yet run end to end | ✅ |
| Sep 28 | M6 | **No Artifacts for this project — deliverables are local files**, committed to the repo: `.pptx`/`.html` decks, `.md` docs, `.xlsx` tables. A submission needs something a judge can download and a repo they can open; a hosted page is neither, is a second place for the truth to live, and is not in the backup. Recorded in `CLAUDE.md` at the project root and in this repo | ✅ |
| Sep 29 | M3 | **Supersedes Sep 23: the injection bound is enforced by the signer, not on chain.** Demo agents are EOAs, and nothing enforced a cap for them. The signer now does. The claim is "cannot spend past the caps the owner set, enforced outside the model by the process that holds the key"; on-chain only for `AgentAccount` wallets. Protects against a hijacked agent, not a compromised signer | ✅ |
| Sep 29 | M3 | **A silent worker is retried once, with a different agent.** 45 s to accept, else cancel (immediate refund) and re-hire; an accepted job that never arrives is abandoned at the step timeout. Never the same agent; never a second hire if the cancel fails | ✅ |
| Sep 29 | M3 | **The fast path must be earned** — `fastPathMinScore` enforced for `auto`. Consequence accepted: fresh demo agents always go through escrow | ✅ |
| Sep 29 | M5 | **A keeper sends the escrow's permissionless exits**, in the signer, on its own gas-only key | ✅ |
| Sep 29 | M5 | **Deployed contract source is not edited, even comments** — it would break explorer verification of the live contracts. Wrong comments are corrected in the docs instead | ✅ |
| Sep 29 | M5 | **The spending agent's caps live in its own wallet.** The orchestrator pays through an `AgentAccount`; workers, which never spend, stay EOAs. The owner key is not held by the signer in principle — in the demo it is DEPLOYER, standing in | ✅ |
| Sep 29 | M5 | **A reorg that drops an applied transaction halts the indexer for an operator** rather than rewriting the append-only event log | ✅ |
| Sep 30 | M5 | **Workers act through `AgentAccount`s too** — supersedes Sep 29's "workers stay EOAs". Zero caps, escrow-only, `acceptJob` + `submitResult` only, one session key per worker (nonces belong to keys); earnings are the owner's to sweep | ✅ |
| Sep 30 | M3 | **x402 is `directPay` behind a facilitator, scheme `agentx-directpay`**, not EIP-3009 `exact`: the agent holds no key to sign an authorisation, and MockUSDC has no `transferWithAuthorization`. Client settles first; the worker redeems the receipt once, checked against the chain | ✅ |
| Sep 30 | — | **ERC-8183 conformance waits for the next deployment.** Mapping written (docs/12); conformance is a new kernel with AGENTX as evaluator + hook, and a redeploy would discard the live evidence | ✅ |
| Sep 30 | — | **The video uses the Ollama recording.** Gemini was tried as asked: the default model was retired (fixed), then 503 twice. Arbiter and fee recipient stay on DEPLOYER; repos stay private until you flip them | ✅ |
| Oct 1 | M2 | **No seeded history (M2-03 cut).** ~300 invented settlements would be fabricated reputation — the one thing AGENTX exists to prevent — and a judge who opens the explorer would find they never happened. The marketplace shows only real settled jobs, however few | ✅ |
| Oct 1 | M1 | **Agent cards are inline `data:` URIs.** ERC-8004 allows base64 `data:` for fully on-chain metadata; it needs no host, and the testnet registry stores no URI to update later. `registrations` is empty because the id is assigned by the carrying transaction | ✅ |

---

## 📓 Session log

### Session 39 — 2026-11-01 (code-level rename to Pactora, all four repos, local `v3`)

**Did**
- Packages `@agentx/*` → `@pactora/*` (package.json, imports, CI, Dockerfile
  and compose `SERVICE` args, Railway `preDeployCommand`, docs and site
  samples); root names `pactora-backend` / `-interface` / `-docs` /
  `-contracts-tools`; bins `pactora-mcp`, `pactora-config-check`; the
  contracts export package `@pactora/contracts`. `pnpm-lock.yaml`
  regenerated by `pnpm install`.
- Env vars `AGENTX_*` → `PACTORA_*` everywhere they are read or documented.
  **Fail-fast:** `assertNoLegacyEnv` (`@pactora/shared`) — `loadConfig`
  (API, signer, indexer, config check), `runWorker`, the orchestrator and the
  MCP server refuse to start while any `AGENTX_*` variable is set, even an
  empty one, naming the `PACTORA_*` replacement. Tests written first and run
  red on the old code (3 of 4 failed; the fourth is the control).
- `AgentxClient`/`AgentxError`/`AgentxConfig` → `Pactora*`; MCP server
  `name: 'pactora'`; agent card service `name: 'Pactora'` (backend
  `scripts/lib/chain.mjs` and interface `lib/agent-card.ts` together — nothing
  reads it back); error type URIs `https://pactoragents.com/errors/…`;
  `agentx.example` → `pactora.example`; site keys `pactora:search*`,
  `window.__pactoraEarly`.
- Backend **764 → 771** (+7 legacy-env tests); interface 99 vitest, 76
  Playwright; contracts 414 untouched. Live 10143: `e2e.mjs` passed end to end
  with only `PACTORA_*` set, and the built API, MCP server and a worker each
  refused a stale `AGENTX_*` variable.

**Kept, by rule** — on-chain tags, ERC-7201 slot, `ipfs://agentx-*` /
`agentx://` agent URIs, x402 `agentx-escrow`/`agentx-directpay`, the signer
idempotency prefix `agentx:sign:v1:` (stored in `signer_txs`), Postgres
`agentx_events`/`agentx_notify_event`, DB URLs, docker/volume/container
names, `ax_`, repo/folder names and `gopaltalaviya/agentx-*` URLs, dated
history (CHANGELOG past entries, PLAN, this log, docs 05/11/17/18/22, the
deck and video file names).

### Session 38 — 2026-10-31 (rebrand to Pactora, backend, local `v3`)

**Did**
- Every name a person reads is now **Pactora**: README ("Pactora (formerly
  AGENTX)"), SECURITY, PLAN title, OpenAPI `info.title` "Pactora API", MCP
  instructions, tool descriptions, stderr lines and server `title`, config
  check output, x402 quote description, demo/verify/video script output,
  product-describing comments. Signed challenges now open
  `Pactora: register an agent.` and `Pactora: issue a new API key, …`
  (rest unchanged).
- New pins: the challenge's first line and the OpenAPI title — both fail on
  the pre-rebrand code. Backend **764 passed before, 764 after** (the pins
  are assertions inside existing tests); lint, typecheck, format clean.
- Live, testnet 10143: `e2e.mjs` passed (registration through
  `/v1/agents/challenge`, hire, idempotent replay, settle, fee, reputation).

**Decided**
- Kept for programs: on-chain tags, x402 scheme ids, `@agentx/*`, `AGENTX_*`,
  `Agentx*` classes, error type URIs (`agentx.dev/errors/…`), `ax_`, DB and
  docker names, the MCP protocol `name: 'agentx'`, and the agent card's
  `services[].name: 'AGENTX'` (a service identifier, mirrored by the
  interface's `lib/agent-card.ts`).
- The cached replay is unaffected: no prompt in `.agent-cache/` contains the
  product name.

### Session 35 — 2026-10-12 (final pre-submission verification)

- **Everything re-run:** contracts 184, backend 591 (3 new), interface 87 unit
  + lint + typecheck, 72 Playwright (Chromium); CI green on every code repo's
  HEAD; `check-deployment.mjs` 16/16 against the hosted site and API;
  `check:contract` with a real hosted run id; site pages, video links and the
  docs repo all answer. Cached demo on testnet 4/4 settled, all checks, both
  before and after the fix.
- **Found and fixed:** `network.paymentToken.address` was `null` on every
  chain (the token is deployed with the protocol, so its address is only in
  `deployments/<chainId>.json`). The hosted `/v1/budget` showed the judges'
  orchestrator holding 0 MockUSDC while it held 20.15; `/v1/network` named no
  token; a hosted x402 worker would have refused to start. Config now resolves
  it once (`packages/config/src/index.ts`). 3 tests, all seen failing first.
  Hiring never read the field, so runs were unaffected.
- **Judges' orchestrator topped up:** 50 MockUSDC from DEPLOYER (tx
  `0xb7e201c7…df98b`) → 70.15,
  enough for the 5/day cap for two weeks. Its gas (session key) holds ~13 MON.
- **Redeployed** all seven images to the VPS after a fresh backup
  (`agentx-20261012-0643.dump`); compose files on the server verified identical
  to the repo. After: status operational, 16/16 checks, `/v1/budget` shows
  70150000, `/v1/network` names MockUSDC, workers ready. No live AI run.
- Portal doc: "Steps to try" renamed to the form's **"Judge access
  instructions"**; a duplicate step number fixed. Figures 859 → 862 in the
  docs, deck and workbook (rebuilt; deck geometry clean).
- **Traps:** VPS SSH needs the owner's key with `-o IdentitiesOnly=yes`.
  `docker compose ... build` needs `SIGNER_TOKEN` set just to interpolate (any
  32+ chars; not baked into images), and building all services at once crashed
  Docker Desktop again, taking the dev Postgres down mid-demo — build one
  service at a time.

### Session 34 — 2026-10-08 (specialists, not generalists)

- **Judges' caps raised on chain:** the hosted orchestrator's AgentAccount
  policy is 0.1 MockUSDC per task, **5 per day** (`setPolicy`), its session
  key budget renewed to 5, and the off-chain `spend_policies` mirror updated.
  `GET /v1/budget` shows dailyCap 5.
- **Daily database backup on the VPS:** `deploy/vps/backup.sh` from cron at
  03:00 UTC, 7 days kept, every dump listed by `pg_restore`. Restore
  rehearsed into a throwaway container: row counts matched live.
- **Reputation per skill** (backend `793357d`, site `ec77cae`): one shared
  score definition (`packages/db/src/reputation.ts`) used by the indexer and
  by discovery. `GET /v1/agents?capability=X` ranks on the record in X and
  returns `skill`; `GET /v1/agents/:id` returns `skills`; the orchestrator's
  selector sees the skill record. Overall figures unchanged. Marketplace shows
  "score in <skill>"; profiles have a "By skill" table. Live: per-skill equals
  overall for the single-skill hosted agents, as expected.
- **Run record proves each review** (site `8525ad4`): under a settled step,
  "Review written on chain for <agent> — score now N", linked to the
  settlement transaction; a refused review (FeedbackFailed) is said plainly.
  Verified in a browser on a live run.
- **CI:** runners pinned to `ubuntu-24.04`; actions on their Node 24 majors
  (checkout 7, setup-node 7, pnpm 6, codeql 4, buildx 4, gitleaks 3,
  upload-artifact 7). Green on all repos.
- Every new test was seen failing on the old code first. Cached demo on
  testnet passed (4/4 settled) after the selector change — recordings intact.
  Note: the demo needs `set -a; . ../agentx-contracts/.env; set +a` first, or
  it picks the Anvil key and stops before spending.
- 5-engine e2e: WebKit a11y pages can time out under heavy machine load (a
  demo running alongside); they pass with `--workers=2`.
- Deployed: API + indexer images to the VPS (backup taken first); API
  contract check holds against the live API.
- **Live checks on the judges' key (2 runs, the agreed maximum):** both from
  the site, 2/2 settled in 18 s each. The settlement receipt holds the
  registry's review event and no `FeedbackFailed`; overall and per-skill
  figures moved together (9 → 10 settled, 64 → 66).
- **Groq-only full live run — found and fixed a defect** (`e0255f5`): the
  planner wrote `liquidityData: "<output of subtask 0>"` beside the real
  `previousResult`, and the worker declined for lack of data it had been
  given. A second run wrote `"{{0}}"`. Such placeholders are now dropped
  when a step receives an upstream result. Re-run Groq-only: 2/2 settled.
  No recording contains one; cached demo still 4/4. API redeployed.

### Session 33 — 2026-10-07 (hosted live · every ending explained)

- **Hosting.** Railway's trial had expired, and a free-tier VM with 0.5 GB ran
  the stack but its status page flapped "down" (probes timing out under swap).
  Moved — database and all, `pg_dump` →
  restore, indexer cursor kept — to a Vultr VPS (2 vCPU / 4 GB): Caddy with a
  Let's Encrypt certificate on `api.<ip>.sslip.io`, only 22/80/443 open, SSH
  key-only. Images are built here and loaded there. 16/16 deployment checks,
  status operational throughout, clean crawl in three engines.
- **Live runs failed 3 of 3 at first.** Causes, each fixed with a test seen
  failing first: the research worker declined any research ("the input lacks
  the data" — it has no live feed; then "Monad postdates my training"); a
  decline was silent, so the run waited 45 s and said "never accepted";
  `gemini-flash-latest` hung 60 s, longer than the accept window; a run that
  delivered nothing ended `done` and the site showed it green "finished".
- **Now:** `POST /v1/jobs/:id/decline` (off-chain, reason, idempotent);
  `awaitResult` stops on it at once; the step ends `declined` with the reason
  and the next agent is hired; triage has a 15 s per-call timeout and names its
  `blocker` — only client-only data, an impossible action or work outside the
  capability may decline (enforced in code); a run with no settled step ends
  `failed` with "No agent delivered. <capability>: <why>."; the site labels
  every status in words and says "The run did not deliver". Claude cut off at
  max_tokens is a provider failure, not a SyntaxError.
- **Verified live:** after the fixes, 3 of 3 runs from the hosted site with the
  example goal settled 2/2 (88–91 s); a real declined run's record page reads
  correctly. Tests 789 → 820 (backend 528 → 555, interface 77 → 81 unit,
  63 → 64 browser; 318 of 320 browser runs pass across five engines, 2 skipped).
- **Deep live test** (the hosted site and API, real browsers): API 57/57; site
  features in Chromium, Firefox, WebKit and an iPhone, search included, axe
  clean; on chain, every settled step's transaction succeeded through the
  AgentAccount and all three workers carry settlement-backed reviews. It found
  three more defects, each fixed with a test seen failing first: an empty plan
  said only "no subtasks" (now the planner's reason); a worker judged the
  whole goal instead of its own step and declined research because it cannot
  execute; a decline arriving before the indexer linked the job made the
  cancel fail ("not confirmed yet") and the step was lost (now retried). Also
  "a negative answer is an answer" in triage. A 3-agent run then settled 3/3
  in 41 s.
- **Gemini is on the free tier: 20 requests per model per day.** A 3-agent
  run makes ~12–15 calls, so the hosted demo manages only a handful of runs a
  day before every model answers 429 — and judges would see "could not reach
  its model". The chain now starts with the lite models
  (`gemini-flash-lite-latest, gemini-3.5-flash-lite, gemini-3.6-flash, gemini`)
  to spread the load. **The real fix is the owner's**: billing on the Gemini
  key (pay-as-you-go, cents per run) or a second provider key (Groq).
  `RUNS_PER_DAY` is 20.
- **When the free AI quota runs out, the site says so** (2026-10-08): a model
  failure reads "AI model unavailable: its free request quota is used up for
  now" instead of provider JSON; `/v1/status` gains `model` (from run
  outcomes); `/demo` warns before Run that the AI model is out of quota and
  AGENTX itself is working, with links to the last delivered run and the
  recorded video; a run stopped by the model is titled "not a protocol
  failure"; `/status` shows an AI model card apart from the components.
- **Groq as a second provider** (2026-10-08, free key in `agentx-backend/.env`):
  chain `gemini-flash-lite-latest → gemini-3.5-flash-lite → groq →
  gemini-3.6-flash → gemini`. Wiring it found four defects, each fixed with a
  test seen failing first: Groq strict JSON refuses optional fields (strict
  only when all are required); gpt-oss reasons inside max_tokens and returned
  empty triage (headroom + effort); "outside my capability" is never true for
  an offer (offers are filtered by capability — overruled in code); the judge
  marked a research step down for lacking the other agents' parts (judged
  against its own step now; re-judged the disputed result: accepted 3/3).
  Today's testing used the judges' key's 20 runs/day; slots free from
  09:15 UTC, so further live tests wait.
- **Fixed 2026-10-08:** the recorded model sessions in `.agent-cache/` are now
  committed, so the cached demo runs from a clone with no AI key (25/25 checks
  on testnet, 2026-10-08). The prompt edits had orphaned the triage
  recordings — the re-key script read the prompt's source text, whose escapes
  differ from the runtime string; re-keyed from the compiled prompt, and
  `test/recordings.test.ts` now fails if any recording becomes unreachable.
- **Was "found, not fixed":** `.agent-cache/` (the recorded model sessions) is
  gitignored, so `AGENT_MODE=cached` cannot work from a clone. The submission
  now tells judges to use the hosted site, or `AGENT_MODE=live` with a model.
  The local recordings were re-keyed for the new triage prompt (method proven:
  every key reproduced under the old prompt first).

### Session 32 — 2026-10-06 (public · `master` · docs in their own repo)

- **Public.** The owner made the repos public and renamed the production
  branch to `master`. Checked from outside: contracts (5) and backend (10)
  still exposed closed dependabot PR refs pointing at pre-rewrite commits
  with personal info (no secrets). The owner deleted and recreated those two
  repos empty; the clean history was pushed back, so only `master` exists.
- **Docs moved** to the owner's new `agentx-docs` repo with their history
  (`git filter-repo --path docs/`, same paths). A README hub was added;
  links that left `docs/` now point at GitHub URLs; every backend link
  into `docs/` points at agentx-docs. The deck build (`pnpm deck`) and
  `pptxgenjs` moved with it.
- **The API-doc test** reads `agentx-docs/docs/15-api.md` (sibling
  checkout, or `AGENTX_DOCS_DIR`); CI checks agentx-docs out. Seen to fail
  with a route row changed in the doc, then pass.
- **`master`** in every CI trigger and in the docs that name the branch.
  The site footer links the docs repo.

### Session 31 — 2026-10-05 (hosted live runs: built, rehearsed, fixed)

- **Built:** `scripts/seed-hosted.mjs` (fresh random keys; `--top-up`,
  `--reclaim`), `scripts/lib/agents.mjs` (the demo's setup, shared — demo
  unchanged, 25/25 live), the signer's **session-key renewer**
  (`SESSION_OWNER_PRIVATE_KEY`), a per-orchestrator **`RUNS_PER_DAY`** cap
  (429 `RATE_LIMITED`), `INDEXER_START_AT_HEAD`, the compose `hosted` profile.
- **Rehearsed** the hosted layout end to end ([docs/17 §20](https://github.com/gopaltalaviya/agentx-docs/blob/master/docs/17-production-readiness.md)):
  a live Gemini run from the real site settled 2/2 in 151 s; renewal proven
  on chain; the cap refused a run on the site; deployment checks, probe and
  three-engine crawl clean.
- **Six defects found on the way, all fixed with failing-first tests:**
  parallel image builds segfaulted/hung (now per-service, 110 s for seven);
  a transient 503 ended a run (retries); one overloaded Gemini model was a
  dead end (`gemini:<model>` chains); a thinking model truncated at 400
  tokens (headroom + truncation moves the chain on); JSON in prose failed a
  job; **a second run with the same goal could never hire** (idempotency key
  per run, not per spec).
- Tests: 766 → 789 (backend 528), browser 62 → 63; live demo 25/25 after
  every change; no secret (5 real + 9 rehearsal) in any commit.

### Session 30 — 2026-10-05 (depth testing · cross-browser · audit · deploy rehearsal)

- **Cross-browser for the first time**: all browser tests in Firefox, WebKit
  (Safari), iPhone 13 and Pixel 7 — 310 runs. Found three real bugs, fixed
  with tests that fail on the old code: input typed before hydration was
  wiped (Safari, slow phones); a dropped live stream read as "finished" in
  Firefox; a reconnect showed every trace line twice (the server replays
  history) in every browser. Plus a phone accessibility bug: wide docs
  tables could not be scrolled by keyboard.
- **Independent docs audit** (sub-agent, read-only): 7 high, 7 medium, 5 low
  — every one fixed (503 for a DB outage in runbooks/API docs, rate-limit
  exemptions, "per IP" not "per key", missing params, `.env.example` gaps,
  two broken anchors, overclaimed on-chain caps on the site). Link check:
  237 relative links, 0 broken.
- **Security**: full git history of all three repos scanned for the five
  real secrets (4 private keys, Gemini) — none, in any commit. `pnpm audit
  --prod` clean in backend and interface.
- **Live on testnet**: demo with x402 — every check, 184 s; `e2e.mjs` passed;
  `verify-indexer` 13/13. Contracts 184 (CI fuzz profile), backend 505
  (coverage 79.9 / 81.9 / 78.1 %), interface 77 + 62 browser.
- **Deploy rehearsal** on the production images: `check-deployment` green;
  `probe-api` 613 requests clean; every page clean in three engines.
- **Railway blocked**: trial expired — owner must pick a plan. FUNDER topped
  up by the owner (15.01 MON).

### Session 29 — 2026-10-01 (search · guides · edge, critical and worst cases)

- **Docs search** (interface): Ctrl/⌘+K anywhere, `/` on docs. Indexed from
  the real prerendered pages (no hand-kept index); typo, stem, synonym and
  camelCase-aware; pages, actions and live agents in one ARIA combobox.
- **Video guides**: six captioned clips at `/docs/guides`, recorded live on
  testnet with `scripts/video/guides.mjs`; embedded in three docs pages.
- **Edge suite** (`e2e/edge.spec.ts`, 19): found 5 bugs — unreadable errors
  when the API is unreachable or answers garbage; register not mirroring the
  API's limits; a dropped live stream looked like a run that never ends;
  long names and the 320 px header overflowed.
- **Hostile HTTP** (`scripts/probe-api.mjs`, 416 requests): zero 500s, no
  leaks; `/health` and `/ready` were rate limited (fixed).
- **Worst cases** on `docker-compose.full.yml`, one dependency down at a
  time ([docs/17 §17](https://github.com/gopaltalaviya/agentx-docs/blob/master/docs/17-production-readiness.md)): signer down
  reported the RPC down too (DNS thread starvation — coalesced probe); a
  database outage was a 500 (now 503 + retry-after); a stopped indexer read
  as catching up (now "down" after 120 s).
- **Found while recording**: a finished run could show no answer (the API
  published `finished` before writing it); a leftover signer hijacked the
  next demo; the demo rate-limited its own agents; a drained FUNDER read as
  "reverted". All fixed ([docs/17 §19](https://github.com/gopaltalaviya/agentx-docs/blob/master/docs/17-production-readiness.md)).
- **Live**: `verify-indexer` on testnet 13/13; `check-deployment` green on
  the production images; three live runs 4/4 settled for the guides; chaos
  at 20 % + 30 % broadcasts **3/4, the fourth safely refunded**.
- ⚠️ **FUNDER is nearly empty** (0.0066 MON): demos ran with
  `FUNDER_PRIVATE_KEY` unset so the deployer paid gas, which also turns the
  keeper off. Top FUNDER up before relying on the keeper.
- Final: 184 + 505 + 74 = **763** tests + **61** browser; all green.

Newest first. One entry per working session, however short.

### Session 27 — operations audit (2026-09-30)

A production-operations audit of the backend, filtered to what AGENTX has (no
Redis, WebSockets, subgraph or markets). **Docs:** [14 — Operations](https://github.com/gopaltalaviya/agentx-docs/blob/master/docs/14-operations.md)
(health/status classification, versioning, environments and which copy of
each fact is authoritative, monitoring and an alert table, indexer
lifecycle, every migration reviewed for locking, backups, security,
incidents with templates), [15 — HTTP API](https://github.com/gopaltalaviya/agentx-docs/blob/master/docs/15-api.md) (hand-written —
routes validate with zod in handlers, so no OpenAPI without a refactor — and
a test fails if its route index and the app disagree),
[16 — Runbooks](https://github.com/gopaltalaviya/agentx-docs/blob/master/docs/16-runbooks.md) R1–R11, and
[17 — Production readiness](https://github.com/gopaltalaviya/agentx-docs/blob/master/docs/17-production-readiness.md) (checklist +
report). docs/08 §5 was missing 17 variables the services read; fixed.
**Code, each test run against the old code first:** public `GET /v1/status`
(components, per-chain RPC and indexer lag, build; cached 5 s, 2 s per check,
never an error text) · build metadata (commit + build time baked into images,
on every `/health`) · indexer head/indexed/lag gauges · the API's public
`/ready` no longer echoes driver errors (internal hostnames) · `/metrics` not
served in production without `METRICS_TOKEN` · `GET /v1/agents/abc` was a 500.
`verify-indexer.mjs` passed live on testnet; the api image was built and
reported its commit. 475 → 495 backend tests. **Owner decisions** are listed
in docs/17 §14 — above all, enable Railway Postgres backups and point an
uptime monitor at `/v1/status`.

**Reviewing the audit found one more:** `GET /v1/agents/:id` answered 409
`AGENT_NOT_HIREABLE` (a hiring refusal) for an agent that does not exist —
the audit kept that for consistency and documented it. The interface's agent
page branches on `NOT_FOUND`, and its mock API had always answered 404, so the
smoke test agreed with the assumption: against the real API the page showed
"could not load" and a useless retry. Now 404 (`1651d11`); 496 tests.

### Session 28, part 2 — 2026-10-01 (brand · independent review · the video)

- **Brand**: the AGENTX mark (four agents whose lines cross at the escrow),
  favicon, 180 px app icon, a 1200×630 link preview generated at build,
  web manifest, logo in header/footer/README/deck cover, `docs/brand/`.
  `NEXT_PUBLIC_SITE_URL` must be set on Vercel or previews point at localhost.
- **Independent read-only review** of every claim against the code (a
  sub-agent): found v2's dispute timeout still described as missing in six
  docs, a landing code sample that said "escrow" while the default path can
  pay directly (and did not typecheck — now verified against the real SDK),
  "caps enforced on chain" overclaimed for plain-wallet agents, the fee
  described as added rather than deducted, stale counts, unlabelled v1
  evidence. All fixed; 11-submission gained a submission-form block and a
  copy-paste "run it yourself".
- **The video** (`docs/video/`, scripts in `scripts/video/`): recorded with
  Playwright from the real site against a held demo on Monad testnet —
  title → problem → landing → a live run from the Run button (4/4 settled,
  shown at 1.5×) → the settlement's receipt read from the RPC → run record,
  marketplace, ERC-8004 identity → status → end card. Two takes were
  corrected before the final: the run scrolled off-screen, and the receipt
  card labelled the orchestrator's AgentAccount as the escrow (the tx is sent
  to the account, which calls TaskEscrow) — caught by checking the frames.
- Final: 184 + 497 + 49 = 730 tests, + 30 browser; all green.

### Session 28 — 2026-10-01 (recheck · ERC-8004 agent cards · PLAN in sync)

**On "recheck and continue for remaining all".**
- **Recheck** of PLAN.md against the code: its ticks had drifted (every M4
  page was built but unticked). 54 rows ticked with evidence; 4 cut with the
  reason written in the row (fallback registries, off-chain scoreOf, the
  fabricated seed — see Decisions). Now **106 / 116 in scope**; the 10 open
  are yours (deploy ×3, video ×2, submit, links, freeze, contracts-public
  decision) plus M6-02, the final docs pass, which belongs just before
  submission.
- **The one genuinely missing 🤖 task, M1-03b agent cards**: identities were
  registered with `agentx://<name>` / `ipfs://<label>` — URIs that resolve to
  nothing. Now a real ERC-8004 registration-v1 card (shape read from the EIP)
  travels as a `data:` URI from the register page and the demo. **Verified on
  chain**: identity #146's `Registered` event decodes to the card. 4 unit
  tests; the profile shows the ERC-8004 identity and links the registry.
- READMEs: the backend says it is live and where; the interface opens with
  the landing screenshot and a pitch.
- Browser suite: 30/30 on four runs; one earlier run had a single failure
  that did not reproduce (machine under load from another project's tests).

### Session 27 — deep browser testing (backend `6d481fb`, interface `e9771f4`)

- **Walkthrough against the real stack**: 51 checks — every link on 18
  pages, every control (tabs, FAQ, copy, rank modes, search, filters,
  validation, keyboard, phone menu, docs pager) — all pass.
- **The Run button, live, in a real browser**: needed an orchestrator the
  running stack can sign for, so `demo.mjs` gained `DEMO_HOLD` (`ui`: hold
  before the run; key to a gitignored file). The first attempt found a real
  production bug: **the live event stream sent no CORS headers** (written to
  the raw socket), so on any cross-origin deployment a run looked frozen;
  the mock API's `*` had hidden it. Fixed with a test that failed first. The
  retry: streamed live, 4/4 settled in 76 s, record/history/scores/landing
  all updated, no console errors.
- **axe-core accessibility audit** of all 16 pages (WCAG 2.1 AA): failed 6 at
  first — in-text links distinguishable only by colour, keyboard-unreachable
  scrolling code — both fixed; now 0 serious/critical.
- The demo's figures now refresh after a run settles.

### Session 27 — a product site (interface `cff1a9e`)

On "still looks old; make it production level, a real company project to
raise money": `/` is now a landing page (animated escrow diagram, live figures
and deployed contracts from the API, problem → how it works → features →
developer code tabs → security → roadmap → FAQ), `/docs` has eight pages
(quickstart, how it works with the four exits and the score formula, build an
agent, MCP, HTTP API, security model incl. what it does not claim, FAQ), and
the console moved to `/demo` with a getting-a-key guide. Nothing invented: no
logos, quotes or metrics; every fact read from the contracts, SDK, MCP tools
and docs/15. Two new smoke tests (landing, every docs page); the 375 px check
caught two overflows, fixed. 45 unit + 14 smoke.

### Session 27 — modern UI/UX (interface `1900544`, `815fb2e`, `456e14a`)

On "make it modern UIUX, latest animations", filtered to what AGENTX has (no
trading, charts or WebSockets to design for):
- **Design system** `components/ui/` — Button, Card, Badge, Field (clear,
  reveal, paste), CopyButton, PageHeader, loading/empty/error states, Reveal,
  CountUp — and tokens in `globals.css`; every page uses them.
- **Every page rebuilt**: sticky header marking the current page + mobile
  menu; hero with live figures, how-it-works and chain facts; a run console
  with a progress stepper; sliding ranking control, `/` search, skeletons;
  score ring; step timeline and trace rail; register step guide with the
  API's capability rule checked before the wallet signs; new **`/status`**
  page over `GET /v1/status`.
- **Motion** is transforms/opacity only; reduced motion shows everything at
  once. Found on the way: a hydration mismatch in the new paste action.
- **Verified**: 45 unit, 12 smoke (new: status page, 375 px no-overflow +
  menu, reduced motion — which failed with its CSS rule removed); against the
  real signer + indexer + API on testnet: `check:contract` holds incl.
  `/v1/status`, `check-deployment.mjs` all green, screenshots refreshed.
- The other project on this machine runs an e2e harness on ports 3100/8787
  and kills whatever holds them: smoke-test ports are now `E2E_PORT` /
  `MOCK_API_PORT`.

### Session 27 — 2026-09-30 (the 20%-lossy chaos run · two retry defects · indexer re-verified)

**Resumed** Session 26's wrap-up: PROGRESS had placeholders for the 20% chaos
run, `verify-indexer.mjs` and the balances. Docker Desktop had to be started.

- `verify-indexer.mjs` on v2: all checks passed (job 41).
- **Chaos at 20% failed twice, each time on a real defect:**
  1. The signer classified viem's `HttpRequestError` ("HTTP request failed.",
     503 on `.status`) as `INVALID_STATE` — no `retryAfter` — so the worker
     fixes of `c781ea8` never engaged: one worker gave up an accept, another
     its finished work at submit. Now 5xx/429 on the error chain is a
     retryable outage (`e5023d5`).
  2. With accepts retrying, one landed after the 45 s accept window; the
     cancel was refused (`InvalidState`) and the orchestrator reported the
     step failed while the worker delivered seconds later. It now waits for
     the delivery; a failed wait is still never re-hired (`77620fe`).
  Each fix's test failed on the old code first. 471 backend tests.
- Third run 4/4 — but not one broadcast had failed in it (reads are most of
  the traffic, and viem retries those itself), so it proved nothing about
  fix 1. `slow-rpc.mjs` gained `SLOW_RPC_FAIL_SEND` (`942b106`); at 30% on
  broadcasts (25/78 failed) a submit hit a 503, retried, and 4/4 settled.
- Cost: the chaos runs took DEPLOYER to 0.018 MON; you topped it up.

**Then, on "complete the full product first":**
- **Deploy-ready from one repo** (`e2ba821`). A Railway build clones one repo
  and could not have built: the Dockerfile read chain facts from a sibling
  checkout. They now live in `chain/` (13 JSON files, byte-exact, CI
  `--check`s drift); `deploy/railway/*.json`; runbook `docs/13-deploy.md`;
  `scripts/check-deployment.mjs`. Rehearsed on the production images — see
  Testing. The contracts' DEPLOYMENT.md gained the sync step (`dad98cf`).
- **M5-06** — the first three timed runs went 2/3: the indexer projected an
  older `JobAccepted` over the API's `submitted`, and approve was refused.
  Projection is now forward-only, same-state writes still land the fee
  (`0044e77`; a first version dropped the fee and its test caught it). Then
  3/3 clean: 149, 153, 168 s. `verify-indexer.mjs` re-run: passed.
- **Screenshots** refreshed from a real v2 run through `POST /v1/runs`
  (`599154a` in the interface).

### Session 26 — 2026-09-30 (industrial-standard hardening · contracts v2 · everything re-verified live)

**Instruction:** plan mode, then "fix all with industrial standards". Your
calls: redeploy v2; reads stay public with unguessable ids; AGENT_A/B testnet
MON may fund the work.

**Contracts v2** (`c66090c`, `9fa7d8d`, `3370074`, `dfb7c3c`) — tests first;
14 new tests failed on v1. `SameOwner`, `minJobAmount`, fee floor; payouts
that cannot be delivered are held in `owed` and claimable; `expireDispute`
(outcome `UNRESOLVED`, no feedback, so "dispute and wait out the arbiter"
earns nothing); windows captured per job; `AccessControlDefaultAdminRules`;
StakeVault slashes to a recipient and gains `cancelWithdraw`; AgentAccount
per-(target, selector) allowlist with forbidden approve-style selectors,
`sweepNative`, two-step ownership; the factory only lets an owner create
theirs. 184 tests, three invariant suites, solhint + Slither + coverage floor
in CI. Redeployed to 10143 (start block 66905096).

**Backend** (`5ff70f5` … `c781ea8`):
- Fixed, each with a test that failed first: the signer lock that could stay
  held forever; O(keys) scrypt auth (now `ax_<keyId>_<secret>`, SHA-256, one
  indexed lookup, IP rate limit before auth); enumerable job/run ids (uuid
  `public_id`); the signer timeout reported as `INSUFFICIENT_FUNDS`; SSE
  headers held for 25 s; the indexer halting on an RPC 503; drizzle 0.45
  turning 23505 into 500.
- v2 adaptations: keeper sends `expireDispute`; indexer records
  `DisputeExpired` / `PaymentDeferred` and gives an unresolved dispute no
  reputation; `minJobAmount` checked before submitting.
- Standards: `@agentx/service` (env validation, logging with redaction,
  request ids, `/ready`, `/metrics`, graceful shutdown) in every service;
  helmet; ESLint + Prettier; typed tests; coverage floors; Dockerfile and a
  full-stack compose (verified: migrations, healthy, non-root, SIGTERM in
  745 ms); CI with audit, gitleaks, CodeQL, Dependabot.

**Interface** (`78ceaee`, `0b1dc8d`, `85b934d`, and the screenshot commit) —
see Complete status. The smoke test found that a root `loading.tsx` made
every `notFound()` a 200.

**Live on v2 — three more defects found by running it:**
1. The demo registered each worker's AGENTX record with DEPLOYER as owner;
   the API (correctly) refused it once workers owned their identities
   (`01f1b71`).
2. `keeper-sweep` called a correct dispute expiry a failure (`7502d1f`).
3. Under a lossy RPC a failed submit was silent, and the worker then tried to
   accept its own job again and abandoned it (`c781ea8`).

**Timing.** The v2 cached replay takes 232–265 s: 58 s of setup
transactions, then ~45 s per hire cycle, ~24 s of it replayed model latency,
and the new recording plans four steps, not three. `AGENT_REPLAY_MAX_MS`
(`6cf2a86`) brings it to 162 s without re-recording.

**MON:** 6 each moved AGENT_A → DEPLOYER and AGENT_B → FUNDER. Balances after Session 27: see Next actions.

### Session 25 — 2026-09-30 (worker AgentAccounts · x402 · ERC-8183 mapping · Gemini diagnosed)

**Resumed after a closed terminal.** Session 24 had finished and pushed;
nothing was lost. Instruction: plan mode, then "complete all" — worker
accounts, x402, the ERC-8183 mapping, deep testing, and Gemini tried alongside
Ollama. Repos stay private and the arbiter stays on DEPLOYER (both your call).
128 + 401 + 7 = **536 tests green**; every test guarding a fix failed on the
old code first.

**Worker `AgentAccount`s.** Each worker gets an account with zero caps, the
escrow as its only target and `acceptJob` / `submitResult` as its only
selectors, and a session key (budget 0) for its OWN key. Live: 2/2 steps
settled through them; the owner swept 0.0891 MockUSDC of earnings out. As a
stolen worker key (eth_call on testnet), the account itself refused a USDC
transfer (`TargetNotAllowed`), a hire (`SelectorNotAllowed`) and a sweep
(`NotOwner`). A signer test pins that the key used is the one THIS account
granted, not the first key held.

**x402 (M3-14/15).** Scheme `agentx-directpay`: the client settles first
(`POST /v1/x402/settle`, a `directPay` through the hire code path); the worker
redeems the receipt once (`/redeem`, migration `0003`), checked against a
`DirectPaid` event from our own escrow. `serveX402` gives a worker a paid HTTP
endpoint; the job loop skips x402 jobs; `payX402` in the SDK. Live:
402 → paid tx `0x04ad1fe9…` → served → DirectPaid on chain → replay refused
`already_redeemed`. 25 new tests.

**ERC-8183** — [docs/12](https://github.com/gopaltalaviya/agentx-docs/blob/master/docs/12-erc8183-mapping.md), from the spec text: its
prose and reference disagree in ~8 places; the two designs bet oppositely on
silence after delivery; conformance is a new kernel with AGENTX as evaluator +
hook, after the deadline.

**Gemini, tried as asked.** The key works; the default model had been retired
(404) — very likely Session 23's failures too. Moved to `gemini-3.8-flash`,
key in a header rather than the URL. It then planned well and answered 503
"high demand" twice; stopped there. The video recording is Ollama's: live
268 s, cached replay **150 s**.

**Found live and fixed** — each would have hit the video or a judge:
- the orchestrator offered its own capability to the planner and tried to
  hire itself (mid-job chaos run);
- a model outage while choosing an agent aborted the whole run (Gemini 503);
- why a plan failed was thrown away — every cause read "could not reach a model";
- the demo reused a CREATE2 salt after an aborted run, so `createAccount` reverted;
- the demo harness died on one dropped broadcast; it now re-sends the same
  signed bytes (slow-RPC chaos);
- the run page had no SSE listener for the new `plan-failed` event.

**The `meta.test.ts` flake is not ours.** Caught once in 15 looped runs as
`EADDRINUSE 127.0.0.1:5442`: an unrelated local process had
exhausted Windows' ephemeral ports. No code change; recorded under gotchas.

**Chaos, re-run live with worker accounts:** no-accept ✅, silent-after-accept ✅
(chain job 149 held to its deadline, then `expireUndelivered` → REFUNDED, tx `0x799bf1d6…`), slow lossy RPC ✅ (544 s).
e2e (EOA path) ✅. Drift: none. Full-history secret scan: clean.

**Cost.** A run is now ~0.5 testnet MON; 3 MON moved FUNDER → DEPLOYER
(`0xbdf271b3…`). DEPLOYER ~0.36, FUNDER ~3.05 afterwards.

### Session 24 — 2026-09-29 (orchestrator on AgentAccount · 7/7 chaos · reorgs · run history)

**Shipped** — backend `607eddf` `a8eb45d` `36cfb8a` `e54e03f` `87d3ef1`
`ef44e6e` (and this entry) · interface `48f2e20`. 128 + 363 + 7 =
**498 tests green**. Every new test failed on the old code first.

**The on-chain cap claim is now fact, for the agent that spends.** The
orchestrator pays through an `AgentAccount` the owner (DEPLOYER, standing in
for a human) creates each run: 0.1 per task, 1 per day, allowlisted to the
escrow's five client functions, an owner-granted allowance, and a session
key for the signer's hot key under a day long. The signer detects an account
wallet on every call and sends `execute(target, data)` to it. Live: 3/3
settled, the account's own `spentToday` 0.13. **As a compromised signer
holding that session key** (`eth_call`, no gas): a 0.2 hire →
`PerTaskCapExceeded(200000, 100000)`; USDC to `0xdEaD` →
`TargetNotAllowed(token)`; a self-granted allowance → `NotOwner()`. Not
covered, and said so everywhere: payees within the escrow, the three worker
EOAs, and the deployer standing in for the human owner.

**Found on the way** — Monad reserves the full gas LIMIT (~0.054 MON per
wrapped call), so the hot key gets 0.5 MON and top-ups now come from FUNDER,
not DEPLOYER (down to 1.25 MON from 6.8 this morning); the node's "Signer
had insufficient balance" was reported as "RPC unreachable" because `503`
matched inside the tx hex — classification now reads only the node's words,
and the raw error is finally logged; a failed broadcast's nonce claim
blocked every later request as "in flight" — released when the chain's
pending count proves the nonce unused.

**Chaos 7/7** — `scripts/slow-rpc.mjs` puts a slow, lossy link under
everything: 600–1800 ms + 5% failures passed in 287 s; 1500–4000 ms + 15%
failures in 464 s. Nothing assumed a fast network.

**Reorgs** — a re-mined settlement (same tx, new logIndex) was credited
twice; now deduplicated by (tx, job, kind). A dropped one was kept forever;
`job_events` is append-only by design, so the indexer now checks every
receipt in the rewind window and halts, naming the orphans, rather than
indexing on state the chain no longer backs.

**Run history** — `/runs` and `/runs/[id]`. `DEMO_VIA_API=1` runs the demo
through `POST /v1/runs`; the first live run through it settled 3/3 via the
AgentAccount and is what the screenshot shows.

**Cold start additions** — `DEMO_VIA_API=1`; the demo needs FUNDER in the
env for top-ups (it has 9+ MON); `scripts/slow-rpc.mjs` for network chaos.

### Session 23 — 2026-09-29 ("complete everything": keeper, retry, caps, chaos, deck, interface)

**Shipped** — backend `fe36586`…`0fa27bc` (and this entry) · contracts
`ed75feb` · interface `c78e4e3` `dbc8645`. 128 + 351 + 7 = **486 tests green**.
Every new test was run against the code before its fix and seen to fail.

The instruction was to finish everything that is Claude's to finish. A docs
audit of 01–04 and 07 (run as a background agent) came back with fifteen
places the code did not do what the docs said; each was verified before
acting. Live runs, chaos runs and the first browser render found more.

**The ones that change what the project can claim**

- **Spending caps were enforced nowhere.** Every agent is a plain EOA; the
  signer read the caps from `AgentAccount`, every read failed on an address
  with no code, and failure meant "no cap". The headline claim — a hijacked
  agent cannot spend past its daily cap — held for a contract nobody used.
  The signer now enforces `spend_policies` for EOAs (atomic check-and-reserve
  under the per-agent lock, rolling 24 h, released on failed broadcast,
  fail-closed). Every doc, the deck and the submission now say *signer*, not
  *on chain*. That bounds a hijacked agent, not a compromised signer.
- **Nothing ever sent the escrow's permissionless exits.** The keeper does
  now, inside the signer on its own key. **Proven live:** chain jobs 94, 99,
  104 and 108, stranded by the mid-job chaos runs, each went `ACCEPTED` →
  `expireUndelivered` → `REFUNDED` (tx for 94: `0xd57ada26…`).
- **Agents registered through the API or `/register` could never be hired** —
  nothing set `chain_agent_id`. Registration now carries it, verified against
  the identity registry (owner and payout wallet).
- **A retried hire inserted a phantom job** each time. Now idempotent at the
  job level (migration `0002`).
- **The indexer linked by spec hash alone**, and credited a worker for an old
  run's payment. Linking now checks both parties. Refunds only count against
  a worker for `undelivered` and a lost `dispute`; `payments.tx_hash` is real;
  the confidence floor is read per chain.
- **The API sent no CORS headers.** The first time the interface was opened in
  a browser, every page said "API unreachable". Fixed; the four pages are
  screenshotted in `agentx-interface/docs/screenshots/`.
- `fastPathMinScore` is enforced (so the demo is now all-escrow); the signer
  has a token and binds loopback without one; auth errors are 401/403; the
  budget respects the 24 h rollover; `make drift` exists and reports no drift;
  `Deploy.s.sol` honours `ARBITER_ADDRESS` / `FEE_RECIPIENT`.

**Agents.** A silent worker is retried once with another agent: an offer
unaccepted after 45 s is cancelled (immediate refund) and re-hired; an
accepted job that never arrives is abandoned at the step timeout. The Worker
no longer abandons a job the API told it to retry. `pnpm demo` now fails on
any `failed`/`timeout` step; per-step timeout 180 s for a local model.

**Live evidence (Monad testnet, llama3 8B)** — no-accept chaos: pass, chain
job 85 cancelled → REFUNDED, step re-hired and settled. Mid-job chaos: pass
(after two runs that exposed the Worker-retry and gas-top-up defects). e2e:
pass, one job row after a replay, linked to its own chain job. Fresh
recording: 3/3 settled; cached replay identical in 157 s; earlier rehearsals
155 / 109 / 111 s.

**Deck.** A demo slide from the real run (hire and settle hashes, both chaos
results, the keeper refund), claims corrected, and — first time ever —
rendered through PowerPoint over COM and every slide inspected. Status
workbook rebuilt from real per-file counts.

**⚠️ Disclosure — Gemini.** `agentx-contracts/.env` contains a
`GEMINI_API_KEY`. Two early record runs this session loaded that file and set
`BRAIN_CHAIN=ollama`, not knowing the orchestrator reads
`BRAIN_CHAIN_ORCHESTRATOR`. So the orchestrator's chain tried Claude (no key),
then **Gemini**, then fell back to Ollama. Every recorded answer came from
Ollama, so no Gemini request succeeded — but requests were sent, which the
standing rule says to ask about first. Not repeated: every run since unsets
the key and pins both chains. Why they failed (invalid key, quota, rate
limit) was not checked, because checking means calling it again.

**Mistakes of my own, recorded so they are not repeated.** Running the test
suites while a demo used the same database truncated its tables mid-run (one
chaos run wasted). Two heredoc edits wrote a NUL and a BEL byte into files;
both caught and fixed before commit. The Chrome extension disconnected
mid-check; headless Chrome from PowerShell did the rendering instead.

**Still open** — phone-hotspot chaos item; demo agents onto `AgentAccount`;
reorg deletion; DISPUTED has no timeout (contract; documented); the
`meta.test.ts` flake has not recurred in eight full runs.

### Session 22 — 2026-09-29 (the loop runs end to end · 16 defects on the live path)

**Shipped** — backend `240e239` `fe5a577` `a169c15` `f118e50` `67afd7c` ·
contracts `0865996`. 128 + 292 + 7 = **427 tests green**.

(Session 21, 2026-09-28, shipped the local `.pptx` deck, `docs/11-submission.md`,
the status workbook and signer/DB/AgentAccount tests; it has no entry of its
own — its commits say what it did.)

**B6 cleared without a hosted key.** Ollama was already on this machine with
`llama3` 8B, which costs no API quota, so the live path finally ran. It had
never once settled a job. Sixteen defects on the orchestrator → worker →
judge → settle path, **none caught by the ~270 tests passing at the time**;
each fix has a test confirmed failing against the old code first. The full
list is in the commit bodies; the ones worth remembering:

- **The demo truncated the indexer cursor**, so every run started 1.6M blocks
  behind at Monad's 100-block log cap. `.catch(() => {})` hid it for five runs.
- **Workers were registered to `0x1111…` addresses nobody holds a key to**,
  so every accept reverted `NotAgentWallet`, surfaced as "unknown reason".
- **A new agent had no spend policy**: the budget read zero and the
  orchestrator refused to hire, while the signer enforced nothing.
- **Fast-path jobs are `settled` at creation**, which workers, `submitResult`
  and `awaitResult` each misread in a different way.
- **The judge's numeric score** came back on three different scales from one
  model; read as percentages, good work was disputed and the worker's
  reputation took the hit. Now a word — poor … excellent — and the number is
  derived from it.
- **A worker whose model was down reported every job as a considered
  decline.** Now a `failed` outcome at stage `triage`.
- **Recorders sharing one cache file erased each other.** A cached replay of
  a run that settled 3/3 jobs settled 1/3 — and `pnpm demo` still said
  *passed*. Fixed; a clean re-record then replayed identically on chain (same
  plan, same verdicts, same 0.0693 MockUSDC paid).

**Also cleaned up:** debug code from earlier in the day that wrote every
cache miss into `./artifacts/` from inside the library.

**Open, not chased blind:** `apps/api/test/meta.test.ts > GET /v1/network >
answers without credentials` failed once in five full-suite runs and never in
isolation. The failing run's output was not kept. Session 20's flake turned
out to be a real race, so the next occurrence needs its message recorded
before anything else.

**Pushing:** backend was left one commit ahead of `origin` by the earlier
part of the session; pushed with this entry.

**Next** — the two live chaos items, timed rehearsals and the backup video,
the real run into the deck and submission doc. You: a hosted key is now a
quality upgrade rather than a blocker.

### Session 20 — 2026-09-28 (docs 05/08 audit · a real race · CI · interface tests)

**Shipped** — backend `1e9cf70` · contracts `cbe7668` · interface `7bd3dc2`.
179 + 120 + 7 = **306 tests green**.

Three days idle. Nothing had changed: repos clean, `.env` still absent, so
`pnpm demo` remains blocked. **15 days to the deadline.**

**🔴 A flaky test was a real race.** One failure in four full suite runs:
`runs.test.ts > the trace > survives the run and is readable afterwards`. The
run row was set to `done` *before* the terminal `finished` event was recorded,
so anything reading the trace in that window got a story missing its ending —
the demo page, the SDK, anything polling `state`. The failure path had the same
ordering. Both now emit the terminal event first: state means complete, so
everything must be complete before it is set. Hammered after: 6 consecutive
runs of that file, 3 full suites, all green.

Rare is what made it dangerous — the kind of intermittent failure that gets
re-run until green and forgotten.

**docs/08 audit — `.env.example` was wrong in both directions**

- **Eight variables the code reads were undocumented**, including
  `AGENTX_API_KEY`, `AGENTX_API_URL` and `AGENTX_CHAIN_ID`. Without those
  nothing in `apps/agents/` starts, so anyone following the file could not
  have run a worker at all.
- **`API_JWT_SECRET`** implies a JWT mechanism that exists nowhere — auth is
  scrypt-hashed API keys. Removed.
- **`REDIS_URL` pointed at a Redis nothing imports.** No client, no
  dependency, and a compose service that would have become a paid Railway
  plugin connected to nothing. Removed, and what it was provisioned for is now
  written down as the limitation it is: rate limiting is per-process, so N
  replicas means N times the configured limit. Idempotency is unaffected — a
  `UNIQUE` constraint in Postgres, not an in-memory set.

One near-miss worth recording: `RPC_URL_10143` looked unused too, because it
is built as a template literal — `env[\`RPC_URL_${chainId}\`]`. A string grep
cannot see it. Checked before reporting.

**🟠 Contracts are NOT verified on the explorer.** An M1 done-condition that
was never met: `EXPLORER_API_KEY` is empty, so a judge following an explorer
link today sees bytecode, not source.

Chasing it found a config defect: every `[etherscan]` entry is validated when
forge starts, whichever verifier a command asks for, and ours had a key and a
chain id but no `url` — so **every** `forge verify-contract` failed with "No
known Etherscan API URL for chain 143", including ones explicitly passing
`--verifier sourcify`. Fixed. Sourcify does support Monad Testnet (confirmed
against its chain list), but forge's sourcify flow still reads the ABI from the
block explorer first, which needs a real key. **Yours to obtain.**

**Added:** interface tests — it had none. `formatUnits` is the only
money-handling code there, and the case that matters asserts exactness past
2^53, since a uint128 amount is far larger than a JS number can hold. Wired
into CI.

**docs/05** now carries a banner saying it is the plan as written, not the
record, and names the three things that turned out differently.

**Later the same day — research refresh and the deck.**

- **docs/09 §10** added: the published ERC-8004 study (Xiong et al. 2026) and
  ERC-8183 Agentic Commerce. Both change the pitch; see the decisions log.
- **Submission deck drafted** — 10 slides, at
  `https://claude.ai/artifact/MGoyMNdeQoYViNRGCCZS3a`. **Private**: judges
  cannot open it until you share it from the page's Share menu.

  Order: cover · the measured problem · the idea in one line · the four steps ·
  what is live on chain · the injection risk · the bounded claim · where it
  sits among the standards · what it does not solve · close with repo links.

  Two things it deliberately does not have yet: **a demo slide** (nothing has
  run end to end, and a screenshot of an unrun demo would be a lie) and any
  figure from a live run. Both land the moment the model key does.

**Next**

- You: the model key; an explorer API key if you want verified source; and
  share the deck if you want anyone else to see it.
- Me: the demo slide and real figures once the key lands; docs 01–04 and 07
  still unaudited.

### Session 19 — 2026-09-25 (full recheck · CI · doc 06 audit)

**Shipped** — backend `3c6c8fd`, `d443c3c` · interface CI. 179 tests green.

**The full recheck.** Repos clean and matching their remotes, 120 + 179 tests
green, interface builds, secret scans clean, config integrity OK, all seven
contracts confirmed to have code on-chain, `MAX_SESSION_KEY_TTL` reading 86400
live, `PROGRESS.md` addresses matching `deployments.json`, board sums matching
the header, doc links resolving, the interface↔API contract holding against a
live API, and `pnpm demo` correctly refusing to spend without a model.

**🔴 The live-chain check was lying in three ways.** `verify-indexer.mjs`:

- Its `specHash` was a **constant**, so every run ever made emitted the same
  hash on-chain and the indexer legitimately linked a fresh row to an older
  run's payment. It reported "the linkage is broken" when the linkage was
  fine. Same defect the API fixed by scoping its hash to a job id.
- It replayed from the deployment block, now ~500k blocks behind head. With
  Monad's 100-block cap that is thousands of round trips, so it never reached
  the settlement it had just made. Cursor now seeded just behind it: 1 tick.
- **Worst: the catch-up line printed `✓` unconditionally.** A run that never
  caught up still reported success, then failed three assertions with a
  misleading cause. A check that can report success while failing is worse
  than no check.

Now genuinely green on live testnet: linked to on-chain job 7, settled,
reputation counted once, replay a no-op, reorg rewind clean.

My own verification tooling also lied twice in one session — the on-chain
code check reported all seven contracts missing because `cast` was eating the
loop's stdin and Python had written CRLF into the address list.

**Doc 06 audit — almost every convention it described was fiction**

| Claimed | Reality |
|---|---|
| `packages/` has shared + db | five: config, shared, db, sdk, agent-core |
| `railway.json`, `CHANGELOG.md`, ESLint config | none of them exist |
| `pnpm --filter api start` | matches nothing; the package is `@agentx/api` |
| `mcp` is a Railway service | it speaks stdio; hosting it needs a transport it lacks |
| branches + PRs required on main | 27 direct commits, no branches, no PRs |
| CI in every repo | only contracts had any |

`pnpm lint` was declared but no ESLint config or dependency ever existed, so
it failed on every invocation. Removed rather than left as a script that lies.

**Added CI** to backend and interface. The backend suite needs Postgres *and*
the contracts checkout — 6 of 13 test files read chain config from there — so
the cross-repo checkout is `continue-on-error` and the suite **skips rather
than fails** while that repo is private. A red badge meaning "the token is not
set yet" teaches everyone to ignore the badge, which is exactly the failure the
secret scanner had.

**Not verified:** the workflows have been pushed but never watched running —
no `gh` CLI here. YAML parses and the jobs are well-formed; that is all that
can be said from this machine.

**Next**

- You: the model key. Also worth a look: do the new CI runs pass on GitHub?
- Me: docs 05 and 08 drift audit, then the deck.

### Session 18 — 2026-09-25 (full status documentation pass)

No code changed. This session brought the file itself back into line with
reality, which it had drifted out of.

**Did**

- Rewrote the header, **Next actions** and **Blockers**. All three still
  described Session 13: "create 3 GitHub repos", "fund 4 wallets", a blocker
  cleared three days earlier. The file that says START HERE was the most
  out-of-date thing in the project.
- Added **📦 Complete status**, the rolled-up done/pending picture across
  development, setup, configuration and testing, with an owner on every
  outstanding item.
- Refreshed the deployed-contracts table with the real addresses, including
  the `AgentAccountFactory` redeploy, and the services table with what is
  actually running locally.
- Renamed the stale "Current milestone: M0" heading — M0 finished on Sep 22.
- Added **🔌 Cold start**: paths, the exact commands to get from nothing to
  green, how to run the stack locally, the eight environment traps that have
  each cost real time, the standing rules, and an explicit statement that no
  work is in flight. Every command in it was run and verified before it was
  written down.

**🔴 Found while writing it: the memory was not backed up — now fixed.**
`docs/`, `PLAN.md`, `PROGRESS.md` and `README.md` were in **no repository**.
Ten specification documents and the entire task plan existed in one folder, on
one machine, named `temp`. The code was safe on GitHub; the thinking behind it
was one `rm` away — and the notes are the part that cannot be reconstructed
from the code.

Your call: move them into `agentx-backend` (commit `d122adc`). They go public
with it by Oct 13, which the submission requires anyway, and a judge reading
the threat model or the defect log is a good outcome rather than a risk. No
fourth repository was created.

Moving rather than copying, because two copies of a source of truth drift —
which is the exact failure this project keeps finding. The root README became
`docs/00-overview.md`; a five-line signpost is all that remains at the old
level. Every cross-document link was rewritten and checked: **0 broken**. It
also fixed a real one — this repo's README linked `../docs/10-llm-architecture.md`,
which was broken on GitHub because the repo contained no `docs/`.

**Where things stand**

97 / 115 tasks, 299 tests green (120 contracts, 179 backend), all three repos
clean and pushed.

**The honest read.** Every layer is built and tested in isolation, and the
one thing that has never happened is the whole loop running with a real
model. That matters more than the task count: the last four defects — a
disputed-by-default settlement path, reputation an indexer restart could
manufacture, a burned idempotency key, a spec hash committed where a result
hash was claimed — all lived on that path and all passed their unit tests
first.

**Learned / changed**

- Auditing documentation against code is currently finding more real bugs
  than writing new code is. Three of the last five defects were found by
  reading a doc and checking whether the code agreed.
- Five mitigations in this project were written up before they were built.
  Table entries now carry the date they were checked against code.

**Next**

- You: the model key. Everything else outstanding is scheduling, not risk.
- Me: finish the docs drift audit (05, 06, 08), then the deck.

### Session 17 — 2026-09-24 (chaos checklist, key-free items)

**Shipped** — backend `7dd4bab`, `d55f341`. 167 backend tests green.

Two of the seven chaos items are closed, and the first one found a real bug.

**🔴 An indexer restart could manufacture reputation.** `job_events` and
`payments` were protected by unique keys; the reputation bump was not — it is
`completed + 1` and it ran whether or not the event was new. Replays are
*ordinary*: the cursor is written after a batch is processed, so any restart
mid-batch re-reads it, and every reorg deliberately rewinds 2x the
confirmation depth. So each replay credited the worker again with no payment
behind it, inflating the one number AGENTX claims only a settled payment can
write.

Fixed by making the event insert and its effects one transaction, with the
insert's own uniqueness deciding whether the body runs. Verified the old way:
4 of the 7 new tests fail without the change.

Also found in the same path: `payments.block_number` was hardcoded to 0 — a
payment row nobody could find again on the chain it came from.

**Indexer backoff.** The retry loop was a flat 2s forever. Against a
rate-limiting public RPC that turns a brief limit into a permanent one.
Now exponential, capped, ±20% jitter, instant recovery on first success,
escalating log level after five consecutive failures. Loop extracted with
time injected — 10 tests, milliseconds.

**Chaos checklist status**

| Item | State |
|---|---|
| kill worker mid-job → refund + retry | ⬜ needs a model |
| kill indexer 60s → no duplicate rows | ✅ **bug found and fixed** |
| daily cap → clean 402 | ✅ |
| malformed result → dispute, not crash | ✅ **refused at the boundary now** |
| RPC 500 for 30s → backoff, no stuck job | ✅ |
| phone hotspot | ⬜ needs a live run |
| out of MON → clear error | ✅ **bug found and fixed** |

**Learned / changed**

- My own test helper aborted *after* the call it expected to throw, so the
  loop spun for ten minutes before I noticed. Aborts belong in `finally`.

**Later the same day — the remaining key-free items** (backend `b6565f5`,
175 tests green). Two more gaps between documented and actual behaviour:

- **A malformed result was stored and signed for.** The route comment claimed
  validation against the spec's `outputSchema`; only the envelope was checked.
  A worker could deliver none of the requested fields, the API stored it, an
  on-chain `submitResult` went out, and the client found out by paying gas to
  dispute. Now refused before anything is submitted. `validateShape` moved to
  `@agentx/shared` — worker, orchestrator and API had been one copy away from
  three.
- **A failed broadcast burned the idempotency key forever.** The signer claimed
  a nonce row before sending; if the send threw (no gas, RPC down) the row sat
  `pending` with no hash and every retry was refused as "in flight". Topping
  the wallet up would not have helped — the opposite of the recovery the
  checklist asks for. The row is now marked `failed` and a retry reclaims it
  **reusing the stored nonce**, so if the original did reach the mempool only
  one of the two can ever be mined.
- Broadcast failures became actionable errors: an empty gas wallet names the
  address to fund; an unreachable RPC says nothing was broadcast, so retrying
  is safe.

**M6 groundwork the same day** — contracts `e3c5987`, `f-sync` · backend
`80aef80`.

- Both READMEs rewritten against what actually exists. The backend one still
  described the apps as "in progress"; the contracts one had no clickable
  deployment. Added the live addresses, the security properties as *tested
  properties* rather than adjectives, and an explicit "what is not solved".
- Root README status block replaced — it still said implementation was blocked
  on creating the repos and funding wallets.

**🟡 The secret scanner was crying wolf.** Its BIP-39 pattern was "twelve or
more short lowercase words", and writing the README tripped it on the sentence
*"bug in this project passed its unit tests and was caught only against the
real"*. The false positive matters less than what it teaches: a check that
fires on prose in every markdown file is one people learn to pass with
`--no-verify`, and the same hook guards the private keys that nearly reached a
tracked file in session 13. Now: exactly 12/15/18/21/24 lowercase words, alone
on a line or inside a quoted or assigned value. Verified both directions — real
mnemonics bare, in an env var and in JSON still flag; the prose does not.

**🔴 The docs pass found the worst bug yet** — backend `26cab0c`, 179 tests.

Auditing docs/04 §5 against the real routes, to fix the documentation, turned
up a defect that would have broken the demo's main path in front of judges.

`result` means the worker's **output** everywhere it is read — the worker
checks its output against the job's `outputSchema`, the API checks the same on
submission, the orchestrator checks it again before paying. The API stored the
whole envelope `{output, producedAt}` under that name. So a perfect delivery
came back with none of the requested fields at the top level, failed the
orchestrator's required-field check, and was **disputed**. Every escrow job
with an `outputSchema` — which is every job the orchestrator creates — would
have been refused payment.

The existing lifecycle test asserted `job.result.output.summary`. It encoded
the envelope shape instead of questioning it, which is part of why this
survived: **the test agreed with the bug.**

Two more in the same three lines:

- `resultHash` hashed the envelope, so identical content delivered twice
  produced different commitments because `producedAt` differed.
- The on-chain commitment was never the result hash. The encoder falls back to
  the spec hash when none is supplied and nothing supplied one, so the chain
  committed to **what was asked for** rather than to what was delivered —
  T4's claim was not true. Now computed before the transaction and passed
  through.

Also: the Postgres 23505 handler reported "an agent already exists for that
wallet" for *every* unique violation. A duplicate on-chain job id reported as
a duplicate wallet sends whoever is reading to the wrong table — it cost me
exactly that here. It now names the constraint that fired.

Docs 04 §5 corrected: the staking endpoint never existed (owners bond via
`StakeVault.deposit` directly — the API has no custody), `/v1/agents/{id}/jobs`
is really `/v1/jobs?role=`, the result body is `{output, producedAt}`, and the
network/budget/runs/health endpoints were entirely undocumented.

**Next**

- You: a free model key in `agentx-backend/.env`. The three remaining chaos
  items and the backup video all need a live run.
- Me: finish the docs drift pass (05, 06, 08 still unaudited), then the deck.

### Session 16 — 2026-09-23 (register page · security pass T1–T17)

**Shipped** — contracts `056c8e4` · backend `fd44e25`, `409b556` · interface `4eabe95`

- [M4] Register-an-agent page: ERC-8004 identity on-chain first, then the
  AGENTX record, then the key shown once.
- `/v1/network` now states the registry ABI variant and the public RPC list.
- [M5] Security pass of the full threat table against the code.

120 contract tests · 150 backend tests · interface builds clean.

**The security pass, T1–T17.** Thirteen claims hold and are marked verified
with the date. Three did not:

- **T7 — session keys "expire in 24h" was not enforced.** `grantSessionKey`
  accepted any expiry, including `type(uint64).max`. Fixed in the contract:
  `MAX_SESSION_KEY_TTL = 1 days`, checked on grant, past expiries rejected.
  `AgentAccountFactory` redeployed to
  `0x51F75C30563d260FafF7dAB42ACf9fA57B82315D`; ceiling confirmed live.
  TaskEscrow and StakeVault do not reference the factory, so nothing else
  moved and no AgentAccount instances existed.
- **T15 — claimed an SSRF guard that never existed.** Nothing fetches
  `metadata_uri` or `endpoint_url`, so the threat does not apply as built —
  a stronger position than the one claimed, but a guard described as present
  is how the next person adds a fetch believing they are covered. The schema
  columns now say so where someone would look.
- **T8 / T12 — mechanisms described imprecisely.** The signer dedupes on the
  Idempotency-Key it is given, not on `hash(agentId, specHash, worker)`; and
  there is one governance-set payment token, not an allowlist.

**Decided**

- **The contract enforces the bound rather than the doc describing it.** A
  time limit that depends on the caller passing the right number is not a
  control. Redeploying was cheap because the factory is standalone.
- **Registration is identity-first.** The API leaves `chainAgentId` NULL until
  an indexer confirms, and a hire is refused until both sides are known — so
  creating the record first hands someone a working key for an agent that
  quietly cannot be hired.
- **viem + injected wallet, not wagmi/RainbowKit.** RainbowKit needs a
  WalletConnect project id: another account to create and another key to keep
  alive days before a deadline. Trade-off stated in the README — injected
  wallets only.
- **`/v1/network` publishes the PUBLIC rpc list**, never the resolved
  `chain.rpcUrl`, which `RPC_URL_<chainId>` may have replaced with a keyed
  endpoint. There is a test asserting a configured secret never appears.

**Learned / changed**

- Second time a mitigation was documented before it was built. The first
  (T12's balance-delta guard) was a real insolvency bug. Table entries now
  carry the date they were checked against code.

**Next**

- You: a free model key in `agentx-backend/.env` — still the only thing
  blocking `pnpm demo`.
- Me: the remaining chaos-checklist items that need no model, then deploy.

**Open questions**

- The interface still has not been looked at in a browser.
- `AgentAccountFactory` changed address; anything holding the old one is
  pinned to a factory without the ceiling. Nothing does today.

### Session 15 — 2026-09-23 (runs API · the interface)

**Shipped** — backend `39f941f`, `1959423` · interface `98a0e72` (first commit)

- [M4-06] Live demo page, built first. One box, then the trace: plan, hire,
  judge, settle — with an explorer link on every on-chain line.
- [M4] Marketplace with the four ranking modes; agent profile.
- New API: `POST /v1/runs`, `GET /v1/runs`, `/v1/runs/:id`, `/v1/runs/:id/events`
  (SSE), backed by `runs` + `run_events` tables.
- `pnpm check:contract` in the interface, verified against live testnet.

148 backend tests green; interface `tsc --noEmit` and `next build` clean.

**Decided**

- **Runs are persisted, not held in memory.** The demo page is the submission
  video: a run that vanishes on refresh cannot be re-watched, re-recorded, or
  shown to a judge who arrived late. Every event is written before it is
  published — the row is the record, the stream is a view of it.
- **Reading a run needs no key; starting one does.** The trace is the thing
  being demonstrated.
- **The run carries the caller's API key**, because the orchestrator acts as
  that agent and must spend under that agent's on-chain caps.
- **Runs execute inside the API process**, with the executor injected. A
  separate runner service would add a queue and a second deployment between
  the page and the thing it is showing — three ways for the demo to break, to
  avoid a scaling problem it does not have. The seam is explicit so that stays
  a choice.
- **`lib/api.ts` is a deliberate copy**, not an import of `@agentx/sdk`:
  importing across the repo line would mean publishing the SDK or giving a
  Vercel build a key to a private repo. The drift guard is
  `check-api-contract.mjs`, which asks a running API rather than trusting the
  copy.

**Learned / changed**

- Node's `fetch` keeps a socket pool, and on Windows a script aborts during
  teardown with a libuv assertion (0xC0000409 → shell exit 127). A contract
  check where every assertion passed was exiting non-zero and would have read
  in CI as a permanent failure. Rewritten on `node:http`. Worth remembering
  for any other script whose exit code is load-bearing.
- The event bus was keyed by a bare number. Adding runs would have delivered
  job 7's events to run 7's subscribers; now one bus instance per kind.

**Next**

- You: a free model key in `agentx-backend/.env` (`GEMINI_API_KEY` or
  `GROQ_API_KEY`). Still the only thing blocking the first `pnpm demo`.
- Me: register-an-agent page (wagmi), then the M5 hardening pass.

**Open questions**

- The interface has not been looked at in a browser — routes return 200 and
  the API contract holds, but nothing has verified how it RENDERS. Needs a
  visual pass before the video.
- Workers still have no on-chain decline; a declined offer expires into a
  refund. Correct, but slow to watch on stage.

### Session 14 — 2026-09-23 (LLM architecture · MCP · workers · orchestrator)

**M3 is code-complete except the live run.** `pnpm demo` exists and gates on
a reachable model before it writes anything to the chain.

**Shipped** — backend `618edf4`, `51c7eb9`, `ac3db60`, `fc3d752`

- [M3-02/03/04] `apps/mcp` — eight tools over MCP, tested through a real
  in-memory MCP session (23 tests), not just as data.
- [M3-05..08] `Worker` base + `research-bot`, `trading-bot`, `execution-bot`.
- [M3-09/10/11] `Orchestrator` with every failure branch, 18 tests.
- [M3-12] `pnpm demo`.
- New API: `GET /v1/network`, `GET /v1/budget`, `GET /v1/jobs`.
- `docs/10-llm-architecture.md`.

137 backend tests green, tsc clean.

**Decided**

- **The honest injection claim.** "We do not prevent prompt injection. A
  successful injection cannot spend more than the on-chain daily cap or pay a
  non-allowlisted address." Layer 4 is arithmetic; everything above it is
  mitigation. Keyword filtering is deliberately absent — it fails to
  paraphrase while manufacturing the appearance of safety.
- **Frozen system prompts.** A prompt cache is a prefix match, so one
  interpolated value invalidates every call. Dynamic context goes in the user
  turn. Enforced by a test.
- **Judging failure pays nobody and disputes nobody.** Our outage must not
  become the worker's problem, and must not buy them an unearned settlement.
  The review window expiring in their favour is the only neutral option.
- **BUDGET_EXCEEDED is not retryable** even though it carries a reset time. A
  cap is a decision the owner made; an agent should report hitting it, not
  sleep for a day.

**Learned / changed**

- Three tools in the spec had no endpoint behind them (`my_budget`,
  `get_network`, and a worker's ability to learn it was hired at all). Writing
  the MCP layer is what surfaced it — the spec had been read as implemented.
- `resetsInSeconds` was nearly wrong: `AgentAccount` rolls 24h from `dayStart`,
  not UTC midnight. The signer's existing `Retry-After` uses midnight and is
  the same mistake, still open (see below).
- A test file imported for a fixture re-runs its whole suite. Fixtures moved
  out of `.test.ts`.

**Next**

- You: a free model key in `agentx-backend/.env` — `GEMINI_API_KEY` (no card)
  or `GROQ_API_KEY`. It blocks the first `pnpm demo`, which is M3's done
  condition and the M5 backup video.
- Me: M4 once the demo has run — live demo page first.

**Open questions**

- `apps/signer/src/signer.ts` reports `Retry-After` for BUDGET_EXCEEDED from
  UTC midnight, but the contract's window is rolling. Small, worth fixing
  before M5.
- Workers have no on-chain "decline"; a declined offer simply expires into a
  refund. Correct, but slow to watch. Consider whether the demo should show it.

### Session 13 — 2026-09-23 (API · testnet deploy · adversarial pass)

**AGENTX is live on Monad testnet.** Escrow
`0x1B0959Dfd32323E5a4749D5444C2E6435349027c`, startBlock 65027889.

**Shipped** — contracts `b66ec5a` · backend `28d05eb`, `a12788f`, `b417024`

Fastify API (auth, discovery + ranking, job lifecycle, SSE, RFC 7807), the
testnet deployment, and an adversarial review that found five real defects.

**The five defects — four would have broken the live demo**

| # | Defect | Why it mattered |
|---|---|---|
| 19 | **Fee-on-transfer token broke solvency.** Escrow held 49,500 against a 50,000 job while `lockedTotal` counted the full amount | Invariant I1 broken — real insolvency, surfacing only when the last worker could not be paid. **T12 claimed this was already guarded. It was not.** |
| 20 | **`DirectPaid` carried no `specHash`** | The fast path was unlinkable, so every fast-path payment was dropped as "unknown job". The demo's *first* hire is a fast-path payment |
| 21 | Job could be created for an agent with a **zero payout wallet** | Client's money taken, settleable only by refund, worker's effort wasted |
| 22 | **`eth_getLogs` capped at 100 blocks on Monad**; hardcoded 2000 | An outright RPC error, not a slow query |
| 23 | API never advanced `jobs.state`; zod rejections returned 500 | Every second transition 409'd; agents could not tell "I sent nonsense" from "the server broke" |

**The lesson worth writing down**

Every one of these passed the unit tests. The API mock returned a
`chainJobId`, so 24/24 tests went green while the real pipeline was completely
inert. **Mocks agreed with my assumptions, so they confirmed them. The chain
did not.**

**Verified on the live chain, not simulated**

```
✓ directPay settled as job 1 in block 65027979
✓ indexer linked the job to on-chain id 1 via specHash
✓ job projected to state "settled"
✓ reputation: completed=1 failed=0 score=50
✓ replay is a no-op · reorg rewind clean
```

114/114 contracts (CI profile, 10k fuzz) · 100% branches on `TaskEscrow` and
`StakeVault` · 32/32 backend · 15 new adversarial tests.

**Security**
- Four testnet keys were pasted into `.env.example`, which is **tracked**.
  Caught in the working tree, never committed, never pushed, moved to `.env`.
  It survived on timing alone — my `git add -A` would have staged it.
- `check-no-secrets.mjs` now runs as a **pre-commit hook** in both repos and
  first in CI. Negative-tested.

**Next**
- `e2e.sh` through the full API stack on testnet, then M3 (MCP + agents)
- You: Anthropic API key with a spend cap, before M3

---

### Session 12 — 2026-09-23 (M2: signer)

**Shipped** — `agentx-backend` `e92d6de`

The signer holds every key and does nothing else. On Railway it binds to
private networking only — an unauthenticated signing endpoint on the public
internet is not a risk worth taking.

Order of checks, cheapest first: idempotency replay → policy (read from the
*contract*, not our cache) → gas floor → nonce under a **Postgres advisory
lock**. An in-process mutex would not survive the second replica Railway will
happily give us. The `signer_txs` row is claimed *before* broadcasting, so a
crash in between leaves a visible pending row rather than an untracked
in-flight transaction.

**C1 implemented**: encrypted keystore in env, behind a `KeySource` interface
so KMS drops in later without touching call sites.

**Two bugs caught by testing against a keystore `cast wallet import` actually
produced**, rather than a hand-made fixture:

| # | Bug |
|---|---|
| 15 | `require` does not exist in an ESM module — the MAC path would have thrown on the first real key |
| 16 | **Node's `sha3-256` is not Keccak-256.** Different functions on the same sponge; using the former rejects *every* valid Ethereum keystore |

Bug 16 is the kind that only shows up when you feed real data in. A hand-made
fixture built with the same wrong assumption would have passed.

**Verified** (`pnpm verify:keystore`, self-contained — generates its own keystore)
- decrypts to the right key and address
- a wrong passphrase fails **loudly on the MAC**, rather than yielding a
  plausible-but-wrong key that would sign from an unfunded address
- per-agent maps resolve; an agent with no key gets `null`, never someone else's
- a keystore with no passphrase is rejected at boot

**Next**
- The Fastify API, then `e2e.sh` proving a hire settles end to end via curl
- You: 4 funded testnet wallet addresses

---

### Session 11 — 2026-09-23 (M2: indexer)

**Shipped** — contracts `63b6ed1` (ABI export) · backend `ddb58f0` (indexer)

The indexer is chain → Postgres, one worker per enabled chain, built around
being **re-runnable** (idempotency from the unique key, not from care) and
**reorg-aware** (the cursor stores the block hash; if the chain no longer
reports it, rewind and replay).

**`scripts/verify-indexer.mjs` drives anvil end to end and asserts on the
rows** — because unit tests cannot tell you whether the indexer decodes what
the contracts actually emit. It found three real bugs:

| # | Bug | Why it mattered |
|---|---|---|
| 12 | `REORG_DEPTH` hardcoded to 12 | A freshly started chain with 7 blocks indexed **nothing** — the safe head sat below block zero. Now derived from the network's declared `confirmations`: 1 local, 2 testnet, 5 mainnet |
| 13 | **Reputation double-counted on the fast path** | `directPay` emits `DirectPaid` *and* `JobSettled`; both bumped reputation, so every fast-path payment counted twice — inflating exactly the reputation this project claims is trustworthy |
| 14 | `createDb` opened a pool nothing closed | Scripts finished their work then hung forever, which looks identical to a deadlock. Added `closeDb` |

Bug 13 is the one that would have been embarrassing: the whole pitch is
"reputation you cannot fake", and the indexer was quietly doubling it.

**Verified**
```
settlement indexed          job_events: direct_paid, settled
job projected               state = "settled"
reputation                  completed=1 failed=0 score=50
one job is not perfect      score 50, volume damping working
replay across 3 ticks       no-op, 2 events before and after
corrupted cursor hash       rewind replayed, nothing duplicated
```

**Learned / changed**
- Two of my *test's* own bugs also surfaced: it raced the chain (the indexer
  correctly trails the head, so the settlement block was not yet safe), and it
  hardcoded `chainJobId = 1` while the escrow's counter persists across runs.
  Both now read real values instead of assuming them.
- Ports: another reminder that this machine is busy — 85 stray node processes
  accumulated from backgrounded builds during this session.

**Next**
- Signer (policy pre-check, nonce lock, idempotency, keystore per C1), then the API
- You: 4 funded testnet wallet addresses

---

### Session 10 — 2026-09-23 (M2: database layer)

**Shipped** — `agentx-backend` `e2cb899`

`@agentx/db`: Drizzle schema, generated migration, and a hand-written
constraints migration for what Drizzle cannot express.

**Every constraint tested by attempting the bad write** against a live
PostgreSQL 16 — not assumed from the DDL:

| Attempt | Result |
|---|---|
| Two agents sharing `chain_agent_id` on **different** chains | ✅ accepted — per-chain uniqueness works |
| The same pair on the **same** chain | ❌ `agents_chain_agent_uk` |
| Job with client on testnet, worker on mainnet | ❌ `jobs_worker_same_chain` |
| Self-dealing job | ❌ `no_self_dealing` |
| Capability `"Market Research"` | ❌ `capability_is_kebab_case` |
| Negative price · score 101 | ❌ both rejected |
| `UPDATE` / `DELETE` on `job_events` | ❌ append-only trigger |
| Replaying an already-indexed event | ❌ idempotency key |

That last pair is what makes the indexer safely re-runnable after a reorg:
replaying a block range becomes a no-op rather than a duplication.

**Learned / changed**
- **Port collisions with your other projects.** 6379, 6380 (other projects' Redis)
  and 5432 (a native Postgres shadowing `localhost`) were
  all taken. Moved to **5442 / 6381**. The Postgres one was the dangerous
  case: the container *appeared* healthy and bound the port, but `localhost`
  resolved to a different database — silently connecting to the wrong
  database is worse than failing to connect.
- `job_events` being append-only is now a **trigger**, not a convention. An
  audit log that the application can rewrite is not an audit log.

**Next**
- Indexer (chain → Postgres, reorg-safe), then signer, then the API
- You: 4 funded testnet wallet addresses

---

### Session 9 — 2026-09-23 (M1 contracts complete)

**Shipped** — `agentx-contracts` `bdfb924`

`AgentAccount` + `AgentAccountFactory`, and `Deploy.s.sol` wired for the whole
protocol. **All contracts are now written.**

**The design decision that matters**

Spend is measured as the **actual token balance delta** across the call, not
decoded from calldata. Calldata decoding has to know every function signature
it might meet and silently misreads anything new; a balance delta cannot be
fooled by an unfamiliar call.

For that to be sound, `approve` can never be allowlisted — a standing
allowance would move funds outside every cap. So allowances are granted by the
owner through `setAllowance`, outside `execute`, where no session key reaches
them. `setAllowedSelector` refuses to allowlist `approve` at all, which makes
the in-`execute` guard dead by construction; it stays, documented, for the day
someone relaxes that setter.

**Other choices worth keeping**
- A session key can revoke **itself**, so a signer detecting its own compromise
  can disarm without waiting for a human.
- ERC-1167 clones: an agent wallet is ~45 bytes of deployed code, and its
  address is CREATE2-deterministic so it can be funded *before* it exists.
  The owner is bound into the salt so nobody can front-run another's address.
- The daily window rolls *before* it is tested, so a stale day never blocks work.

**Verified end to end on anvil**

```
deploy → 6 contracts incl. ERC-8004 reference registries (absent on this chain)
       → write-deployment.mjs → deployments/31337.json with a resolved erc8004 block
       → @agentx/config loads every address, formats 0.03 MockUSDC correctly
```

- **99/99 tests pass**
- 100% branch coverage on `StakeVault` and `TaskEscrow`
- `AgentAccount` at 82% branches — the gap is the one intentionally-dead guard

**Learned / changed**
- My `AgentAccount` cap tests silently passed through the *escrow's*
  `fastPathMax` guard instead of the account's caps, because 100k > 30k. The
  revert selector in `CallFailed(0x77931ab9)` gave it away. Tests now raise the
  escrow ceiling so they probe what they claim to.
- `write-deployment.mjs` looked for `IdentityRegistry` but the reference
  contracts compile as `Mock*`, so the `erc8004` block came out empty. Caught
  by reading the generated file rather than trusting the script.

**Next**
- M2: Drizzle schema → indexer → signer → API
- You: 4 funded testnet wallet addresses (still the only blocker)

---

### Session 8 — 2026-09-23 (M1 core contracts)

**Shipped** — `agentx-contracts` `9259f4f`

| Contract | Notes |
|---|---|
| `TaskEscrow` | Full state machine, all three permissionless exits, disputes, fast path, and the `giveFeedback` call that is the entire thesis |
| `StakeVault` | Bonds per ERC-8004 `agentId`, withdrawal delay, slashing that reaches pending funds |
| `MockERC8004` | Identity + Reputation mirroring upstream behaviour, with `setShouldRevert` so I8 is actually provable |

**Verified**
- **79/79 tests pass** under the CI profile (10,000 fuzz runs)
- **100% branch coverage on both `StakeVault` and `TaskEscrow`**
- 6 invariants hold over **2,048 randomised calls each** — including
  `lockedTotal` never drifting from the sum of open jobs
- `forge fmt --check` clean; gas snapshot committed

**Design decisions worth keeping**
- `autoApprove` means a client cannot take a result and withhold payment by
  going quiet. Together with `expireUndelivered` (worker took the job, never
  delivered) every non-terminal state has a permissionless way out.
- `workDeadline` is absolute from creation, so a worker knows its real deadline
  *before* accepting rather than after.
- Requesting a stake withdrawal **immediately** un-lists the agent — an agent on
  its way out should stop receiving work at once, not after the cooldown.
- Slashing reaches `pending` funds, so requesting a withdrawal is not an escape
  hatch from being slashed.
- Windows are clamped (`maxAcceptWindow`/`maxWorkWindow`). Without that a client
  could set a 1000-year deadline and lock its own funds past any refund.

**Learned / changed**
- `via_ir` had to be enabled: ERC-8004's 11-argument `NewFeedback` event
  overflows the stack otherwise. Build cost measured at ~6s — acceptable.
- Three of my own test bugs, all caught before pushing:
  `vm.prank` is consumed by the *next* call, so `vault.grantRole(vault.SLASHER_ROLE(), …)`
  ran as the test contract, not `admin`; event data with dynamic strings does
  not put the last field in the last word (`abi.decode`, not assembly); and
  `getRoleMemberCount` needs `AccessControlEnumerable`.
- `--ir-minimum` coverage misattributes some lines under `via_ir` — but two of
  the four it flagged were genuine gaps (disputing a non-submitted job,
  resolving a non-disputed one). Worth reading rather than dismissing.

**Next**
- `AgentAccount` + factory (M1-10…M1-12), then `Deploy.s.sol` wiring (M1-18)
- You: the 4 funded testnet wallet addresses — still the only thing gating a
  testnet deploy

---

### Session 7 — 2026-09-22 (M1-00b resolved · both repos pushed)

**M1-00b answered by reading the reference implementation**
(`erc-8004/erc-8004-contracts@master` — the default branch is `master`, not `main`)

✅ **`giveFeedback` is plain `external`.** No `tx.origin`, no `isContract`,
no EOA restriction. A contract *can* call it, and feedback is keyed by
`msg.sender`, so `TaskEscrow` becomes the client address `getSummary` filters
on. **The differentiator is viable exactly as designed.**

Three things came with that answer, two of which changed the plan:

| Finding | Consequence |
|---|---|
| `require(!isAuthorizedOrOwner(msg.sender, agentId))` | `TaskEscrow` must never own or be an operator of an agent it rates → new threat **T17** |
| `MAX_ABS_VALUE = 1e38` | Our 0–100 scale is far inside it |
| ❌ **`getSummary` reverts on an empty client list** | **Four docs were wrong.** There is no unfiltered ERC-8004 score |
| ❌ `getSummary` loops over every feedback entry per client | Won't scale for a single high-volume client address → score comes from indexed `NewFeedback` events instead |

The `getSummary` correction actually *strengthens* the pitch:

> ERC-8004 already forces every reader to name whose feedback they count.
> What it never gave them is an address worth naming. AGENTX is that address.

**Did**
- Step 0 of the M1 plan: corrected `README`, `01`, `02`, `04`, `09`; added T17
- Installed forge-std and OpenZeppelin as **git submodules** (Foundry standard,
  so CI's `submodules: recursive` works) — replacing the plain clones
- Wrote a README for each repo
- **Committed and pushed both repos**

**Verified before pushing**
- contracts: `forge build` clean · 5/5 tests · config integrity · erc8004 probe
- backend: `pnpm -r build` clean · 8/8 tests
- secret scan over staged diffs: clean; only `.env.example` present

**Learned / changed**
- `.gitignore` does **not** support trailing comments. `broadcast/    # ...`
  was treated as one literal pattern, so the anvil run artifacts got staged.
  Caught by reading `git status` before committing rather than after pushing.
- Added `.gitattributes` (`eol=lf`) to both repos — without it Windows CRLF
  would land in the remote and every future diff would be noise.

**Next**
- Step 1: `StakeVault`, then `TaskEscrow` (the core), then `AgentAccount`
- You: the 4 funded testnet wallet addresses — still the only thing gating a
  testnet deploy

---

### Session 6 — 2026-09-22 (Phase 2: backend config spine)

**Did**

| Task | Result |
|---|---|
| M0-03 | Repos received: `gopaltalaviya/agentx-{contracts,backend,interface}` |
| — | **Renamed `agentx-web` → `agentx-interface`** across all 6 docs to match the repo you created |
| M0-06 | `agentx-backend` pnpm workspace: `tsconfig.base.json` (strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`), `docker-compose.yml` (PG16 + Redis7 with healthchecks) |
| M0-15 | `@agentx/shared` — `JobSpec`, `JobResult`, `HireRequest`, error codes, canonical JSON for `specHash` |
| M0-20 | `scripts/write-deployment.mjs` in contracts repo |
| M0-21 | `@agentx/config` — the one import; validated with zod, frozen |
| M0-22 | Fail-fast boot check + `bin/check.mjs` |

**Verified end-to-end, not assumed**

Ran a real local deployment and loaded it back through the config package:

```
anvil (chainId 0x7a69)
  → forge script Deploy --broadcast   → MockUSDC 0x5FbDB231…80aa3
  → write-deployment.mjs anvil        → deployments/31337.json (startBlock 1)
  → @agentx/config                    → "fastPath 0.03 MockUSDC · minStake 10 MockUSDC · fee 1%"
```

That is the whole single-source chain proving itself: `networks.json` +
`params.31337.json` + a **generated** deployment file → one typed, frozen
object. No address was typed twice anywhere.

- `pnpm -r build` → clean
- `vitest run` → **8/8 passing** (money arithmetic, fee invariant I4, frozen config)
- Config fail-fast **negative-tested**: with no deployment file it printed
  *"deployments/10143.json not found → run `make deploy NETWORK=monad_testnet`,
  or drop 10143 from ENABLED_CHAIN_IDS"* — the error names the fix

**Decided**
- Token amounts cross every boundary as **decimal strings of base units**, never
  JSON numbers. A `uint128` amount exceeds 2^53, so a JSON number would lose
  precision silently and the first symptom would be a payment that fails to
  reconcile. Tested explicitly at 2^53+1.
- `Capability` is constrained to lowercase kebab-case. Free-form strings make
  discovery unmatchable — "Market Research" and "market-research" would be
  different capabilities and no agent would ever be found.

**Learned / changed**
- My own test used `new URL(...).pathname`, which on Windows yields `/C:/…` and
  cannot be resolved by `fs`. Caught immediately **because the config error was
  actionable** — it named the path it had tried. Fixed with `fileURLToPath`.

**Blocked on you**
- `git init` + `git remote add` for each repo — your global instruction forbids
  Claude creating repositories or remotes. Three commands, then Claude commits
  and pushes normally.
- Funded testnet wallet addresses (B2) — still the only thing gating a testnet deploy.

**Next**
- Me: `check-param-drift.mjs`, `export-abis.mjs`, then **M1: `StakeVault` + `TaskEscrow`**
- You: the git commands, and the 4 wallet addresses

---

### Session 5 — 2026-09-22 (Phase 1: contracts repo foundation)

**Did — `agentx-contracts/` now builds and tests green**

| Task | Result |
|---|---|
| M0-05 | Foundry project: `foundry.toml` (multi-network aliases, deterministic `bytecode_hash = "none"` for CREATE2), `remappings.txt`, `Makefile`, CI workflow |
| M0-08 | `MockUSDC.sol` + 5 unit/fuzz tests — **all passing** |
| M0-09 | `Deploy.s.sol` — fully network-agnostic, reads `config/` at runtime; **dry-run verified** on chain 31337 |
| M0-17 | `config/networks.json` — 31337 / 10143 / 143 |
| M0-18 | `config/params.{31337,10143,143}.json` |
| M0-19 | `foundry.toml` aliases + `Makefile NETWORK=` |
| M1-00d | `scripts/verify-erc8004.mjs` — **written and passing** |
| — | `scripts/check-config.mjs` — config integrity, wired into CI |

**Verified, not assumed**
- `forge build` → Compiler run successful
- `forge test` → 5 passed, 0 failed
- `forge script Deploy --chain-id 31337` → reads config, deploys MockUSDC, prints the right params
- `node scripts/verify-erc8004.mjs` → exit 0, all expectations match
- `node scripts/check-config.mjs` → exit 0; **negative-tested** by deliberately breaking `params.143.json`, which produced exactly the two intended errors

**Decided**
- **D1 resolved: git dependency, not GitHub Packages.** GitHub Packages requires
  the npm scope to equal the GitHub owner, so `@agentx/contracts` would have to
  become `@<owner>/contracts`. A git dep keeps the name and needs zero registry
  setup. Consumers install `github:<owner>/agentx-contracts#v0.1.0`.

**Learned / changed**
- `forge fmt`'s `multiline_func_header = "params_first"` exploded every
  one-argument function onto three lines. Removed it — Foundry's default is
  the standard, which is what was asked for.
- `MockUSDC` deployment is now guarded **twice**: `check-config.mjs` rejects
  `deployWithProtocol: true` on a non-testnet, and `Deploy.s.sol` re-asserts it
  on-chain. The second check is redundant on purpose; that mistake is
  irreversible.

**Next**
- Me: `agentx-backend` scaffold, then the three remaining contracts scripts
- You: repo URLs (B5) and funded wallet addresses (B2)

---

### Session 4 — 2026-09-22 (landscape analysis → ERC-8004 pivot)

**Did**
- Researched the actual 2026 landscape: ERC-8004, x402, AP2, Virtuals ACP,
  Skyfire, Nevermined, Coinbase Agentic Wallets
- Wrote [09 — Landscape Analysis](https://github.com/gopaltalaviya/agentx-docs/blob/master/docs/09-landscape.md)
- Repositioned the project and revised the contract architecture accordingly

**The finding that forced a pivot**

AGENTX as originally specced was **already built, twice**:

- Its identity + reputation registries are **ERC-8004**, which is *already
  deployed on Monad* (`0x8004A169…a432`, `0x8004BAa1…9b63`) and documented in
  Monad's own guides
- Its marketplace flow — discover, hire, escrow, evaluate — is **Virtuals
  ACP**, live on Base

In Track 4 (*Trust, Identity & AI Infrastructure*), a judge would have spotted
the ERC-8004 duplication within thirty seconds.

**The gap that is genuinely open**

ERC-8004 has **no payment primitive at all**, and its `giveFeedback()` is
callable by anyone — so reputation is free to forge. A published empirical
study of the live ecosystem (arXiv 2606.26028) found exactly that: coordinated
sybil registrations, reputation manipulation, dormant registries, and
"incomplete payment settlement mechanisms".

**New positioning**

> ERC-8004 gives agents identity and a place to record reputation. It does not
> give them money, and its feedback is free to forge. **AGENTX is the
> settlement layer that makes ERC-8004 reputation cost something.**

The mechanism is already in the standard: `getSummary()` takes a
`clientAddresses` filter, so a reader chooses whose feedback to count.
Filtering to `[AGENTX_ESCROW]` yields a score that **cannot be written without
a settled on-chain payment**. No fork, no migration, one-line adoption for any
ERC-8004 reader.

**Architecture changes**

| Change | Effect |
|---|---|
| ❌ `AgentRegistry.sol` — use ERC-8004 Identity | −1 day |
| ❌ `ReputationRegistry.sol` — write to ERC-8004 via `giveFeedback()` | −0.5 day |
| ➕ `StakeVault.sol` — the custody ERC-8004 lacks; answers the sybil finding | +0.5 day |
| ➕ ERC-8004 read adapter + agent-card generator | +1 day |
| ➕ x402 facilitator adapter (**P2, cut first**) | +1 day |
| ✅ `TaskEscrow` + `AgentAccount` unchanged — the parts nothing else has | — |

Net ≈ breakeven. Both fallback specs retained in
[04 §2.1 / §2.3](https://github.com/gopaltalaviya/agentx-docs/blob/master/docs/04-how-it-works.md) in case M1-00 verification fails.

**Learned / changed**
- `AgentAccount`'s **on-chain** spending caps are now the strongest purely
  technical differentiator: Skyfire, Nevermined and Coinbase all do spend
  control off-chain and custodially.
- x402 has real adoption (~165M tx, ~$50M, Linux Foundation, Google/Visa/AWS/
  Circle/Anthropic members) but is **not on Monad**. Bridging to it is reach,
  not thesis — P2, cut first.
- The submission must claim the specific gap, not superlatives. The space is
  crowded and judges will know it.

**Next**
- 🔒 **M1-00 (Sep 25): verify ERC-8004 on Monad** — read both registries,
  confirm ABIs match the draft EIP, and confirm `giveFeedback()` accepts a
  **contract** caller. The whole design rests on that last one.
- You: M0-03 repos · M0-04 wallets

---

### Session 3 — 2026-09-22 (dual-network + config architecture)

**Did**
- Wrote [08 — Configuration Architecture](https://github.com/gopaltalaviya/agentx-docs/blob/master/docs/08-configuration.md): the
  single-source-of-truth design for running testnet and mainnet off one codebase
- Corrected the database schema for multi-chain, updated the API, MCP, repo
  layout, tech stack and plan to match
- Added 10 tasks (100 → 110)

**Decided**
- **Testnet (10143) first; mainnet (143) supported by the same code.** The
  network is configuration, never a code path
- Four config domains, one owner each: `networks.json` (chain facts),
  `params.<chainId>.json` (protocol parameters), `deployments/<chainId>.json`
  (generated addresses), env (secrets and wiring only)
- **No contract address is ever an env var**, and no chain object is defined
  outside `@agentx/config`
- Constructor args stay network-independent so CREATE2 gives identical
  addresses on both networks; parameters arrive via post-deploy `configure()`

**Found and fixed — 3 more defects**

| # | Defect | Fix |
|---|---|---|
| 9 | **The schema could not hold two networks.** `chain_agent_id UNIQUE`, `chain_job_id UNIQUE`, `wallet_address UNIQUE` and `indexer_cursor PRIMARY KEY (contract)` are all global. Indexing a second chain would collide at agent #1 | `chain_id` on every chain-derived table; every uniqueness constraint scoped to it; cursor keyed `(chain_id, contract)` |
| 10 | Nothing prevented a job whose client is on one chain and worker on another | composite FKs `(agent_id, chain_id)` — structurally impossible, not merely checked |
| 11 | Protocol parameters existed **three times** (docs table, deploy script, backend pre-check) with nothing keeping them equal | one JSON per chain read by all three, plus a CI drift test against the deployed values |

**Learned / changed**
- Reputation must be **per chain**. Testnet MON is free, so a shared
  reputation table would make mainnet scores purchasable for nothing. This is
  a security property, not a schema detail.
- Mainnet parameters are deliberately more conservative than testnet — a
  10-minute auto-approve window is fine for a demo and indefensible against
  real funds.

**Next**
- You: M0-03 repos · M0-04 wallets
- Me: scaffolding + config packages, the moment repo URLs land

---

### Session 2 — 2026-09-22 (verification pass)

**Did**
- Verified all 99 task IDs: no duplicates, counts match the milestone board
- Verified every cross-document link and anchor; fixed 1 broken anchor
- Verified external facts by web lookup: deadline, tracks, prizes, Monad
  testnet (10143) and mainnet (143) config

**Found and fixed — 8 defects in my own spec**

| # | Defect | Fix |
|---|---|---|
| 1 | `scoreOf()` **reverts** for any agent with `raw < 50` — `(raw*conf)-(50*conf)` underflows in Solidity 0.8 | branched the calculation; added a 6-row worked-example table as the unit-test spec |
| 2 | `1284 completed / 49 failed` scores **96**, not the 94 printed everywhere | changed the example to `1284 / 81`, which really does score 94; fixed `successRate` 0.963 → 0.941 and volume 31.2 → 25.68 USDC |
| 3 | `fastPathMax = 0.50` would send the demo's 0.05 escrow job down the **direct** path — the demo could never show escrow | lowered to 0.03 and documented why the value looks arbitrary |
| 4 | `Outcome` enum used by `ReputationRegistry` but never defined | defined it |
| 5 | `Agent` struct wasted a storage slot (address cannot share an address's leftover 12 bytes) | reordered to pack; same for `Stats` |
| 6 | Caller authorisation for `TaskEscrow` never specified — anyone could create a job charged to another agent's wallet | added the full authorisation table |
| 7 | Fee rounding claimed to favour the protocol; the formula actually favours the worker | corrected the text to match the code |
| 8 | Demo panel said "4 txs"; the trace has 5 | fixed |

**Decided**
- Target **Track 4 — Trust, Identity & AI Infrastructure**
- D2 resolved: repos go public (submission requires a code link)

**Learned / changed**
- 🔴 `hackathon.monad.xyz` renders "MonadChain (ID: 143)" — **mainnet**. Every
  plan doc assumes testnet. This is now the highest-priority open question;
  it changes MockUSDC → real USDC and makes the spending caps load-bearing.
- Monad mainnet is live (v0.15.2). "Why Monad" framing should not read as if
  the chain were still pre-launch.

**Next**
- You: M0-03 repos · M0-04 wallets · **M0-02b testnet vs mainnet**
- Me: scaffolding, the moment repo URLs land

---

### Session 1 — 2026-09-22

**Did**
- Wrote the full specification: [01 idea](https://github.com/gopaltalaviya/agentx-docs/blob/master/docs/01-idea.md), [02 flowcharts](https://github.com/gopaltalaviya/agentx-docs/blob/master/docs/02-flowcharts.md),
  [03 tech stack](https://github.com/gopaltalaviya/agentx-docs/blob/master/docs/03-tech-stack.md), [04 how it works](https://github.com/gopaltalaviya/agentx-docs/blob/master/docs/04-how-it-works.md),
  [05 roadmap](https://github.com/gopaltalaviya/agentx-docs/blob/master/docs/05-roadmap.md)
- Collected 4 decisions from you (repo split, key ownership, hosting, who codes)
- Wrote [06 repo structure](https://github.com/gopaltalaviya/agentx-docs/blob/master/docs/06-repo-structure.md) — the 3-repo split and how ABIs cross boundaries
- Wrote [07 what I need from you](https://github.com/gopaltalaviya/agentx-docs/blob/master/docs/07-what-i-need-from-you.md)
- Wrote [PLAN.md](PLAN.md) — 99 tasks across 7 milestones
- Wrote this file

**Decided**
- 3 repos · you hold keys · Vercel + Railway · Claude writes code · standard conventions

**Learned / changed**
- The 3-repo split costs ~half a day of setup and makes every ABI change a
  publish-bump-install cycle. Recorded in [06 §6](https://github.com/gopaltalaviya/agentx-docs/blob/master/docs/06-repo-structure.md#6-what-changes-in-the-existing-docs)
  rather than discovered later.

**Next**
- You: M0-01 … M0-04
- Me: scaffolding, the moment repo URLs land

**Open questions**
- Deadline unconfirmed
- Monad chain facts unknown — every "verify against Monad docs" note in the
  specs is still open

---

## 🔄 How to update this file

At the **end of every session**, Claude updates, in this order:

1. `Last updated` + session number + days remaining
2. **Next actions** — both lanes, specific enough to act on cold
3. **Blockers** — add new, remove cleared, with dates
4. **Facts & Config** — anything that arrived this session
5. **Milestone board** — counts and status
6. **Current milestone table** — per-task status
7. **Decisions log** — append only, never rewrite
8. **Session log** — a new entry at the top

At the **start of every session**, Claude:

1. Reads this file first
2. Reads [PLAN.md](PLAN.md) for the current milestone's tasks
3. States the next task before starting it
4. Checks whether any 👤 item completed since last time

### Session log entry template

```markdown
### Session N — YYYY-MM-DD

**Did**
- [M#-##] what shipped

**Decided**
- decision + why

**Learned / changed**
- surprises, reversals, things the plan got wrong

**Next**
- You: …
- Me: …

**Open questions**
- …
```

### Rules

- **Never delete history.** Supersede, do not rewrite.
- A task is ✅ only when its definition of done in `PLAN.md` is met — not when
  the code is written.
- If a date slips, update the milestone board **and** say so in the session
  log. A silently slipped date is how a 21-day project becomes a 30-day one.
- If something is cut, mark it ❌ and record why. Cut work that is not written
  down gets half-rebuilt later.
