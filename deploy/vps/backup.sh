#!/usr/bin/env bash
# Daily database backup on the VPS: a compressed pg_dump of the Pactora
# database, kept for 7 days. Installed by cron (see README.md):
#   0 3 * * * /root/agentx/backup.sh >> /root/agentx/backups/backup.log 2>&1
#
# What a backup is worth: agents, API keys (hashed), jobs, runs and their
# history. Reputation and money are on chain and can be re-indexed; API keys
# and run records cannot.
set -euo pipefail

DIR="${BACKUP_DIR:-$HOME/agentx/backups}"
CONTAINER="${PG_CONTAINER:-agentx-full-postgres-1}"
KEEP_DAYS="${KEEP_DAYS:-7}"
mkdir -p "$DIR"
chmod 700 "$DIR"

out="$DIR/agentx-$(date -u +%Y%m%d-%H%M).dump"
docker exec "$CONTAINER" pg_dump -U agentx -Fc agentx > "$out.part"
mv "$out.part" "$out"
chmod 600 "$out"

# A dump that pg_restore cannot list is not a backup.
docker exec -i "$CONTAINER" pg_restore --list < "$out" > /dev/null

find "$DIR" -name 'agentx-*.dump' -mtime +"$KEEP_DAYS" -delete
echo "$(date -u +%FT%TZ) backup ok: $out ($(du -h "$out" | cut -f1))"
