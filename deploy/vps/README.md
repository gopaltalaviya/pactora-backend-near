# One server: hosting Pactora on NEAR

The recipe for running the whole backend on one Ubuntu VPS (2 vCPU / 4 GB):
the production images from `docker-compose.full.yml`, Caddy in front for
HTTPS, the interface on Vercel. No Pactora backend is hosted today; this is
what to run when one is.

Checked locally on 2026-11-08: all seven images build and run as uid 1000;
the stack (`ENABLED_CHAINS=near:sandbox`, the RPC on the host) reached
`operational` with every component up, the indexer read the chain, and
`POST /v1/agents/wallet-key` stored the new key encrypted. The merged config
with this overlay publishes only Caddy's 80/443.

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
# Required by docker-compose.full.yml:
OBJECT_STORE_SECRET_ACCESS_KEY=  # openssl rand -hex 24 — the evidence MinIO's password
MINIO_KMS_SECRET_KEY=    # "pactora:$(head -c 32 /dev/urandom | base64)" — the evidence MinIO's encryption key; keep it with the backup passphrase, or no stored evidence can be read
WEBHOOK_SECRET_KEY=      # openssl rand -hex 32 — seals webhook secrets; shared by api and notifier; keep it, or every hook must be re-created
# Optional, testnet: the test-token faucet — a SEPARATE account with a limited
# mUSDC float and a little NEAR, never the token's owner (docs/08).
FAUCET_ACCOUNT_ID=
FAUCET_SECRET_KEY=       # ed25519:…
# Optional, testnet: the work-credential minter — the account the Credentials
# contract names as its minter, with ~1 NEAR for storage; the signer refuses to
# start if it is not the contract's minter. Used only once chain/deployments
# lists a Credentials contract.
MINTER_ACCOUNT_ID=
MINTER_SECRET_KEY=       # ed25519:…
# Optional: RPC_URL_TESTNET, NEARDATA_API_KEY; model keys for live runs (README "Models").
```

Then on Vercel: `NEXT_PUBLIC_API_URL=https://$API_HOST`, and redeploy.

Full steps: pactora-docs-near, `docs/13-deploy.md`.

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

The server's `.env` is the block under "NEAR testnet: the server's `.env`"
above. It is never committed.

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
BACKUP_PASSFILE=/root/.pactora-backup-pass
0 3 * * *   /root/pactora/backup.sh       >> /root/pactora/backups/backup.log 2>&1
0 4 1 * *   /root/pactora/restore-test.sh >> /root/pactora/backups/restore-test.log 2>&1
*/5 * * * * /root/pactora/alerts.sh       >> /root/pactora/backups/alerts.log 2>&1
30 2 * * *  cd /root/pactora && docker compose -f docker-compose.full.yml -f docker-compose.vps.yml run --rm --no-deps api node bin/sanctions-refresh.mjs >> /root/pactora/backups/sanctions.log 2>&1
```

**Sanctions lists, once at install and then daily (the last cron line).** A
fresh database has no list. Screening must be on in production, so until the
lists load an identity check answers 503 and `alerts.sh` raises "no active
sanctions list". The api image carries the refresh, because the server has
the images, not the repo:

```bash
docker compose -f docker-compose.full.yml -f docker-compose.vps.yml run --rm --no-deps api node bin/sanctions-refresh.mjs
# ofac: replace — 19563 entries … · un: replace — 1007 entries … · uk: replace — 6420 entries …
```

Checked on a Vultr `vc2-1c-2gb` (1 vCPU, 2 GB, Ubuntu 26.10, 2026-11-11):
`bootstrap-ubuntu.sh` fell back to Docker's 24.04 packages and worked. The
stack used ~260 MB of RAM at rest. Let's Encrypt issued for the sslip.io
name, and backup, restore-test, alerts and the refresh all passed. A
`backup.sh` bug that shows only on Linux was found and fixed there:
`pg_restore --list` closed the pipe early.

Running the overlay from the repo instead of the flat server folder: set
`CADDYFILE=./deploy/vps/Caddyfile`, or Docker mounts an empty directory in
its place and Caddy does not start.

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
PASSFILE=$HOME/.pactora-backup-pass; . ./backup-lib.sh   # on the server, in ~/pactora
verify_hmac backups/pactora-db-YYYYMMDD-HHMMSS.dump.enc || echo "REFUSE: the backup does not match its HMAC"
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass file:$HOME/.pactora-backup-pass \
  < backups/pactora-db-YYYYMMDD-HHMMSS.dump.enc \
  | docker exec -i pactora-full-postgres-1 pg_restore -U pactora -d pactora --no-owner --exit-on-error
# Evidence: MinIO and its bucket, then the archive uploaded again, encrypted
# (SSE-S3, as the api writes it; a plain upload would store it unencrypted).
# `mc` is only inside the MinIO container, so the files go in with docker cp.
docker compose -f docker-compose.full.yml -f docker-compose.vps.yml up -d --wait minio
docker compose -f docker-compose.full.yml -f docker-compose.vps.yml run --rm minio-setup
mkdir -p /tmp/ev && openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass file:$HOME/.pactora-backup-pass \
  < backups/pactora-evidence-YYYYMMDD-HHMMSS.tar.enc | tar -xf - -C /tmp/ev
docker cp /tmp/ev/pactora-evidence pactora-full-minio-1:/tmp/restore
docker exec pactora-full-minio-1 sh -c 'mc alias set store http://127.0.0.1:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null &&
  mc cp --quiet --recursive --enc-s3 store/pactora-evidence /tmp/restore/ store/pactora-evidence/'
docker exec -u 0 pactora-full-minio-1 rm -rf /tmp/restore && rm -rf /tmp/ev
docker compose -f docker-compose.full.yml -f docker-compose.vps.yml --profile hosted up -d --no-build
```

## Building the images on your machine

```bash
node scripts/sync-chain-facts.mjs --check          # chain/ matches the contracts repo
# Build-time placeholders only: compose interpolates these, the build uses none.
SIGNER_TOKEN=placeholder-placeholder-placeholder-00 SIGNER_KEY_PASSPHRASE=placeholder   OBJECT_STORE_SECRET_ACCESS_KEY=placeholder WEBHOOK_SECRET_KEY=placeholder MINIO_KMS_SECRET_KEY=placeholder   docker compose -f docker-compose.full.yml --profile hosted build
docker save $(docker images --format '{{.Repository}}' | grep pactora-full) postgres:16-alpine caddy:2-alpine alpine   | gzip > pactora-images.tar.gz
scp pactora-images.tar.gz docker-compose.full.yml deploy/vps/* root@<server>:pactora/
```

On the server, in `~/pactora`: `docker load < pactora-images.tar.gz`, write
the `.env`, then the `up` command above.
