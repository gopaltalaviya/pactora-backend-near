# Changelog

Notable changes. Dates are UTC. The full history, with evidence, is in
`PROGRESS.md` and the commit log.

## 2026-11-01 — Session 39 (code-level rename to Pactora, `v3`)
- **Breaking for anyone building on it:** packages `@agentx/*` →
  `@pactora/*`; env vars `AGENTX_*` → `PACTORA_*`; `AgentxClient`,
  `AgentxError`, `AgentxConfig` → `PactoraClient`, `PactoraError`,
  `PactoraConfig`; bins `pactora-mcp`, `pactora-config-check`; MCP server
  name `pactora`; error type URIs `https://pactoragents.com/errors/…`.
- Every entrypoint refuses to start while an `AGENTX_*` variable is set, and
  names the replacement.
- Unchanged: on-chain tags, x402 scheme ids, the `ax_` key prefix, database,
  docker and repo names.

## 2026-10-31 — Session 38 (rebrand to Pactora, `v3`)
- The product is now **Pactora** (formerly AGENTX) in everything a person
  reads: README, API text, OpenAPI title, MCP text, script output.
- The registration challenge opens `Pactora: register an agent.`; the key
  re-issue challenge `Pactora: issue a new API key, …`. The rest of each
  message is unchanged.
- Unchanged: on-chain tags, x402 scheme ids, package names, env vars,
  class names, error type URIs, database and repo names.

## 2026-10-07 — Session 33 (hosted live, every run outcome explained)
- Hosted: the site on Vercel, the backend on one VPS behind Caddy
  (`deploy/vps/`). Live runs from the site settle.
- `POST /v1/jobs/:id/decline`: a worker's off-chain "no", with a reason;
  `GET /v1/jobs/:id` shows `declined`; the SDK stops waiting on it at once.
- Workers: a 15 s triage timeout; a `blocker` named by the model, and only
  three kinds may decline (in code). Steps end `declined` with the reason.
- Runs that deliver nothing end `failed` with the reasons from their steps.
- Claude at max_tokens is a provider failure.
- Deep live test: an empty plan says the planner's reason; triage judges
  only the worker's own step, and a negative answer is an answer; a cancel
  refused as "not confirmed yet" is retried.
- Tests 528 → 558.

## 2026-10-06 — Session 32 (public, `master`, docs repo)
- All four repos public; the production branch is `master` (CI triggers
  follow).
- `docs/` moved to [agentx-docs](https://github.com/gopaltalaviya/agentx-docs) with its history;
  `docs/README.md` here points there. The API-doc test and CI read it from
  a sibling checkout; the video script writes into it; `pptxgenjs` left
  this repo with the deck.

## 2026-10-05 — Session 31 (hosted live runs)
- Hosted runs: `seed-hosted.mjs` (fresh keys, `--top-up`, `--reclaim`), the
  signer renews the hosted accounts' 24 h session keys, `RUNS_PER_DAY`,
  `INDEXER_START_AT_HEAD`, worker bots in the compose `hosted` profile.
- Agents: transient model errors retried; chains across Gemini models
  (`gemini:<model>`); headroom for thinking models and truncation handled;
  JSON found inside prose; hire idempotency keys are per run (a second run
  with the same goal reused a refunded job).
- Images build per service, one package at a time (parallel `tsc -b`
  segfaulted or hung).
- Tests 766 → 789; browser 62 → 63.

## 2026-10-05 — Session 30 (cross-browser, audit, rehearsal)
- Site: input typed before hydration is no longer lost (Safari, phones);
  a dropped live stream reconnects and never reads as "finished" (Firefox);
  a reconnect no longer duplicates the trace; wide docs tables are keyboard
  scrollable on phones. Browser tests run in five browsers on demand.
- Docs: an independent audit's 19 findings fixed; `.env.example` complete.
- Verified: no secret in any commit of any repo; live demo, e2e and
  indexer checks on testnet; production-image rehearsal green.
- Tests: 763 → 766, browser 61 → 62 (310 across five browsers).

## 2026-10-01 — Session 29 (search, guides, edge and worst cases)
- Site: Ctrl/⌘+K search over the docs, pages, actions and live agents —
  typo-tolerant, stemmed, synonym- and identifier-aware.
- Site: six captioned video guides at `/docs/guides`, recorded live on
  testnet (`scripts/video/guides.mjs`, shared `overlay.mjs`).
- `scripts/probe-api.mjs`: 416 hostile requests — zero 500s, no leaks.
- API: `/health` and `/ready` are exempt from the rate limit; a database
  outage is 503 `UPSTREAM_UNAVAILABLE` + `retry-after`, not 500; a stopped
  indexer reads "down", not "degraded"; the signer probe is coalesced, so a
  dead signer no longer makes `/v1/status` report the RPC down too
  (+`UV_THREADPOOL_SIZE=16` in the image); `connect_timeout` 30 s → 10 s;
  `SSE_MAX_STREAMS` configurable.
- Runs: the answer and steps are written before `finished` is published.
- Site: honest outage wording (no "nothing was spent" on writes), a lost
  live stream is said and links the record, register mirrors the API's
  limits, long names and a 320 px header fit, the status page says why.
- Demo: refuses taken ports, fails on a dead service, its own rate limit,
  a gas-payer preflight, six RPC retries in the harness.
- Tests: 730 → 763 (+8 backend, +25 interface) and 30 → 61 browser.

## 2026-09-30 — Session 27
- Signer: an HTTP 5xx/429 from the RPC is a retryable outage, not
  `INVALID_STATE` — found by the 20%-lossy chaos run, where workers gave up
  an accept and a finished submit.
- Orchestrator: when a late accept makes the cancel fail, wait for the
  delivery and settle it, instead of abandoning it; still never re-hire.
- Indexer: job state only moves forward — a trailing indexer no longer
  overwrites the API's newer state with an older event (a delivered job read
  `accepted`, and approve was refused). Found by the M5-06 timed runs.
