# Contributing

## Set up

```bash
nvm use                      # Node 22 (.nvmrc)
pnpm install                 # also installs the git hooks
docker compose up -d         # Postgres on 127.0.0.1:5443
DATABASE_URL=postgres://pactora:pactora@127.0.0.1:5443/pactora_near pnpm db:migrate
pnpm -r build
```

The contracts repository must be checked out next to this one
(`../pactora-contracts-near`). Its chain facts — network config, parameters
and deployment addresses — are copied into `chain/` by
`node scripts/sync-chain-facts.mjs` (`--check` compares them); `chain/` is
never edited by hand.

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
  touches the chain gets a live check on the local sandbox (`pnpm demo:local`) or testnet, not only a unit
  test.
- **Never swallow an error.** `.catch(() => {})` is how failures vanished here
  before. Log it with context, or let it fail.
- **Secrets live in `.env` only** — never in `.env.example`, a log, a test or a
  commit.
- **Testnet only.** Any mainnet action needs explicit confirmation.
- Comments explain *why*, especially why the obvious approach was wrong.
- One logical change per commit; the message says what was wrong, what changed
  and how it was verified.
