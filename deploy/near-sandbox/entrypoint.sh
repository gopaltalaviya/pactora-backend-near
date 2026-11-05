#!/bin/sh
# Fresh chain every start: chain id "sandbox" (what config/networks.json
# expects), root account test.near. The root key is written to
# $NEAR_HOME/validator_key.json, which the deploy step reads from the shared volume.
set -e
NEAR_HOME=${NEAR_HOME:-/data}
rm -rf "$NEAR_HOME"/*
cd /opt/sandbox
npx near-sandbox --home "$NEAR_HOME" init --chain-id sandbox --account-id test.near
# Listen on all interfaces inside the container; the port is published to 127.0.0.1 only.
sed -i 's/"addr": "0.0.0.0:3030"/"addr": "0.0.0.0:3030"/; s/"addr": "127.0.0.1:3030"/"addr": "0.0.0.0:3030"/' "$NEAR_HOME/config.json"
chmod 644 "$NEAR_HOME/validator_key.json"
exec npx near-sandbox --home "$NEAR_HOME" run
