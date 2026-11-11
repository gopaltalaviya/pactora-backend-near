# Pactora — project instructions

Applies to the Pactora-on-NEAR repos: `pactora-contracts-near`,
`pactora-backend-near`, `pactora-interface-near`, `pactora-docs-near`.

## Deliverables are LOCAL FILES. Never Artifacts.

**Do not create, publish or update Claude Artifacts for this project.** No
artifact pages, no hosted decks, no `claude.ai/artifact/...` links — set
2026-09-28 by the project owner.

Everything that gets produced is a file on disk, committed to the repo it
belongs to:

| Deliverable | Format | Where |
|---|---|---|
| Slide decks | `.pptx`, or a self-contained `.html` | `pactora-docs-near/docs/deck/` |
| Documents, specs, notes | `.md` | `pactora-docs-near/docs/` |
| Pages and mockups | `.html` | the repo they belong to |
| Tables, budgets, checklists | `.xlsx` or `.csv` | `pactora-docs-near/docs/` |

Reasons this is the rule, so nobody reverses it by accident:

- The submission needs artefacts a judge can download and a repo link they can
  open. A private artifact page is neither.
- Everything in a repo is backed up and versioned. A hosted page is a second
  place for the truth to live, and two places drift.
- It keeps the whole project reviewable from one `git clone`.

## Standing rules

- **Testnet only.** Any mainnet action needs explicit per-action confirmation.
- **Never create a git repository or a remote.** The four that exist were
  created by the owner.
- Secrets live in `.env` only — never in chat, never in `.env.example` (which
  is tracked), never in a log or a commit.
- `AGENT_MODE=cached` is the default. Ask before any run that spends the
  owner's API quota.
- A mock that agrees with your assumptions proves nothing: every milestone
  gets a live-chain check.
- Run a new test against the OLD code first. If it passes either way it
  proves nothing.

## Start here

`pactora-backend-near/PROGRESS.md` — current state, blockers, decisions, and the
cold-start section for resuming after a closed terminal.
