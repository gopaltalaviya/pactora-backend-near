# One server: the hosting recipe (from the Monad baseline)

> **Status:** this is how the Monad (AGENTX) baseline was hosted, kept as the
> recipe for hosting Pactora on NEAR. That VPS was retired on 2026-11-06 and
> no Pactora-on-NEAR backend is hosted today. Paths below that name
> `agentx-contracts` refer to the Monad build; for NEAR read
> `pactora-contracts-near` and its `.env`.
>
> **NEAR (2026-11-08):** `docker-compose.full.yml` and this overlay now carry
> the NEAR variables; before that they set the EVM ones, which every NEAR
> service refuses at start, and the Dockerfile copied a `chain/export` that the
> NEAR layout does not have, so no image built. Checked locally: all seven
> images build and run as uid 1000; the stack (`ENABLED_CHAINS=near:sandbox`,
> the RPC on the host) reached `operational` with every component up, the
> indexer read the chain, and `POST /v1/agents/wallet-key` stored the new key
> encrypted. The merged config with this overlay publishes only Caddy's 80/443.

## NEAR testnet: the server's `.env`

Never committed. After `pactora-contracts-near` is deployed to testnet and
`node scripts/sync-chain-facts.mjs` has copied `deployments/testnet.json` into
`chain/` (and that is committed), build the images from that commit:

```bash
SIGNER_TOKEN=            # openssl rand -hex 24 — shared by api and signer
SIGNER_KEY_PASSPHRASE=   # openssl rand -hex 24 — encrypts the agents' wallet keys in Postgres; keep it, or those keys are lost
API_HOST=api.<ip-with-dashes>.sslip.io
CORS_ORIGINS=https://<the interface's Vercel URL>
ENABLED_CHAINS=near:testnet
DEFAULT_CHAIN=near:testnet
# The keeper (optional, recommended): its own gas-only testnet account.
KEEPER_ACCOUNT_ID=
KEEPER_SECRET_KEY=       # ed25519:… — testnet only
# Branch human-work only (docs/26). Both required by docker-compose.full.yml there:
OBJECT_STORE_SECRET_ACCESS_KEY=  # openssl rand -hex 24 — the evidence MinIO's password
WEBHOOK_SECRET_KEY=      # openssl rand -hex 32 — seals webhook secrets; shared by api and notifier; keep it, or every hook must be re-created
# Optional, testnet: the test-token faucet — a SEPARATE account with a limited
# mUSDC float and a little NEAR, never the token's owner (docs/08).
FAUCET_ACCOUNT_ID=
FAUCET_SECRET_KEY=       # ed25519:…
# Optional: RPC_URL_TESTNET, NEARDATA_API_KEY; model keys for live runs (§3b).
```

Then on Vercel: `NEXT_PUBLIC_API_URL=https://$API_HOST`, and redeploy.

One Ubuntu VPS (2 vCPU / 4 GB), the production images from
`docker-compose.full.yml`, and Caddy in front for HTTPS. Full steps:
agentx-docs, `docs/13-deploy.md` §5.

| File | What it does |
|---|---|
| `bootstrap-ubuntu.sh` | firewall (22, 80, 443 only), Docker, 2 GB swap, automatic security updates |
| `docker-compose.vps.yml` | Postgres and the API publish no port; Caddy alone listens on 80/443 |
| `Caddyfile` | HTTPS for `API_HOST`, certificate from Let's Encrypt, live events unbuffered |

```bash
docker compose -f docker-compose.full.yml -f docker-compose.vps.yml --profile hosted up -d --no-build
```

The server's `.env` holds `SIGNER_TOKEN`, `API_HOST` (e.g. `api.1-2-3-4.sslip.io`),
`CORS_ORIGINS` (the site's URL) and the hosted-run variables of §3b. It is
never committed.

## Backups

`backup.sh` dumps the database (`pg_dump -Fc`) to `~/agentx/backups/`, checks the
dump can be listed, and keeps 7 days. Installed with cron, daily at 03:00 UTC:

```bash
0 3 * * * /root/agentx/backup.sh >> /root/agentx/backups/backup.log 2>&1
```

Restore into a fresh database before the services start (the indexer keeps
its cursor and catches up):

```bash
docker compose -f docker-compose.full.yml -f docker-compose.vps.yml up -d postgres
docker exec -i agentx-full-postgres-1 pg_restore -U agentx -d agentx --no-owner < backups/agentx-YYYYMMDD-HHMM.dump
docker compose -f docker-compose.full.yml -f docker-compose.vps.yml --profile hosted up -d --no-build
```

Rehearsed 2026-10-08: a dump restored into a throwaway container matched the
live database row for row (agents, jobs, runs, API keys).

## Switching to v3 (after judging, 2026-11-03)

v2 stays exactly as it is until Monad Metropolis winners are announced. Then,
in this order — rehearsed end to end on a laptop on 2026-10-26 (PROGRESS.md):

1. **On your machine**, `agentx-backend` on `v3`:
   ```bash
   node scripts/sync-chain-facts.mjs --check          # chain/ is v3's
   SIGNER_TOKEN=placeholder-placeholder-placeholder-00 \
     OBJECT_STORE_SECRET_ACCESS_KEY=placeholder WEBHOOK_SECRET_KEY=placeholder \
     docker compose -f docker-compose.full.yml --profile hosted build   # human-work needs the two placeholders too
   docker save $(docker images --format '{{.Repository}}' | grep agentx-full)      postgres:16-alpine caddy:2-alpine alpine | gzip > agentx-v3-images.tar.gz
   scp agentx-v3-images.tar.gz docker-compose.full.yml deploy/vps/* root@<server>:agentx/
   ```
2. **On the server**: `cd ~/agentx && ./switch-to-v3.sh ~/agentx/agentx-v3-images.tar.gz`
   — final v2 dump, the v2 volume copied to `agentx-v2-pg-archive`, v2
   images tagged `:v2`, v3 up on a fresh database without the worker bots.
3. **On your machine**: retire the v2 hosted keys, then make v3's:
   ```bash
   set -a; . ../agentx-contracts/.env; set +a
   node scripts/seed-hosted.mjs --reclaim             # v2 keys' MON back to FUNDER
   mv artifacts/hosted-agents.json artifacts/hosted-agents.v2.json
   node scripts/seed-hosted.mjs https://<API_HOST>    # canonical registry, v3 escrow
   ```
4. **On the server**: replace the hosted variables in `.env` with the lines
   of `env.compose` in the new `artifacts/hosted-agents.json` — the signer's
   `SIGNER_DEV_PRIVATE_KEYS` and `SESSION_MANAGER_PRIVATE_KEY` (remove any
   old `SESSION_OWNER_PRIVATE_KEY` line: the signer refuses both) and the three
   `*_BOT_API_KEY`, already under the names the compose file reads — then
   `docker compose -f docker-compose.full.yml -f docker-compose.vps.yml --profile hosted up -d --no-build`.
5. **Check**: `node scripts/check-deployment.mjs https://<API_HOST>`,
   `/v1/status` operational with `gas.state: ok`, then one run from the site
   settles. The site needs no rebuild — no address is in it — unless the API
   URL changed; its v3 pages reach Vercel when `agentx-interface` `v3` is
   merged to `master`.

**Rollback** (v2 back as it was): `down`, `docker volume rm
agentx-full_agentx-full-pg`, copy `agentx-v2-pg-archive` back into a new
`agentx-full_agentx-full-pg` (the same `alpine cp -a`), retag each
`agentx-full-*:v2` as `:latest`, restore the v2 `.env`, `up -d --no-build`.
