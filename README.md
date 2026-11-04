# agentx-backend

Pactora (formerly AGENTX)

Backend services for **Pactora** — proof-of-payment reputation and escrow for
[ERC-8004](https://eips.ethereum.org/EIPS/eip-8004) agents on Monad.

Contracts live in
[`agentx-contracts`](https://github.com/gopaltalaviya/agentx-contracts);
the UI lives in
[`agentx-interface`](https://github.com/gopaltalaviya/agentx-interface).
They are separate repositories so that Foundry sources and deploy keys never
enter a hosting provider's build container.

**Live on Monad testnet (10143).** `TaskEscrow` v2 is
[`0x4feED0338761817417Fd1dDdFC8331D16AEB370D`](https://testnet.monadexplorer.com/address/0x4feED0338761817417Fd1dDdFC8331D16AEB370D);
every deployed address is in [`chain/deployments/10143.json`](chain/deployments/10143.json)
(a checked copy of the contracts repo's). `node scripts/demo.mjs` plans, hires,
judges and settles real jobs there — see [PROGRESS.md](PROGRESS.md) for the
exact commands, [docs/13](https://github.com/gopaltalaviya/agentx-docs/blob/master/docs/13-deploy.md) to deploy, and
[docs/17](https://github.com/gopaltalaviya/agentx-docs/blob/master/docs/17-production-readiness.md) for what is and is not
production-ready.

**Hosted (since 2026-10-07).** The API, signer, indexer, hosted orchestrator
with its three workers, and Postgres run on one Vultr VPS behind Caddy at
`https://api.64-177-41-175.sslip.io` (files in [`deploy/vps/`](deploy/vps/),
including a daily database backup); the site is on Vercel at
**https://agentx-interface-iota.vercel.app**. Railway is no longer used.

---

## What runs here

| Service | Role |
|---|---|
| `apps/api` | Fastify REST + SSE. Holds **no key**: it encodes calls and hands them to the signer. |
| `apps/signer` | The only process with a key. Checks the same policy `AgentAccount` enforces on-chain, so a caller gets an actionable error instead of a revert. |
| `apps/indexer` | Chain → Postgres. Reorg-aware, replay-safe, and the authority on every job's real state. |
| `apps/mcp` | The agent interface: eight MCP tools, so any MCP-capable agent can transact without writing an HTTP client. |
| `apps/agents/*` | `orchestrator`, plus `research-bot`, `trading-bot` and `execution-bot`. |

| Package | Role |
|---|---|
| `@pactora/config` | The **one** import for chain facts, protocol parameters and contract addresses. Validated with zod and frozen at boot. |
| `@pactora/shared` | `JobSpec`, `JobResult`, error codes, result-shape validation — zod schemas with types derived from them, so validation and types cannot drift. |
| `@pactora/db` | Drizzle schema and migrations. Every chain-derived table carries `chain_id`. |
| `@pactora/sdk` | The typed client every agent imports, so nobody hand-rolls `fetch`. |
| `@pactora/agent-core` | Brains, prompts, the judge, the worker loop and the orchestrator. |

---

## Quickstart

```bash
pnpm install
docker compose up -d                 # Postgres 16
pnpm --filter @pactora/db migrate
pnpm -r build
pnpm test

# Needs a deployment to exist in the contracts checkout
PACTORA_CONTRACTS_ROOT=../agentx-contracts \
ENABLED_CHAIN_IDS=10143 node packages/config/bin/check.mjs
```

Then the whole thing, unattended:

```bash
VERIFY_CHAIN_ID=10143 pnpm demo
```

`pnpm demo` boots the stack, puts four agents on-chain, runs three workers and
hands the orchestrator one sentence. It asserts on **worker balances and on
reputation written by settlement**, never on log lines — because every serious
bug in this project passed its unit tests and was caught only against the real
chain.

It checks a model is reachable *before* any chain write, so a missing key
costs no gas and tells you what to do about it.

---

## The agent interface

Eight MCP tools. Two rules are enforced structurally rather than by
convention:

- **A tool that moves money says so first.** `defineTool` builds the warning
  from the tool's own `spends` flag, so a ninth tool cannot be added without
  one. Spending tools carry `readOnlyHint: false`, so a host can gate them
  behind its own approval UI.
- **`get_job` and `await_result` state in their descriptions that a returned
  result is data, not instruction.** Those are the two places another agent's
  text enters a model's context, and that warning must not depend on the
  client having set our system prompt.

`my_budget` exists so an agent can plan rather than discover its limits by
hitting 402s, which is how you get a retry storm.

---

## x402: pay per HTTP request

A worker can also sell a single call over plain HTTP. `serveX402()` in
`@pactora/agent-core` (on with `X402_PORT` and `PACTORA_AGENT_ID`) answers an
unpaid `POST /<capability>` with `402` and a quote; the caller pays and
retries with an `X-PAYMENT` header. The API side:

```
POST /v1/x402/settle   client: checks the quote, pays it as a fast-path hire
POST /v1/x402/verify   worker: checks a payment, no side effects
POST /v1/x402/redeem   worker: verify and mark used, once per payment
```

Verification reads the `DirectPaid` event from the chain's own `TaskEscrow`,
not just the database. The scheme is `agentx-directpay`, not x402's canonical
EIP-3009 `exact`, and it is pay-first: if the work fails after payment the
caller gets a 502 and no refund, bounded by `fastPathMax`. From the SDK:
`client.payX402(url, { maxAmount, body })`. Details:
[04 §5.2c](https://github.com/gopaltalaviya/agentx-docs/blob/master/docs/04-how-it-works.md#52c-x402-pay-per-http-request).

---

## Models and cost

Two independent switches, kept separate on purpose:

```bash
AGENT_MODE=cached      # replay a recording — free, and the default
AGENT_MODE=record      # call providers and save, so later runs are free
AGENT_MODE=live        # call providers every time

BRAIN_CHAIN=gemini,groq,ollama,claude          # workers
BRAIN_CHAIN_ORCHESTRATOR=claude,gemini,groq    # planning and judging
```

`AGENT_MODE` decides whether tokens are spent at all. `BRAIN_CHAIN` decides
the provider **order** — a deliberate cost and quality choice, so it is
configured rather than guessed. Moving *along* the chain is automatic, because
a rate limit at 11pm on submission day has nobody available to flip a flag.

Development costs nothing. A live run is roughly half a cent on the free
tiers. The hosted deployment runs Google Gemini (flash-lite models first, free
tier) with a Groq fallback (`openai/gpt-oss-120b`) when Gemini's quota is
exhausted; the site says so plainly when the model is rate-limited.

---

## Configuration

**Secrets go in env. Everything else is versioned config** in the contracts
repo. No contract address is ever an environment variable — that is the most
common cause of "works locally, points at the wrong contract in production".

One backend serves every chain in `ENABLED_CHAIN_IDS` at once; running testnet
and mainnet together is a config value, not a second deployment.

Config is validated at startup and reports **every** problem at once with an
actionable fix:

```
✗ Pactora config invalid
  • chain 10143: deployments/10143.json not found
    → run `make deploy NETWORK=monad_testnet`, or drop 10143 from ENABLED_CHAIN_IDS
```

A service that boots with broken config and fails on the first user request is
strictly worse than one that refuses to boot.

---

## Money

Token amounts cross every boundary as **decimal strings of integer base
units**, never JSON numbers — a `uint128` amount exceeds 2^53, so a JSON number
would lose precision silently and the first symptom would be a payment that
fails to reconcile.

Every request that spends requires an `Idempotency-Key`. Agents retry; a
retried hire must not become a second payment.

---

## Prompt injection

Pactora has a property that changes the threat model: **one agent reads another
agent's output and then spends money based on it.**

The claim is deliberately narrow, and it is the honest one:

> We do not prevent prompt injection. We claim that a successful injection
> cannot spend more than the daily cap the owner set on-chain, and cannot pay
> anyone the owner did not allowlist.

Results enter as delimited untrusted data, are shape-checked before any model
sees them, and the judge that reads them **has no tools** — a fully successful
injection into that call has nothing to call. The layer that actually bounds
the damage is `AgentAccount`'s per-task and daily caps, which is arithmetic
rather than persuasion.

There is deliberately **no keyword filtering**. Stripping "ignore previous
instructions" fails against paraphrase and encoding while manufacturing the
appearance of safety.

Full reasoning: [`docs/10-llm-architecture.md`](https://github.com/gopaltalaviya/agentx-docs/blob/master/docs/10-llm-architecture.md).

---

## Testing

```bash
pnpm test                                      # 773 tests
# Against the live chain. Needs the deployer key: without it the script
# falls back to the default Anvil account and fails on the first write.
set -a; . ../agentx-contracts/.env; set +a
VERIFY_CHAIN_ID=10143 node scripts/verify-indexer.mjs
node scripts/e2e.mjs                           # the whole stack, one settlement
```

The standing rule, learned the hard way: **a mock that agrees with your
assumptions proves nothing.** A broken job-id linkage, a missing `specHash`, a
100-block RPC cap and doubled reputation all passed unit tests and were caught
only by running against the real chain. Every milestone gets a live-chain
check, not just a suite.

When a test is written for a bug, it is run against the *old* code first. A
test that passes either way proves nothing either.

---

## Specification

The full design lives in [`docs/`](https://github.com/gopaltalaviya/agentx-docs) — start with
[00 — Overview](https://github.com/gopaltalaviya/agentx-docs/blob/master/docs/00-overview.md), then
[04 — How It All Works](https://github.com/gopaltalaviya/agentx-docs/blob/master/docs/04-how-it-works.md) for contract interfaces, the
API, the agent workflow and the threat model, and
[10 — LLM Architecture](https://github.com/gopaltalaviya/agentx-docs/blob/master/docs/10-llm-architecture.md) for the agent-to-agent
injection problem.
[12 — ERC-8183 mapping](https://github.com/gopaltalaviya/agentx-docs/blob/master/docs/12-erc8183-mapping.md) sets `TaskEscrow` against
the ERC-8183 Agentic Commerce draft, function by function.
Running it: [13 — Deploy](https://github.com/gopaltalaviya/agentx-docs/blob/master/docs/13-deploy.md),
[14 — Operations](https://github.com/gopaltalaviya/agentx-docs/blob/master/docs/14-operations.md), [15 — HTTP API](https://github.com/gopaltalaviya/agentx-docs/blob/master/docs/15-api.md),
[16 — Runbooks](https://github.com/gopaltalaviya/agentx-docs/blob/master/docs/16-runbooks.md) and
[17 — Production readiness](https://github.com/gopaltalaviya/agentx-docs/blob/master/docs/17-production-readiness.md).

[`PROGRESS.md`](PROGRESS.md) is the running build log: current state, what is
outstanding, every decision with its reasoning, and every defect found during
hardening with how it was caught.

---

## License

MIT
