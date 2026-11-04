# Pactora (formerly AGENTX) — Working Plan

**Stable reference. Task list, owners, dependencies, definitions of done.**
This file changes only when scope changes. Day-to-day state lives in
[PROGRESS.md](PROGRESS.md).

- Created: 2026-09-22 · last revised 2026-10-01 (Session 29: M4-11, M4-12, M5-08 added at the owner's request)
- Deadline: **2026-10-13, 11:59 PM ET** ✅ verified
- Track: **4 — Trust, Identity & AI Infrastructure** ($30,000)
- Repos: 3 ([docs/06](https://github.com/gopaltalaviya/agentx-docs/blob/master/docs/06-repo-structure.md)) · Networks: testnet first, both supported ([docs/08](https://github.com/gopaltalaviya/agentx-docs/blob/master/docs/08-configuration.md))
- Built on **ERC-8004** — read [docs/09](https://github.com/gopaltalaviya/agentx-docs/blob/master/docs/09-landscape.md) before any contract work
- Code: written by Claude · Keys, deploys, decisions: owned by you

---

## How to use these two files

| File | Purpose | Changes |
|---|---|---|
| `PLAN.md` | What we are building and in what order | Rarely — only on scope change |
| `PROGRESS.md` | Where we are, what is next, what is blocked | Every session |

**Every session starts by reading `PROGRESS.md`.** It names the next task and
carries the context a closed terminal loses.

Task IDs (`M1-04`) are permanent. Reference them in commits:
`feat(escrow): implement createJob [M1-04]`.

---

## Legend

| Symbol | Meaning |
|---|---|
| 🤖 | Claude does it |
| 👤 | You do it (keys, accounts, deploys, decisions) |
| 🔒 | Blocking — work downstream stops until it is done |

Repos: **C** = `agentx-contracts` · **B** = `agentx-backend` · **I** = `agentx-interface` · **D** = docs

---

## M0 — Foundations · Sep 22–24

Goal: all three repos exist, build, and are wired together. A trivial contract
is deployed and verified on Monad testnet.

| ID | Task | Who | Repo | Depends on |
|---|---|---|---|---|
| M0-01 | ✅ Confirm hackathon deadline + submission format | 👤 | — | — |
| M0-02 | ✅ Gather Monad chain facts ([07 §C](https://github.com/gopaltalaviya/agentx-docs/blob/master/docs/07-what-i-need-from-you.md#c-done)) | 🤖 | — | — |
| M0-02b | ✅ **Testnet first, both networks supported** | 👤 | — | — |
| M0-03 | ✅ Create 3 empty GitHub repos, send URLs | 👤 | — | — |
| M0-04 | ✅ Create + fund 4 wallets, send addresses | 👤 | — | — |
| M0-05 | ✅ Scaffold `agentx-contracts` (Foundry, remappings, Makefile, CI) | 🤖 | C | M0-03 |
| M0-06 | ✅ Scaffold `agentx-backend` (pnpm workspace, docker-compose, CI) | 🤖 | B | M0-03 |
| M0-07 | ✅ Scaffold `agentx-interface` (Next.js 15, Tailwind, shadcn, CI) | 🤖 | W | M0-03 |
| M0-08 | ✅ `MockUSDC.sol` + unit test | 🤖 | C | M0-05 |
| M0-09 | ✅ `Deploy.s.sol` skeleton + `Makefile` targets | 🤖 | C | M0-08 |
| M0-10 | ✅ 👤 Run `make deploy-testnet` for MockUSDC; verify on explorer | 👤 | C | M0-09, M0-04 |
| M0-11 | ✅ ABI export script → `export/` | 🤖 | C | M0-08 |
| M0-12 | ✅ Decide package registry (GitHub Packages vs git dep) — **D1** | 👤 | — | M0-03 |
| M0-13 | ✅ Publish `@agentx/contracts` v0.0.1 | 👤 | C | M0-11, M0-12 |
| M0-14 | ✅ Install `@agentx/contracts` in B and W; prove the wiring | 🤖 | B, W | M0-13 |
| M0-15 | ✅ `packages/shared`: `JobSpec` / `JobResult` zod schemas | 🤖 | B | M0-06 |
| M0-16 | ✅ `.env.example` in all 3 repos — secrets + wiring only | 🤖 | C, B, W | M0-05/06/07 |
| M0-17 | ✅ `config/networks.json` — 10143, 143, 31337 ([08 §2](https://github.com/gopaltalaviya/agentx-docs/blob/master/docs/08-configuration.md#2-network-registry--confignetworksjson)) | 🤖 | C | M0-05 |
| M0-18 | ✅ `config/params.<chainId>.json` × 3 ([08 §3](https://github.com/gopaltalaviya/agentx-docs/blob/master/docs/08-configuration.md#3-protocol-parameters--configparamschainidjson)) | 🤖 | C | M0-17 |
| M0-19 | ✅ `foundry.toml` multi-network aliases + `Makefile NETWORK=` | 🤖 | C | M0-17 |
| M0-20 | ✅ `scripts/write-deployment.mjs` → `deployments/<chainId>.json` | 🤖 | C | M0-19 |
| M0-21 | ✅ `@agentx/config`: zod-validated, frozen `loadConfig()` | 🤖 | B | M0-14, M0-18 |
| M0-22 | ✅ Config fail-fast boot check with actionable errors | 🤖 | B | M0-21 |

**Done when:** a fresh clone of each repo reaches green CI; `@agentx/contracts`
is installed in both consumers; MockUSDC is verified on the Monad explorer.

**Risk:** M0-02 and M0-04 gate everything. If they are not done by Sep 23,
every date below slips one-for-one.

---

## M1 — Contracts · Sep 25–28

Goal: the money layer is correct. Spec: [docs/04 §2](https://github.com/gopaltalaviya/agentx-docs/blob/master/docs/04-how-it-works.md#2-smart-contracts).

> **Revised 2026-09-22 by [09 — Landscape Analysis](https://github.com/gopaltalaviya/agentx-docs/blob/master/docs/09-landscape.md).**
> `AgentRegistry` and `ReputationRegistry` are no longer built — ERC-8004's
> registries are already deployed on Monad. `StakeVault` replaces the custody
> they lack. Net effect: roughly breakeven on time, materially better
> positioning.

| ID | Task | Who | Repo | Depends on |
|---|---|---|---|---|
| M1-00 | ✅ **Verify ERC-8004 on Monad** — done 2026-09-22 ([09 §8](https://github.com/gopaltalaviya/agentx-docs/blob/master/docs/09-landscape.md#8-m1-00-verification--results-2026-09-22-on-chain)). Live on **mainnet only**; **absent on testnet**; both are ERC-1967 proxies | 🤖 | C | — |
| M1-00b | ✅ **Resolved 2026-09-22**: `giveFeedback` is plain `external` — a contract CAN call it. Also found: `getSummary` reverts on an empty client list; self-feedback guard → T17 | 🤖 | C | — |
| M1-00c | ✅ Deploy ERC-8004 Identity + Reputation to **testnet**; record in `deployments/10143.json` `erc8004` block | 🤖/👤 | C | M1-00b |
| M1-00d | ✅ CI check: mainnet registry proxy implementation has not changed from the pinned address | 🤖 | C | M1-00c |
| M1-01 | ✅ `interfaces/` — IIdentityRegistry, IReputationRegistry (ERC-8004), ITaskEscrow, IStakeVault | 🤖 | C | M1-00 |
| M1-02 | ✅ `StakeVault`: deposit, requestWithdraw, withdraw, slash, `isHireable` | 🤖 | C | M1-01 |
| M1-03 | ✅ ERC-8004 read adapter: `agentId` → owner, wallet, price, capabilities via `getMetadata` | 🤖 | C | M1-01 |
| M1-03b | ✅ Agent-card JSON generator + host (ERC-8004 registration-v1 schema, `x402Support`) — as an inline `data:` URI (ERC-8004 allows it), verified on chain Oct 1 | 🤖 | B | M1-03 |
| M1-04 | ✅ `TaskEscrow`: createJob, acceptJob, submitResult, approve | 🤖 | C | M1-02 |
| M1-05 | ✅ `TaskEscrow`: directPay fast path | 🤖 | C | M1-04 |
| M1-06 | ✅ `TaskEscrow`: cancel, dispute, resolveDispute | 🤖 | C | M1-04 |
| M1-07 | ✅ `TaskEscrow`: expireUnaccepted, expireUndelivered, autoApprove | 🤖 | C | M1-04 |
| M1-08 | ✅ `TaskEscrow`: fee capture at creation, Pausable, roles | 🤖 | C | M1-04 |
| M1-09 | ✅ `TaskEscrow` → `giveFeedback()` on settle, tags `agentx`/`settled`, `feedbackHash` binding jobId+specHash+resultHash+amount | 🤖 | C | M1-04, M1-00 |
| M1-09b | ❌ Off-chain `scoreOf` from `getSummary(agentId, [escrow], "agentx", "settled")` in `@agentx/config` — **cut:** superseded — scores come from the escrow's own settlement events (docs/04) | 🤖 | B | M1-09 |
| M1-10 | ✅ `AgentAccount`: execute + 5 policy checks | 🤖 | C | M1-01 |
| M1-11 | ✅ `AgentAccount`: session keys, allowlist, sweep | 🤖 | C | M1-10 |
| M1-12 | ✅ `AgentAccountFactory` | 🤖 | C | M1-10 |
| M1-13 | ✅ Unit tests: every transition, legal and illegal | 🤖 | C | M1-02…M1-12 |
| M1-14 | ✅ Fuzz tests: amounts, deadlines, fee rounding | 🤖 | C | M1-13 |
| M1-15 | ✅ Invariant tests I1–I8 ([04 §2.2](https://github.com/gopaltalaviya/agentx-docs/blob/master/docs/04-how-it-works.md#22-taskescrow)) | 🤖 | C | M1-13 |
| M1-16 | ✅ `forge snapshot` committed; gas budget per hire recorded | 🤖 | C | M1-13 |
| M1-17 | ✅ 100% branch coverage on `TaskEscrow` | 🤖 | C | M1-13 |
| M1-18 | ✅ `Deploy.s.sol` — network-agnostic, reads `params.<chainId>.json`, CREATE2 + fixed salt, post-deploy `configure()` | 🤖 | C | M1-12, M0-20 |
| M1-18b | ✅ `scripts/check-param-drift.mjs` — deployed values vs config, runs in CI | 🤖 | C | M1-18 |
| M1-19 | ✅ 👤 `make deploy-testnet`; verify all; send addresses + startBlock | 👤 | C | M1-18 |
| M1-20 | ✅ Commit `deployments/10143.json`; publish `@agentx/contracts` v0.1.0 | 👤 | C | M1-19 |
| M1-21 | ✅ `SeedDemo.s.sol` — register 6 agents in ERC-8004 with settled history | 🤖 | C | M1-19 |
| M1-22 | ✅ 🔒 **ABI FREEZE** — Sep 28 | 👤 | C | M1-20 |

### M1 fallback (build **only** if M1-00 fails)

| ID | Task | Who | Repo |
|---|---|---|---|
| M1-F1 | ❌ `AgentRegistry.sol` per [04 §2.1](https://github.com/gopaltalaviya/agentx-docs/blob/master/docs/04-how-it-works.md#21-agentregistry) — **cut:** not needed — ERC-8004 Identity is deployed on Monad (docs/09) | 🤖 | C |
| M1-F2 | ❌ `ReputationRegistry.sol` per [04 §2.3](https://github.com/gopaltalaviya/agentx-docs/blob/master/docs/04-how-it-works.md#23-reputationregistry) — **cut:** not needed — ERC-8004 Reputation is deployed on Monad (docs/09) | 🤖 | C |

Cost if triggered: +1.5 days, absorbed by the M5 buffer. Decide on **Sep 25**,
not later.

**Done when:** invariants hold over 10,000 fuzz runs; 100% branch coverage on
`TaskEscrow`; all contracts verified on the explorer; a scripted lifecycle
(register → hire → deliver → settle → score changes) runs on testnet.

---

## M2 — Backend spine · Sep 29 – Oct 2

Goal: a hire settles end to end via `curl`. No UI.
Spec: [docs/04 §4–5](https://github.com/gopaltalaviya/agentx-docs/blob/master/docs/04-how-it-works.md#4-database-schema).

| ID | Task | Who | Repo | Depends on |
|---|---|---|---|---|
| M2-01 | ✅ `packages/db`: Drizzle schema, full DDL from 04 §4 — **`chain_id` on every chain-derived table, all uniqueness per-chain** | 🤖 | B | M0-06 |
| M2-01b | ✅ Composite FKs preventing cross-chain jobs ([08 §8](https://github.com/gopaltalaviya/agentx-docs/blob/master/docs/08-configuration.md#8-multi-chain-data-model)) | 🤖 | B | M2-01 |
| M2-02 | ✅ Migrations + `pnpm db:migrate` | 🤖 | B | M2-01 |
| M2-03 | ❌ Seed: 6 agents, ~300 settled jobs, realistic scores — **cut:** decided against — ~300 invented settlements would be fabricated reputation, the one thing AGENTX exists to prevent; the marketplace shows only real settled jobs | 🤖 | B | M2-02 |
| M2-04 | ✅ Indexer: viem event watchers, **one worker per enabled chain** | 🤖 | B | M1-20, M2-02 |
| M2-05 | ✅ Indexer: `jobs` + `job_events` projection, idempotent | 🤖 | B | M2-04 |
| M2-06 | ✅ Indexer: `payments` + `agent_stats` projection | 🤖 | B | M2-05 |
| M2-07 | ✅ Indexer: reorg handling via `last_block_hash` | 🤖 | B | M2-05 |
| M2-08 | ✅ Indexer: replay test — same range twice, tables identical | 🤖 | B | M2-07 |
| M2-09 | ✅ Signer: policy pre-check (same 5 rules as the contract) | 🤖 | B | M1-20 |
| M2-10 | ✅ Signer: per-agent nonce lock (Postgres advisory lock) | 🤖 | B | M2-09 |
| M2-11 | ✅ Signer: idempotency keys in Redis | 🤖 | B | M2-09 |
| M2-12 | ✅ Signer: key loading (per **C1** decision) + gas top-up | 🤖 | B | M2-09, C1 |
| M2-13 | ✅ API: auth (API keys, argon2id hashing, scopes) | 🤖 | B | M2-02 |
| M2-14 | ✅ API: `POST/GET/PATCH /v1/agents` + stake | 🤖 | B | M2-13 |
| M2-15 | ✅ API: `GET /v1/agents` discovery + 4 ranking modes, **always chain-scoped** | 🤖 | B | M2-14 |
| M2-15b | ✅ API: `?chainId=` resolution, `chainId` echoed in every response, `CHAIN_MISMATCH` / `CHAIN_NOT_ENABLED` | 🤖 | B | M2-14 |
| M2-16 | ✅ API: `POST /v1/jobs` with path auto-selection | 🤖 | B | M2-15, M2-12 |
| M2-17 | ✅ API: accept / result / approve / dispute / cancel | 🤖 | B | M2-16 |
| M2-18 | ✅ API: `GET /v1/jobs/:id/events` SSE | 🤖 | B | M2-17 |
| M2-19 | ✅ API: RFC 7807 errors, all codes from 04 §5.3 | 🤖 | B | M2-17 |
| M2-20 | ✅ API: rate limits, idempotency middleware, trace IDs | 🤖 | B | M2-19 |
| M2-21 | ✅ `scripts/e2e.sh` — full lifecycle via curl, asserted — as `scripts/e2e.mjs` | 🤖 | B | M2-20 |
| M2-22 | 👤 Railway: api, signer, indexer (+ optional workers) + Postgres — configs in `deploy/railway/`, runbook [docs/13](https://github.com/gopaltalaviya/agentx-docs/blob/master/docs/13-deploy.md) | 👤 | B | M2-21 |
| M2-23 | 👤 Run `node scripts/check-deployment.mjs <api> <site>` against Railway + Vercel | 👤 | B | M2-22 |

**Done when:** `node scripts/e2e.mjs` passes unattended against the deployed
backend and asserts on-chain balances, fee, score change, and 5 `job_events`
rows.

**Fallback if the indexer overruns (decide Oct 1):** optimistic writes on
broadcast, corrected by the indexer on confirmation.

---

## M3 — Agents + MCP · Oct 3–5

Goal: the demo runs itself. **This milestone wins or loses the hackathon.**
Spec: [docs/04 §6–7](https://github.com/gopaltalaviya/agentx-docs/blob/master/docs/04-how-it-works.md#6-the-mcp-agent-interface).

| ID | Task | Who | Repo | Depends on |
|---|---|---|---|---|
| M3-01 | ✅ `@agentx/sdk` — typed REST client for agents | 🤖 | B | M2-21 |
| M3-02 | ✅ MCP server: `discover_agents`, `hire_agent`, `get_job` | 🤖 | B | M3-01 |
| M3-03 | ✅ MCP server: `await_result`, `approve_job`, `dispute_job`, `my_budget`, `get_network` | 🤖 | B | M3-02 |
| M3-04 | ✅ MCP tool descriptions state cost explicitly | 🤖 | B | M3-03 |
| M3-05 | ✅ Worker base class: offer loop, accept/decline, self-validate | 🤖 | B | M3-01 |
| M3-06 | ✅ `research-bot` | 🤖 | B | M3-05 |
| M3-07 | ✅ `trading-bot` | 🤖 | B | M3-05 |
| M3-08 | ✅ `execution-bot` | 🤖 | B | M3-05 |
| M3-09 | ✅ Orchestrator: plan → discover → hire → await → approve | 🤖 | B | M3-03 |
| M3-10 | ✅ Orchestrator: failure branches — no candidate, budget, timeout, schema mismatch | 🤖 | B | M3-09 |
| M3-11 | ✅ Prompt-injection containment ([04 §7.3](https://github.com/gopaltalaviya/agentx-docs/blob/master/docs/04-how-it-works.md#73-prompt-injection-containment)) | 🤖 | B | M3-09 |
| M3-12 | ✅ `pnpm demo` — the full two-step trace, unattended | 🤖 | B | M3-10 |
| M3-13 | ✅ 👤 Run `pnpm demo`; send explorer links | 👤 | B | M3-12 |
| M3-14 | ✅ **x402 facilitator**: `POST /v1/x402/verify` + `/settle`, backed by `directPay` (P2 — cut first) | 🤖 | B | M3-01 |
| M3-15 | ✅ Worker endpoints answer `402 Payment Required`; accept retry with receipt header (P2) | 🤖 | B | M3-14 |

**Done when:** `pnpm demo` completes unattended, prints every jobId / amount /
explorer URL, and recovers visibly when a worker is killed mid-job.

**Do not skip M3-10 to save a day.** Live demos fail on exactly those paths.

---

## M4 — Frontend · Oct 6–8

Goal: make the invisible visible.

| ID | Task | Who | Repo | Depends on |
|---|---|---|---|---|
| M4-01 | ✅ API client + types from `@agentx/shared` | 🤖 | W | M2-21 |
| M4-02 | ✅ Marketplace grid: cards, tags, price, score, success rate | 🤖 | W | M4-01 |
| M4-03 | ✅ Filters + ranking modes | 🤖 | W | M4-02 |
| M4-04 | ✅ Agent profile: history, earnings, score | 🤖 | W | M4-02 |
| M4-05 | ✅ Register-an-agent flow (wagmi + RainbowKit) — with viem directly, not wagmi/RainbowKit | 🤖 | W | M4-01 |
| M4-06 | ✅ **Live demo page** — input box + SSE event stream | 🤖 | W | M3-12 |
| M4-07 | ✅ Explorer links on every on-chain event, via `config.explorerTx()` | 🤖 | W | M4-06 |
| M4-07b | ✅ Network badge on every page; network switcher if both chains enabled — badge; no switcher while one chain is enabled | 🤖 | W | M4-01 |
| M4-08 | ✅ Running totals: spent, tx count, agents hired | 🤖 | W | M4-06 |
| M4-09 | ✅ Responsive + dark mode | 🤖 | W | M4-06 |
| M4-10 | 👤 Vercel deploy, custom domain if wanted | 👤 | W | M4-09 |
| M4-11 | ✅ Docs search — Ctrl/⌘+K, typo/stem/synonym-aware, pages + actions + live agents | 🤖 | W | M4-09 |
| M4-12 | ✅ Video guides — six captioned clips at `/docs/guides`, recorded live on testnet | 🤖 | W | M4-11 |

**Done when:** a stranger watching the demo page can explain what happened
without narration.

---

## M5 — Harden and rehearse · Oct 9–11

| ID | Task | Who | Depends on |
|---|---|---|---|
| M5-01 | ✅ 👤 Chaos checklist, 7 items ([roadmap §8](https://github.com/gopaltalaviya/agentx-docs/blob/master/docs/05-roadmap.md#8-m5--harden-and-rehearse--oct-911)) | 👤 | M4-10 |
| M5-02 | ✅ Fix everything chaos day surfaces | 🤖 | M5-01 |
| M5-03 | ✅ Security pass against [04 §9](https://github.com/gopaltalaviya/agentx-docs/blob/master/docs/04-how-it-works.md#9-security-model-and-threats), T1–T16 | 🤖 | M5-02 |
| M5-04 | ✅ SSRF guard on `metadataURI` fetches | 🤖 | M5-03 |
| M5-05 | ✅ Confirm: no keys in logs, rate limits live, idempotency enforced | 🤖 | M5-03 |
| M5-06 | ✅ 3 consecutive clean demo runs on testnet, timed — 149 / 153 / 168 s, Sep 30 | 🤖 | M5-02 |
| M5-07 | 👤 **Record backup video** | 👤 | M5-06 |
| M5-08 | ✅ Edge, hostile-input and one-dependency-down testing; 14 defects fixed ([docs/17 §16–19](https://github.com/gopaltalaviya/agentx-docs/blob/master/docs/17-production-readiness.md)) | 🤖 | M5-06 |

**Done when:** three clean runs in a row and a backup video exists.

---

## M6 — Submit · Oct 12–13

| ID | Task | Who | Depends on |
|---|---|---|---|
| M6-01 | ✅ README in all 3 repos: pitch, diagram, addresses, quickstart | 🤖 | M5-06 |
| M6-02 | Final docs pass, including the limitations section | 🤖 | M5-03 |
| M6-03 | ✅ Deck: problem → solution → demo → architecture → why Monad → next | 🤖 | M6-01 |
| M6-04 | 👤 Record the real demo video (2–3 min) | 👤 | M5-06 |
| M6-05 | ✅ Decide: make `agentx-contracts` public? — **D2**: yes, all three repos go public (owner, Oct 1) | 👤 | — |
| M6-06 | 👤 Submit, with hours of buffer | 👤 | M6-04 |
| M6-07 | 👤 Verify every submission link from a logged-out browser | 👤 | M6-06 |
| M6-08 | 👤 Freeze `master` | 👤 | M6-06 |

---

## Open decisions

Tracked here, answered in `PROGRESS.md`.

| # | Decision | Needed by | Recommendation |
|---|---|---|---|

| D3 | Protocol fee paid by worker or client | Sep 26 | Worker |
| D4 | Name `AGENTX` available? | Sep 25 | Check npm, GitHub, submissions |
| D5 | Demo domain | Oct 6 | `*.vercel.app` is fine |
| D7 | Does the Safe Singleton Factory exist on Monad? | Sep 27 | Check; fall back to plain CREATE if not — nothing hardcodes addresses either way |
| D8 | Canonical USDC address on Monad mainnet | Oct 12 | From the Monad token list; only blocks a mainnet deploy |
| C1 | Key storage: Railway keystore vs AWS KMS | Oct 1 | Railway keystore for testnet, documented as a limitation |

**Resolved:** D1 (git dependency) · D2 (repos public — submission requires a code link) ·
D6 (**testnet first, both networks supported**)

---

## Cut list

Under time pressure, cut strictly from the bottom. Decided now, not at 3am on
Oct 12.

| Priority | Item |
|---|---|
| **P0 — never cut** | ERC-8004 identity integration · hire · deliver · settle |
| **P0** | `giveFeedback()` from escrow — **the entire differentiator** (M1-09) |
| **P0** | orchestrator running unattended (M3-12) |
| **P0** | live demo page (M4-06) |
| P1 | escrow path — direct-pay alone still demos |
| P1 | on-chain `AgentAccount` policy caps — strongest technical differentiator |
| P1 | `StakeVault` — answers the sybil finding |
| P2 | **x402 facilitator (M3-14/15)** — cut first, it is reach not thesis |
| P2 | dispute + arbiter (M1-06) → cut to a documented design |
| P2 | agent profile page (M4-04) |
| P3 | ERC-8004 Validation Registry (only if it ships before Oct 8) |
| P3 | staking UI — CLI is fine |
| P3 | score-over-time chart |
| P3 | 4 ranking modes → ship `balanced` only |

---

## Scope boundary

Pactora is **rails, not a framework**. Anything that starts to look like a
general-purpose agent framework is out of scope, regardless of how interesting
it is. If a proposed feature does not make one agent pay another agent more
credibly, it does not ship before Oct 13.
