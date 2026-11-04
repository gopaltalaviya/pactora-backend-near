# Contributing

## Set up

```bash
nvm use                      # Node 22 (.nvmrc)
pnpm install                 # also installs the git hooks
docker compose up -d         # Postgres on 127.0.0.1:5442
DATABASE_URL=postgres://agentx:agentx@127.0.0.1:5442/agentx pnpm db:migrate
pnpm -r build
```

The contracts repository must be checked out next to this one
(`../agentx-contracts`): chain facts, parameters, addresses and ABIs are read
from it, never copied here.

## Before you push

```bash
pnpm check                   # typecheck (sources + tests), lint, format, tests
pnpm test:coverage           # coverage floors: 75/78/74/75
```

The pre-commit hook runs the secret scanner and Prettier and ESLint on staged
files. Do not bypass it.

## Rules this codebase keeps

- **A test that guards a fix must fail on the old code.** Run it against the
  code before the fix and see it fail; a test that passes either way proves
  nothing. Say so in the commit.
- **A mock that agrees with your assumptions proves nothing.** Anything that
  touches the chain gets a live check on testnet (`scripts/`), not only a unit
  test.
- **Never swallow an error.** `.catch(() => {})` is how failures vanished here
  before. Log it with context, or let it fail.
- **Secrets live in `.env` only** — never in `.env.example`, a log, a test or a
  commit.
- **Testnet only.** Any mainnet action needs explicit confirmation.
- Comments explain *why*, especially why the obvious approach was wrong.
- One logical change per commit; the message says what was wrong, what changed
  and how it was verified.
