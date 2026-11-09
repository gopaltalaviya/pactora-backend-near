#!/usr/bin/env bash
# Health alerts on the VPS (docs/26 F28). Checks what would otherwise fail
# quietly and posts what is wrong to a chat webhook. Installed by cron (see
# README.md), every 5 minutes:
#   */5 * * * * /root/pactora/alerts.sh >> /root/pactora/backups/alerts.log 2>&1
#
#   1. readiness        GET /ready answers 200
#   2. status           /v1/status is `operational`; names each component that is not up
#   3. signer gas       /v1/status gas.state is not `low`
#   4. indexer lag      the indexer's cursor moved in the last INDEXER_STALE_S seconds
#   5. keeper backlog   no open escrow job is past its deadline by KEEPER_BACKLOG_S
#                       (held accounts excluded: the keeper skips those on purpose)
#   6. webhooks         no delivery gave up (status `failed`) in the last WEBHOOK_WINDOW_H hours
#   7. sanctions list   an active list exists and was fetched in the last SANCTIONS_MAX_AGE_H hours
#   8. backups          the newest database backup is under 26 hours old
#
# It posts only when the set of problems changes (a new one, or all clear),
# so a fault that lasts a day is one message, not 288. `--dry-run` prints
# the checks and posts nothing.
#
# Environment:
#   API_URL            default https://$API_HOST, else http://127.0.0.1:8080
#   ALERT_WEBHOOK_URL  Slack or Discord incoming webhook. Unset: printed only.
#   PG_CONTAINER, PG_USER, PG_DB, BACKUP_DIR   as backup.sh
#   PYTHON             default python3 (reads the status JSON)
set -uo pipefail

DRY=0
[ "${1:-}" = --dry-run ] && DRY=1

API_URL="${API_URL:-${API_HOST:+https://$API_HOST}}"
API_URL="${API_URL:-http://127.0.0.1:8080}"
PG_CONTAINER="${PG_CONTAINER:-pactora-full-postgres-1}"
PG_USER="${PG_USER:-pactora}"
PG_DB="${PG_DB:-pactora}"
DIR="${BACKUP_DIR:-$HOME/pactora/backups}"
PYTHON="${PYTHON:-python3}"
STATE="${ALERT_STATE_FILE:-$DIR/.alerts-last}"
INDEXER_STALE_S="${INDEXER_STALE_S:-600}"
KEEPER_BACKLOG_S="${KEEPER_BACKLOG_S:-1800}"
WEBHOOK_WINDOW_H="${WEBHOOK_WINDOW_H:-24}"
SANCTIONS_MAX_AGE_H="${SANCTIONS_MAX_AGE_H:-48}"

