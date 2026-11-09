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
COMPLIANCE_REVIEWERS=    # two NEAR accounts, comma-separated: the api refuses to start in production without them
ENABLED_CHAINS=near:testnet
DEFAULT_CHAIN=near:testnet
# The keeper (optional, recommended): its own gas-only testnet account.
KEEPER_ACCOUNT_ID=
KEEPER_SECRET_KEY=       # ed25519:… — testnet only
# Branch human-work only (docs/26). Both required by docker-compose.full.yml there:
OBJECT_STORE_SECRET_ACCESS_KEY=  # openssl rand -hex 24 — the evidence MinIO's password
MINIO_KMS_SECRET_KEY=    # "pactora:$(head -c 32 /dev/urandom | base64)" — the evidence MinIO's encryption key; keep it with the backup passphrase, or no stored evidence can be read
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
| `Caddyfile` | HTTPS for `API_HOST`, certificate from Let's Encrypt, live events unbuffered, `/metrics` answers 404 at the edge |
| `backup.sh` | daily: the database and the evidence bucket, encrypted and HMAC'd, checked, copied off the host |
| `backup-lib.sh` | shared by the two above: encrypt/decrypt and the HMAC beside every `.enc` (`backup-lib.test.sh` exercises it) |
| `restore-test.sh` | monthly: verifies the newest backup's HMAC, restores it into a scratch database and compares it with the live schema |
| `alerts.sh` | every 5 minutes: readiness, status, signer gas, indexer lag, keeper backlog, failed webhooks, sanctions-list age, backup age |

```bash
docker compose -f docker-compose.full.yml -f docker-compose.vps.yml --profile hosted up -d --no-build
```

The server's `.env` holds `SIGNER_TOKEN`, `API_HOST` (e.g. `api.1-2-3-4.sslip.io`),
`CORS_ORIGINS` (the site's URL) and the hosted-run variables of §3b. It is
never committed.

## Backups, restore test and alerts (docs/26 F28)

Once, on the server — the passphrase that encrypts every backup. **Keep a copy
off this server** (a password manager): without it no backup can be read.

```bash
openssl rand -base64 32 > ~/.pactora-backup-pass && chmod 600 ~/.pactora-backup-pass
```

Cron (`crontab -e`), with the variables the scripts read:

```bash
BACKUP_REMOTE=backup@<another host>:pactora/   # off-host copy over scp (key-based); unset, each run warns
ALERT_WEBHOOK_URL=https://hooks.slack.com/...  # or a Discord webhook; unset, alerts are only logged
API_HOST=api.<ip-with-dashes>.sslip.io
0 3 * * *   /root/agentx/backup.sh       >> /root/agentx/backups/backup.log 2>&1
0 4 1 * *   /root/agentx/restore-test.sh >> /root/agentx/backups/restore-test.log 2>&1
*/5 * * * * /root/agentx/alerts.sh       >> /root/agentx/backups/alerts.log 2>&1
```

- `backup.sh` writes `pactora-db-<stamp>.dump.enc` (`pg_dump -Fc`) and
  `pactora-evidence-<stamp>.tar.enc` (the bucket via `mc mirror`), both
  AES-256 with the passphrase (`openssl enc -pbkdf2`), each with an
  HMAC-SHA256 beside it (`<file>.hmac`, keyed from the passphrase under its
  own label — `backup-lib.sh`): CBC alone does not detect a changed byte. It
  verifies the HMAC, decrypts each back and lists it — a dump that does not
  list is a failed run, not a backup — copies all four files to
  `BACKUP_REMOTE`, and keeps 7 days locally.
- `restore-test.sh` verifies the newest dump's HMAC (a missing or different
  `.hmac` fails the run before anything is decrypted), restores it into a
  scratch database, fails if its table count differs from the live one or
  the dump is over 48 h old,
  counts the rows that are not on chain (agents, API keys, jobs, runs,
  evidence records, profiles) and the evidence objects, then drops the
  scratch database.
- `alerts.sh` posts only when the set of problems changes, and once more when
  all is clear. `alerts.sh --dry-run` prints every check and posts nothing.

Checked locally on 2026-11-08 against the dev Postgres and MinIO, a real API
and indexer on a NEAR sandbox: a backup listed 51 tables and the 7 evidence
objects, and restored with 51 tables. A wrong passphrase, a truncated dump, a
truncated evidence archive, an empty directory, a missing passphrase file and
an extra table in the live database each failed the run. Each alert fired on
its condition and cleared after it: a job 2 h past its deadline (silent while
its client was on hold), a 73 h-old sanctions list, a failed delivery, the
signer down. The Caddyfile validated in `caddy:2-alpine`, and in front of the
API it answered 404 to `/metrics` and 200 to `/health`. Not yet run on a server.

Restore into a fresh database before the services start (the indexer keeps
its cursor and catches up):

```bash
# --wait: without it pg_restore races the database's first start and fails.
docker compose -f docker-compose.full.yml -f docker-compose.vps.yml up -d --wait postgres
# Integrity first (backup-lib.sh): stop if the file was altered or truncated.
PASSFILE=$HOME/.pactora-backup-pass; . deploy/vps/backup-lib.sh
verify_hmac backups/pactora-db-YYYYMMDD-HHMMSS.dump.enc || echo "REFUSE: the backup does not match its HMAC"
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass file:$HOME/.pactora-backup-pass \
  < backups/pactora-db-YYYYMMDD-HHMMSS.dump.enc \
  | docker exec -i agentx-full-postgres-1 pg_restore -U agentx -d agentx --no-owner --exit-on-error
# Evidence: MinIO and its bucket, then the archive uploaded again, encrypted
# (SSE-S3, as the api writes it; a plain upload would store it unencrypted).
# `mc` is only inside the MinIO container, so the files go in with docker cp.
docker compose -f docker-compose.full.yml -f docker-compose.vps.yml up -d --wait minio
docker compose -f docker-compose.full.yml -f docker-compose.vps.yml run --rm minio-setup
mkdir -p /tmp/ev && openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass file:$HOME/.pactora-backup-pass \
  < backups/pactora-evidence-YYYYMMDD-HHMMSS.tar.enc | tar -xf - -C /tmp/ev
docker cp /tmp/ev/pactora-evidence agentx-full-minio-1:/tmp/restore
docker exec agentx-full-minio-1 sh -c 'mc alias set store http://127.0.0.1:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null &&
  mc cp --quiet --recursive --enc-s3 store/pactora-evidence /tmp/restore/ store/pactora-evidence/'
docker exec -u 0 agentx-full-minio-1 rm -rf /tmp/restore && rm -rf /tmp/ev
docker compose -f docker-compose.full.yml -f docker-compose.vps.yml --profile hosted up -d --no-build
```

Rehearsed 2026-10-08 (Monad, the older unencrypted script): a dump restored into a throwaway container matched the
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
