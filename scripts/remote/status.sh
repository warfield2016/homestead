#!/usr/bin/env bash
# Runs ON THE SERVER. Prints where the node is: restoring the snapshot, catching up, or synced.
set -uo pipefail
NETWORK="${NETWORK:-mainnet}"
if [[ "$NETWORK" == "testnet" ]]; then DIR=/root/snapchain-testnet; FILE="-f docker-compose.testnet.yml"; else DIR=/root/snapchain; FILE=""; fi
cd "$DIR" 2>/dev/null || { echo "node: not installed (run ./homestead node)"; exit 0; }

# shellcheck disable=SC2086
cid="$(docker compose $FILE ps -q snapchain 2>/dev/null)"
if [[ -z "$cid" ]]; then echo "node: container not running"; exit 0; fi
echo "node: container $(docker inspect -f '{{.State.Status}} (up since {{.State.StartedAt}})' "$cid" | cut -c1-60)"

info="$(curl -s --max-time 5 localhost:3381/v1/info || true)"
if [[ -z "$info" ]]; then
  # The HTTP API comes up only after the snapshot is restored. Until then, read the logs.
  line="$(docker logs --tail 400 "$cid" 2>&1 | grep -E 'Downloading zipped snapshot chunk|Unzipping snapshot chunk|Unpacking snapshot file|Retrieving metadata' | tail -1)"
  if [[ "$line" =~ for\ shard\ ([0-9]+)\ \(([0-9]+)/([0-9]+)\ chunks\ in\ shard\)\ ?(.*) ]]; then
    echo "snapshot: downloading shard ${BASH_REMATCH[1]}: chunk ${BASH_REMATCH[2]} of ${BASH_REMATCH[3]} ${BASH_REMATCH[4]}"
    echo "          (shards restore one after another: 1, 2, then 0; each is unpacked right after it downloads)"
  elif [[ "$line" == *Unzipping* || "$line" == *Unpacking* ]]; then
    echo "snapshot: unpacking — ${line##*INFO }"
  else
    echo "snapshot: starting — ${line##*INFO }"
  fi
  echo "disk: $(df -h --output=used,avail "$DIR" | tail -1 | awk '{print $1" used, "$2" free"}')"
  exit 0
fi

echo "$info" | jq -r '
  "version: \(.version)   peers: see /v1/currentPeers   messages: \(.dbStats.numMessages)",
  (.shardInfos | sort_by(.shardId)[] |
    "shard \(.shardId): height \(.maxHeight)  " +
    (if .blockDelay < 30 then "in sync (\(.blockDelay)s behind)" else "catching up: \(.blockDelay)s behind" end))'
synced="$(echo "$info" | jq '[.shardInfos[].blockDelay] | all(. < 30)')"
[[ "$synced" == "true" ]] && echo "SYNCED" || echo "SYNCING"
