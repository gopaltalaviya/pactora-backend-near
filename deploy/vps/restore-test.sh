#!/usr/bin/env bash
# Monthly restore test (docs/26 F28): a backup nobody has restored is a hope,
# not a backup. Restores the newest database backup into a scratch database
# beside the live one, compares it with the live schema, counts the rows of
# the tables that cannot be rebuilt from the chain, unpacks the newest
# evidence archive and counts its objects, then drops the scratch database.
# Exits non-zero on any mismatch. Installed by cron (see README.md):
#   0 4 1 * * /root/pactora/restore-test.sh >> /root/pactora/backups/restore-test.log 2>&1
#
# Reads the same BACKUP_DIR, BACKUP_PASSFILE, PG_CONTAINER, PG_USER and PG_DB
# as backup.sh. Never touches the live database's data: it reads its schema.
set -euo pipefail

DIR="${BACKUP_DIR:-$HOME/pactora/backups}"
PASSFILE="${BACKUP_PASSFILE:-$HOME/.pactora-backup-pass}"
PG_CONTAINER="${PG_CONTAINER:-pactora-full-postgres-1}"
PG_USER="${PG_USER:-pactora}"
PG_DB="${PG_DB:-pactora}"
SCRATCH="restore_test_$(date -u +%Y%m%d%H%M%S)"

# decrypt, and verify_hmac (audit I1): backup-lib.sh.
# shellcheck source=backup-lib.sh
. "$(dirname "$(readlink -f "$0")")/backup-lib.sh"
psql_in() { docker exec -i "$PG_CONTAINER" psql -v ON_ERROR_STOP=1 -U "$PG_USER" -d "$1" -tAq "${@:2}"; }
fail() {
  echo "$(date -u +%FT%TZ) restore test FAILED: $*" >&2
  exit 1
}

db="$(ls -1t "$DIR"/pactora-db-*.dump.enc 2>/dev/null | head -1 || true)"
[ -n "$db" ] || fail "no database backup in $DIR"
age_h=$((($(date +%s) - $(date -r "$db" +%s)) / 3600))
[ "$age_h" -le 48 ] || fail "the newest backup, $db, is ${age_h}h old: backup.sh is not running"

cleanup() { psql_in postgres -c "DROP DATABASE IF EXISTS $SCRATCH" > /dev/null 2>&1 || true; }
trap cleanup EXIT

# Integrity first: a changed byte must stop here, never reach pg_restore.
verify_hmac "$db" || fail "$db does not match its HMAC ($db.hmac missing or different): the backup was altered or truncated"

psql_in postgres -c "CREATE DATABASE $SCRATCH"
decrypt < "$db" | docker exec -i "$PG_CONTAINER" pg_restore -U "$PG_USER" -d "$SCRATCH" --no-owner --exit-on-error \
  || fail "pg_restore of $db"

tables_sql="SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema')"
restored="$(psql_in "$SCRATCH" -c "$tables_sql")"
live="$(psql_in "$PG_DB" -c "$tables_sql")"
[ "$restored" -gt 0 ] || fail "$db restored no tables"
# A migration since the backup makes these differ for a day; for longer, it is a fault.
[ "$restored" -eq "$live" ] || fail "$db restored $restored tables, the live database has $live"

# The tables that are not on chain: API keys, people's profiles, runs, evidence records.
counts="$(psql_in "$SCRATCH" -F' ' -c "
  SELECT string_agg(t || '=' || n, ' ' ORDER BY t) FROM (
    SELECT 'agents' t, count(*) n FROM agents UNION ALL
    SELECT 'api_keys', count(*) FROM api_keys UNION ALL
    SELECT 'jobs', count(*) FROM jobs UNION ALL
    SELECT 'runs', count(*) FROM runs UNION ALL
    SELECT 'job_files', count(*) FROM job_files UNION ALL
    SELECT 'public_profiles', count(*) FROM public_profiles UNION ALL
    SELECT 'signer_keys', count(*) FROM signer_keys
  ) c")"

ev="$(ls -1t "$DIR"/pactora-evidence-*.tar.enc 2>/dev/null | head -1 || true)"
evidence="no evidence archive"
if [ -n "$ev" ]; then
  verify_hmac "$ev" || fail "$ev does not match its HMAC: the archive was altered or truncated"
  list="$(decrypt < "$ev" | tar -tf -)" || fail "$ev does not decrypt to a tar"
  objects="$(printf '%s\n' "$list" | grep -vc '/$' || true)"
  evidence="$ev: $objects objects"
fi

echo "$(date -u +%FT%TZ) restore test ok: $db (HMAC verified) -> $restored tables (live $live); $counts; $evidence"