- Deploy: images build from this repo alone (`chain/`, drift-checked in CI);
  Railway configs in `deploy/railway/`; runbook `docs/13-deploy.md`;
  `scripts/check-deployment.mjs` checks a hosted API and site.
- M5-06: three consecutive clean timed demo runs — 149, 153, 168 s.
- `slow-rpc.mjs`: `SLOW_RPC_FAIL_SEND`, a separate failure rate for
  broadcasts. Verified live at 20% + 30% on broadcasts: 4/4 settled.

## 2026-09-30 — v2 contracts and production hardening (Session 26)

### Contracts (agentx-contracts, redeployed to Monad testnet)
- Reputation farming by self-dealing: hires between two agents of one owner
  are refused; a minimum job amount and fee floor put a cost on every review.
- Payments never trap funds: an undeliverable payout is held and claimable.
- `DISPUTED` has a timeout; the keeper expires it in the worker's favour.
- Parameter bounds, per-job captured windows, two-step delayed admin.
- `AgentAccount`: per-(target, selector) allowlist, native sweep, two-step
  ownership, checked downcast; the factory only lets an owner create theirs.

### Backend
- The signer's per-agent lock could stay held forever; it is now taken and
  released on one reserved connection.
- API keys: indexed lookup + SHA-256 (auth was an O(keys) scrypt
  denial-of-service lever); IP rate limiting before authentication.
- Jobs and runs have unguessable public ids.
- Validated environment at boot; graceful shutdown; `/ready`; Prometheus
  metrics; request ids; helmet; SSE stream cap; SSE headers sent at once
  (a quiet stream used to connect only at the first 25 s heartbeat).
- The signer names contract refusals (`SameOwner()`, …) and never returns an
  internal message; the API reports an unreachable signer as a retryable
  outage, not an empty wallet.
- The indexer no longer halts on an RPC blip as if for a reorg.
- drizzle-orm 0.45.3 (GHSA-gpj5-g38j-94v9).
- ESLint, Prettier, type-checked tests, coverage floors, Dockerfile and a
  full-stack compose, CI with CodeQL, gitleaks and audit.
- Demo and e2e scripts: each worker owns its identity (so it can be hired
  under `SameOwner`) and its AGENTX record names that owner; `keeper-sweep`
  reports an expired dispute as the settlement it is.

### Interface (agentx-interface)
- Explorer links from the API pass an https + known-host allowlist (a
  `javascript:` URL used to reach an `href`); CSP and security headers; a
  production build without `NEXT_PUBLIC_API_URL` fails.
- uuid run ids validated server-side (real 404s); money shown as money;
  debounced, abortable marketplace filter; wallet inputs validated before
  the wallet is asked; one-time key with copy and leave-warning.
- Error, global-error and not-found boundaries; Open Graph metadata;
  labels, landmarks, focus ring, live regions.
- ESLint (jsx-a11y), Prettier, 40 unit tests, a Playwright smoke test of
  every page against a mocked API, audit clean (postcss override).

## 2026-09-30 — Session 25
- Worker `AgentAccount`s; the x402 facilitator and paid worker endpoints;
  the ERC-8183 mapping (docs/12).

## 2026-09-29 — Sessions 22–24
- First end-to-end runs on testnet; keeper; the orchestrator on an
  `AgentAccount`; chaos checklist complete; run history.
