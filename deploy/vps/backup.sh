#!/usr/bin/env bash
# Daily backup on the VPS (docs/26 F28): the database and the evidence bucket,
# each encrypted, checked, kept for 7 days, and copied off the host.
# Installed by cron (see README.md):
#   0 3 * * * /root/agentx/backup.sh >> /root/agentx/backups/backup.log 2>&1
#
# What a backup is worth: agents, API keys (hashed), jobs, runs, evidence and
# their history. Reputation and money are on chain and can be re-indexed;
# API keys, run records and evidence photos cannot.
#
# Environment (all optional but the passphrase file):
#   BACKUP_PASSFILE   file holding the encryption passphrase (chmod 600). Make
#                     one with `openssl rand -base64 32 > ~/.pactora-backup-pass`
#                     and keep a copy somewhere that is NOT this server: without
#                     it no backup can be read.
#   BACKUP_DIR        where backups go (default ~/agentx/backups)
#   BACKUP_REMOTE     off-host copy target for scp, e.g. backup@host:pactora/
#                     Unset: the run warns, because a backup on the same disk
#                     dies with the disk.
#   PG_CONTAINER, PG_USER, PG_DB          default agentx-full-postgres-1, agentx, agentx
#   MINIO_CONTAINER, OBJECT_STORE_BUCKET  default agentx-full-minio-1, pactora-evidence
#                     MINIO_CONTAINER=none skips the bucket.
#   KEEP_DAYS         default 7
set -euo pipefail

DIR="${BACKUP_DIR:-$HOME/agentx/backups}"
PASSFILE="${BACKUP_PASSFILE:-$HOME/.pactora-backup-pass}"
PG_CONTAINER="${PG_CONTAINER:-agentx-full-postgres-1}"
PG_USER="${PG_USER:-agentx}"
PG_DB="${PG_DB:-agentx}"
MINIO_CONTAINER="${MINIO_CONTAINER:-agentx-full-minio-1}"
BUCKET="${OBJECT_STORE_BUCKET:-pactora-evidence}"
KEEP_DAYS="${KEEP_DAYS:-7}"

if [ ! -s "$PASSFILE" ]; then
  echo "$(date -u +%FT%TZ) backup FAILED: no passphrase file at $PASSFILE (see the top of this script)" >&2
  exit 1
fi

mkdir -p "$DIR"
chmod 700 "$DIR"
# A run that fails half way leaves no half-written file to be mistaken for a backup.
trap 'rm -f "$DIR"/*.part' EXIT
stamp="$(date -u +%Y%m%d-%H%M)"

encrypt() { openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass "file:$PASSFILE"; }
decrypt() { openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "file:$PASSFILE"; }

# 1. The database.
db="$DIR/pactora-db-$stamp.dump.enc"
docker exec "$PG_CONTAINER" pg_dump -U "$PG_USER" -Fc "$PG_DB" | encrypt > "$db.part"
mv "$db.part" "$db"
chmod 600 "$db"
# A dump that decrypts but that pg_restore cannot list is not a backup.
tables="$(decrypt < "$db" | docker exec -i "$PG_CONTAINER" pg_restore --list | awk '$4 == "TABLE" && $5 != "DATA"' | wc -l)"
if [ "${tables:-0}" -eq 0 ]; then
  echo "$(date -u +%FT%TZ) backup FAILED: $db lists no tables" >&2
  exit 1
fi
made=("$db")

# 2. The evidence bucket: mirrored inside the MinIO container (it has `mc`
# but no tar), then streamed out as a tar by `docker cp`.
if [ "$MINIO_CONTAINER" != none ]; then
  ev="$DIR/pactora-evidence-$stamp.tar.enc"
  docker exec "$MINIO_CONTAINER" sh -c '
    rm -rf /tmp/pactora-mirror &&
    mc alias set backup http://127.0.0.1:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null &&
    mc mirror --quiet "backup/$1" /tmp/pactora-mirror/"$1" >/dev/null' _ "$BUCKET"
  docker cp "$MINIO_CONTAINER:/tmp/pactora-mirror/$BUCKET" - | encrypt > "$ev.part"
  docker exec "$MINIO_CONTAINER" rm -rf /tmp/pactora-mirror
  mv "$ev.part" "$ev"
  chmod 600 "$ev"
  list="$(decrypt < "$ev" | tar -tf -)" || {
    echo "$(date -u +%FT%TZ) backup FAILED: $ev does not decrypt to a tar" >&2
    exit 1
  }
  objects="$(printf '%s\n' "$list" | grep -vc '/$' || true)"
  made+=("$ev")
fi

# 3. Off the host.
if [ -n "${BACKUP_REMOTE:-}" ]; then
  scp -q -o BatchMode=yes "${made[@]}" "$BACKUP_REMOTE"
  where="copied to $BACKUP_REMOTE"
else
  where="WARNING: BACKUP_REMOTE is unset, this backup is on this host only"
  echo "$(date -u +%FT%TZ) $where" >&2
fi

find "$DIR" \( -name 'pactora-db-*.dump.enc' -o -name 'pactora-evidence-*.tar.enc' \) -mtime +"$KEEP_DAYS" -delete
echo "$(date -u +%FT%TZ) backup ok: $db ($tables tables, $(du -h "$db" | cut -f1))${ev:+, $ev (${objects:-0} objects, $(du -h "$ev" | cut -f1))}; $where"
