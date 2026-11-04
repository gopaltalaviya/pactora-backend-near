# One server: the live deployment

The backend as it runs today: one Ubuntu VPS (2 vCPU / 4 GB), the production
images from `docker-compose.full.yml`, and Caddy in front for HTTPS. The site
is on Vercel. Full steps: agentx-docs, `docs/13-deploy.md` §5.

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
   SIGNER_TOKEN=placeholder-placeholder-placeholder-00      docker compose -f docker-compose.full.yml --profile hosted build
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
