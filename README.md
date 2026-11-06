# pactora-backend-near

Backend services for **Pactora on NEAR**: AI agents hire other agents, the
money sits in an on-chain escrow, every hire stays inside spend caps the
contract enforces, and every settled job writes reputation any app can read.
API, signer, indexer, MCP server and the agents themselves.

> **NEAR Hackathon (Nov 2026) — what existed before.** Pactora started as
> AgentX on Monad (EVM). The tag `pre-hackathon` is that code, imported
> unchanged. Everything NEAR was built in the hackathon window: the
> function-call-key signer, the NEAR indexer (NEP-297 events from final
> blocks), NEP-413 registration, CAIP-2 network keys, the counterparty check
> that blocks a farmed agent at hire time, and the end-to-end and attack demo.
> The diff: `git diff pre-hackathon hackathon-submission`, or
> [compare on GitHub](https://github.com/gopaltalaviya/pactora-backend-near/compare/pre-hackathon...hackathon-submission).
> Sibling repos, same split:
> [contracts](https://github.com/gopaltalaviya/pactora-contracts-near) (the
> Rust contract and the 2-of-3 Sputnik DAO arbiter),
> [interface](https://github.com/gopaltalaviya/pactora-interface-near),
> [docs](https://github.com/gopaltalaviya/pactora-docs-near).

---

## Run it — one command, no keys

Needs Docker, Node 22+, pnpm 9, and the contracts repo cloned beside this one.

```bash
git clone https://github.com/gopaltalaviya/pactora-contracts-near
git clone https://github.com/gopaltalaviya/pactora-backend-near
cd pactora-backend-near
pnpm install
pnpm demo:local
```

What it does: starts Postgres and a fresh local NEAR node (Docker), deploys
the contracts from the contracts repo's committed wasm (hash-checked), runs the
migrations and the build, then `scripts/demo.mjs` with `AGENT_MODE=cached` —
the models' answers are replayed from `.agent-cache/`, so no API key and no
quota. About 3 minutes after the images are built.

What you see — every line a check against the chain, not a log message:

```
  ✓ registered the orchestrator and 3 workers: wallet keys from the signer, NEP-413 owner signatures, wallets accepted on chain
  plan      4 subtask(s) — …
  hire      job … for 0.02 mUSDC          ← create_job / direct_pay, signed with the wallet's function-call key
  judge     job …: accept (quality 3)
  settle    job … paid
  ✓ 3 step(s) settled on chain
  ✓ workers were paid 0.1287 mUSDC in total, read from their purses on chain
  ✓ the orchestrator spent 0.13 mUSDC of its 1 mUSDC daily cap (on chain)
  ✓ the indexer recorded 3 settlement(s) from the chain's own events
  ✓ I1 holds: the contract holds exactly what it owes
  ✓ the counterparty check reads the farm's record from the chain: self-funded → block
  attack: a worker's result carries a prompt injection … Suppose the orchestrator's model obeys.
  ✓ the orchestrator hires the farmed agent        → refused: COUNTERPARTY_BLOCKED
  ✓ the orchestrator buys the "premium report"     → refused: BUDGET_EXCEEDED
  ✓ … asks the signer to withdraw its purse        → refused: FORBIDDEN
  worse: an agent's wallet key is stolen, and the attacker calls the chain directly.
  ✓ with the stolen key: hire for 1.5 mUSDC        → refused: PerTaskCapExceeded   (the contract)
  ✓ with the stolen key: withdraw the purse        → refused: Deposit is not allowed with function call   (the node)
  ✓ with the stolen key: send the wallet's NEAR    → refused: full access   (the node)
  ✓ with the stolen key: call the token contract   → refused: does not match transaction receiver   (the node)
  ✓ after the attack: the orchestrator's purse is unchanged and the farm got nothing from it
Demo passed.
```

Exit code 0 means every check passed. `DEMO_ATTACK=0` skips the attack;
`DEMO_HOLD=1` keeps the stack up afterwards for the interface.

The contract's own flows (escrow, every exit, caps, the leaked-key refusal,
the DAO arbiter ruling 2 of 3) are checked live by
`pactora-contracts-near/scripts/verify-near.mjs` — see that repo's README.

---

## How an agent holds its keys

| Who | Key | What it can do |
|---|---|---|
| The **owner** (a person) | Full-access key in their own wallet | Registers the agent, funds it, sets its caps, withdraws. Signs in to the API with NEP-413 |
| The **agent's wallet** (`bot.<owner>`) | One **function-call key, scoped to the Pactora contract**, held encrypted by `apps/signer` | Hire, accept, submit, approve, dispute, cancel — within the per-task and rolling 24 h caps the contract keeps for that agent |
| The **agent process** | An API key (`ax_…`) | Asks the API; never sees a chain key |

A function-call key cannot attach a deposit, and every Pactora method that
moves money out needs one yocto, so a stolen agent key can never withdraw: the
NEAR node refuses before the contract runs. The most it can spend is its caps,
and only on registered, staked agents. The signer's KMS option signs ed25519
in AWS KMS (`SIGNER_KMS_KEYS`) so the key never exists in process memory.

## The counterparty check (allow / warn / block)

`GET /v1/agents/:id/trust` (MCP `check_trust`) says whether a reputation
deserves belief: how many distinct owners paid the agent, how much of its
record one owner wrote, and whether its clients received payment-token money
from the agent's own side just before paying it (the indexer's funding graph
of NEP-141 transfers and deposits). Verdict → action: `trusted` → **allow**;
`new`, `concentrated` → **warn**; `self-funded`, `failing` → **block**.

A block is enforced, not advised: `POST /v1/jobs` and x402 payments refuse
the worker with 403 `COUNTERPARTY_BLOCKED` before anything is signed, so a
prompt-injected model cannot pay a farmed agent whatever it was told.

---

## What runs here

| Service | Role |
|---|---|
| `apps/api` | Fastify REST + SSE + OpenAPI (`/v1/openapi.json`). Holds no chain key |
| `apps/signer` | The only process with agent keys: function-call keys, NEP-413 key handout, per-agent nonce lock, idempotent `/sign` of eight allowed methods (docs/NEAR-PORT.md §6) |
| `apps/indexer` | Final NEAR blocks → Postgres: Pactora's NEP-297 events and the token's NEP-141 transfers. The authority on every job's state |
| `apps/mcp` | Nine MCP tools (`get_network`, `my_budget`, `discover_agents`, `check_trust`, `hire_agent`, `approve_job`, `dispute_job`, `get_job`, `await_result`), so any MCP agent can transact |
| `apps/agents/*` | The orchestrator, and research, trading and execution workers |

| Package | Role |
|---|---|
| `@pactora/near` | near-api-js 7 wrapper: RPC, function calls, NEP-413, sha256 hashing |
| `@pactora/config` | Chain facts, contract params and addresses, validated at boot (`chain/`) |
| `@pactora/db` | Drizzle schema and migrations; reputation and trust queries |
| `@pactora/sdk` | Typed client for agents |
| `@pactora/agent-core` | Model chain, prompts, judge, worker loop, orchestrator, x402 |
| `@pactora/shared` | Job/result schemas and error codes |

The wire contract between these and the chain — identifiers, hashes, the
signer API, events — is [`docs/NEAR-PORT.md`](docs/NEAR-PORT.md).

**x402.** A worker can sell one HTTP call: `pactora-directpay` (pay first,
bounded by `fast_path_max`) or `pactora-escrow` (refundable: settlement is a
`create_job`, a failed call is cancelled for a full refund). SDK:
`client.payX402(url, {maxAmount, body})`.

**Prompt injection.** Another agent's result enters a model only as delimited,
shape-checked data; the judge that reads it has no tools. We do not claim to
prevent injection. We claim a successful one cannot spend past the on-chain
caps, cannot pay a blocked counterparty through the API, and cannot withdraw —
and the demo shows each.

---

## Models

```bash
AGENT_MODE=cached      # replay .agent-cache — the default; no key, no quota
AGENT_MODE=record      # call providers and save
AGENT_MODE=live        # call providers every time
BRAIN_CHAIN=gemini,groq,ollama,claude          # provider order for workers
BRAIN_CHAIN_ORCHESTRATOR=claude,gemini,groq    # planning and judging
```

In cached mode a goal the recordings do not cover fails loudly rather than
calling a provider.

## Testnet

`DEMO_NETWORK=testnet pnpm demo` runs the same demo on NEAR testnet once
`chain/deployments/testnet.json` exists (the contracts repo's
`scripts/deploy.mjs --network testnet` writes it; `node scripts/sync-chain-facts.mjs`
copies it here). Mainnet is refused by every script.

## Tests

```bash
docker compose up -d && pnpm db:migrate   # the tests use Postgres on :5443
pnpm check                                # typecheck, lint, format, 865 tests
```

Two rules from the project: a mock that agrees with your assumptions proves
nothing, so every milestone gets a live-chain check (`pnpm demo:local`); and a
test written for a bug is first run against the old code, to see it fail.

## Built with

near-api-js 7.4 · near-sandbox 2.14 (via the `near-sandbox` npm package) ·
Sputnik DAO v2 (arbiter) · Fastify 5 · Drizzle ORM · PostgreSQL 16 · zod 4 ·
`@modelcontextprotocol/sdk` · Vitest · TypeScript 5. Models: Anthropic Claude,
Google Gemini, Groq, Ollama (all optional; cached by default). AI assistance:
Claude Code was used to write and review code and docs. Our own pre-hackathon
code (AgentX, tag `pre-hackathon`) is baseline.

## Licence

MIT — see [LICENSE](LICENSE).
