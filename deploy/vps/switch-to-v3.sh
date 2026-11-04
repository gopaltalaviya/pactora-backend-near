#!/usr/bin/env bash
# Switch the hosted testnet stack from v2 to v3. Run ON THE VPS, in ~/agentx,
# only after Monad Metropolis judging ends (2026-11-03) — v2 is what the
# judges use until then. Full sequence, including the steps on your own
# machine before and after this: README.md, "Switching to v3".
#
#   ./switch-to-v3.sh /root/agentx-v3-images.tar.gz
#
# What it does, and what it never does:
#   1. a final pg_dump of the v2 database (backup.sh), kept;
#   2. stops the stack and COPIES the v2 data volume to agentx-v2-pg-archive
#      — v2's rows point at the old escrow and mock registry, so v3 starts on
#      a fresh database; nothing of v2 is deleted;
#   3. tags the running v2 images :v2, then loads the v3 images (built on
#      your machine; this server never builds);
#   4. starts postgres → migrate (0001–0009) → signer, indexer, api, caddy,
#      WITHOUT the worker bots: they need the API keys that seed-hosted.mjs
#      makes against this new API.
set -euo pipefail
cd "$(dirname "$0")"

IMAGES="${1:?usage: switch-to-v3.sh <images.tar.gz>}"
COMPOSE=(docker compose -f docker-compose.full.yml -f docker-compose.vps.yml)
VOLUME="${PG_VOLUME:-agentx-full_agentx-full-pg}"
ARCHIVE=agentx-v2-pg-archive

[ -f "$IMAGES" ] || { echo "no $IMAGES"; exit 1; }
docker volume inspect "$VOLUME" > /dev/null
if docker volume inspect "$ARCHIVE" > /dev/null 2>&1; then
  echo "$ARCHIVE already exists: this switch has run before. Stopping."; exit 1
fi
read -r -p "Judging over and v2 retired? Type 'switch' to continue: " answer
[ "$answer" = switch ] || { echo aborted; exit 1; }

echo "== 1. final v2 backup"
./backup.sh

echo "== 2. stop, archive the v2 volume"
"${COMPOSE[@]}" --profile hosted down
docker volume create "$ARCHIVE" > /dev/null
docker run --rm -v "$VOLUME":/from:ro -v "$ARCHIVE":/to alpine sh -c 'cp -a /from/. /to/'
docker volume rm "$VOLUME" > /dev/null

echo "== 3. keep the v2 images as :v2 (for a rollback), load v3"
for image in $(docker images --format '{{.Repository}}:{{.Tag}}' | grep '^agentx-full-.*:latest$'); do
  docker tag "$image" "${image%:latest}:v2"
done
gunzip -c "$IMAGES" | docker load

echo "== 4. start v3 on a fresh database (no worker bots yet)"
"${COMPOSE[@]}" up -d --no-build postgres migrate signer indexer api caddy
for _ in $(seq 60); do
  if "${COMPOSE[@]}" exec -T api wget -qO- http://127.0.0.1:8080/ready > /dev/null 2>&1; then
    echo "api ready. Next, on your machine: seed-hosted.mjs (README, step 3)."
    exit 0
  fi
  sleep 5
done
echo "api not ready after 5 minutes:"; "${COMPOSE[@]}" ps; exit 1