problems=()
ok() { echo "  ok    $1"; }
bad() {
  echo "  ALERT $1"
  problems+=("$1")
}
sql() { docker exec -i "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -tAq -c "$1" 2>/dev/null; }

echo "$(date -u +%FT%TZ) checks against $API_URL"

# 1. Readiness.
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$API_URL/ready")"
[ "$code" = 200 ] && ok "ready" || bad "API /ready answered ${code:-nothing} (want 200)"

# 2 and 3. Status and gas, read from one /v1/status.
status_json="$(curl -s --max-time 15 "$API_URL/v1/status")"
summary="$(printf '%s' "$status_json" | "$PYTHON" -c '
import json, sys
try:
    s = json.load(sys.stdin)
except Exception:
    print("unreadable unknown -"); sys.exit()
down = [k + "=" + v for k, v in (s.get("components") or {}).items() if v != "up"]
print(s.get("status", "unknown"), (s.get("gas") or {}).get("state", "unknown"), ",".join(down) or "-")
' 2>/dev/null)"
read -r overall gas down <<< "${summary:-unreadable unknown -}"
if [ "$overall" = operational ]; then
  ok "status operational"
elif [ "$down" = - ]; then
  bad "status is ${overall} (every component up: a low signer wallet or the model is the cause)"
else
  bad "status is ${overall} (components not up: ${down})"
fi
if [ "$gas" = low ]; then bad "a signer wallet is below its gas floor"; elif [ "$gas" = ok ]; then ok "signer gas ok"; else echo "  ?     signer gas ${gas} (no signer reading)"; fi

# 4. Indexer lag: the cursor advances with every indexed block.
idx="$(sql "SELECT coalesce(max(extract(epoch FROM now() - updated_at))::int, -1) FROM indexer_cursor")"
if [ -z "$idx" ]; then
  bad "database unreachable in $PG_CONTAINER"
elif [ "$idx" -lt 0 ]; then
  bad "the indexer has never written a cursor"
elif [ "$idx" -gt "$INDEXER_STALE_S" ]; then
  bad "indexer cursor last moved ${idx}s ago (limit ${INDEXER_STALE_S}s)"
else ok "indexer cursor moved ${idx}s ago"; fi

# 5. Keeper backlog: open escrow jobs the keeper should have closed by now.
backlog="$(sql "SELECT count(*) FROM jobs j WHERE j.path = 'escrow' AND j.chain_job_id IS NOT NULL
  AND now() - make_interval(secs => $KEEPER_BACKLOG_S) > CASE j.state
    WHEN 'created' THEN j.accept_deadline WHEN 'accepted' THEN j.work_deadline
    WHEN 'submitted' THEN j.review_deadline END
  AND NOT EXISTS (SELECT 1 FROM account_standing s
    WHERE s.agent_id IN (j.client_agent_id, j.worker_agent_id) AND s.standing <> 'clear')")"
if [ "${backlog:-x}" = 0 ]; then ok "keeper backlog empty"; else bad "keeper backlog: ${backlog:-?} job(s) past a deadline by over ${KEEPER_BACKLOG_S}s"; fi

# 6. Webhook deliveries that gave up.
hooks="$(sql "SELECT count(*) FROM webhook_deliveries WHERE status = 'failed' AND created_at > now() - interval '$WEBHOOK_WINDOW_H hours'")"
if [ "${hooks:-x}" = 0 ]; then ok "no failed webhook deliveries"; else bad "${hooks:-?} webhook deliveries failed in the last ${WEBHOOK_WINDOW_H}h"; fi

# 7. Sanctions list freshness.
lists="$(sql "SELECT count(*), coalesce(max(extract(epoch FROM now() - fetched_at) / 3600)::int, -1) FROM sanctions_list_versions WHERE active" | tr '|' ' ')"
read -r nlists age_h <<< "${lists:-0 -1}"
if [ "${nlists:-0}" = 0 ]; then
  bad "no active sanctions list: screening is off (run scripts/sanctions-refresh.mjs)"
elif [ "$age_h" -gt "$SANCTIONS_MAX_AGE_H" ]; then
  bad "sanctions list is ${age_h}h old (limit ${SANCTIONS_MAX_AGE_H}h): the daily refresh is not running"
else ok "sanctions lists: ${nlists} active, newest ${age_h}h old"; fi

# 8. Backups.
newest="$(ls -1t "$DIR"/pactora-db-*.dump.enc 2>/dev/null | head -1)"
if [ -z "$newest" ]; then
  bad "no database backup in $DIR"
else
  bh=$((($(date +%s) - $(date -r "$newest" +%s)) / 3600))
  if [ "$bh" -ge 26 ]; then bad "newest backup is ${bh}h old"; else ok "newest backup ${bh}h old"; fi
fi

# Post when the set of problems changed. Compared without its numbers: "moved
# 900s ago" then "moved 1200s ago" is the same fault, not a new one each run.
now_set="$(printf '%s\n' "${problems[@]+"${problems[@]}"}" | sed 's/[0-9][0-9]*/N/g' | sort)"
last_set="$(cat "$STATE" 2>/dev/null || true)"
if [ ${#problems[@]} -eq 0 ]; then
  message="Pactora: all checks pass again."
else
  message="Pactora: ${#problems[@]} problem(s) on ${API_URL}:"$'\n'"$(printf -- '- %s\n' "${problems[@]}")"
fi

if [ "$DRY" = 1 ]; then
  echo "dry run: would post (if changed):"
  echo "$message"
elif [ "$now_set" != "$last_set" ]; then
  posted=1
  if [ ${#problems[@]} -eq 0 ] && [ -z "$last_set" ]; then
    : # first run and healthy: nothing to say
  elif [ -n "${ALERT_WEBHOOK_URL:-}" ]; then
    body="$(printf '%s' "$message" | "$PYTHON" -c 'import json,sys; m=sys.stdin.read(); print(json.dumps({"text": m, "content": m}))')"
    # Not delivered (unreachable, or an HTTP error): keep the old state, so
    # the next run tries again instead of the alert being lost.
    curl -fsS --max-time 10 -H 'content-type: application/json' -d "$body" "$ALERT_WEBHOOK_URL" > /dev/null \
      || { echo "posting to ALERT_WEBHOOK_URL failed; will retry next run" >&2; posted=0; }
  else
    echo "ALERT_WEBHOOK_URL is unset: not posted" >&2
  fi
  if [ "$posted" = 1 ]; then
    mkdir -p "$(dirname "$STATE")"
    printf '%s' "$now_set" > "$STATE"
  fi
fi

[ ${#problems[@]} -eq 0 ]
