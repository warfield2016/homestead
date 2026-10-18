#!/usr/bin/env bash
# Runs ON THE SERVER as root (./homestead node pipes it over ssh).
# Sets up a Snapchain read node using Farcaster's own snapchain.sh, plus three things it
# doesn't do for you: mount the data volume, keep Grafana/statsd off the internet, and skip
# the interactive prompts (you already answered them on your laptop).
#
# Inputs (environment): NETWORK=mainnet|testnet, DATA_DEVICE (optional block device),
# OPERATOR_FID (used only to pick the auto-upgrade weekday), AGREED=yes.
set -euo pipefail

NETWORK="${NETWORK:-mainnet}"
if [[ "$NETWORK" == "testnet" ]]; then DIR=/root/snapchain-testnet; else DIR=/root/snapchain; fi
log() { printf '    %s\n' "$*"; }

[[ "${AGREED:-}" == "yes" ]] || { echo "refusing to run: the no-rewards agreement was not accepted"; exit 1; }

log "installing curl, jq"
export DEBIAN_FRONTEND=noninteractive
if command -v apt-get >/dev/null; then
  apt-get update -qq >/dev/null
  apt-get install -y -qq curl jq ca-certificates >/dev/null
fi

# --- 1. disk -----------------------------------------------------------------------------
mkdir -p "$DIR"
if [[ -n "${DATA_DEVICE:-}" ]]; then
  for _ in $(seq 1 30); do [[ -e "$DATA_DEVICE" ]] && break; sleep 2; done
  [[ -e "$DATA_DEVICE" ]] || { echo "data volume $DATA_DEVICE never appeared"; exit 1; }
  # Only format a volume that has no filesystem yet. Never wipe an existing database.
  if ! blkid "$DATA_DEVICE" >/dev/null 2>&1; then
    log "formatting $DATA_DEVICE (empty volume)"
    mkfs.ext4 -q -F "$DATA_DEVICE"
  fi
  if ! mountpoint -q "$DIR"; then
    uuid="$(blkid -s UUID -o value "$DATA_DEVICE")"
    grep -q "$uuid" /etc/fstab || echo "UUID=$uuid $DIR ext4 defaults,nofail,noatime 0 2" >>/etc/fstab
    mount "$DIR"
  fi
  log "database volume mounted at $DIR"
fi
avail_gb="$(df -BG --output=avail "$DIR" | tail -1 | tr -dc '0-9')"
log "free space for the database: ${avail_gb} GB"
if [[ "$NETWORK" == "mainnet" && "$avail_gb" -lt 1700 ]]; then
  # Restore keeps every compressed chunk (~400 GB) and each shard's uncompressed tar until
  # the very end, next to the unpacked database (~550 GB): ~1.5 TB at the peak.
  echo "    WARNING: under 1.7 TB free. Restoring the mainnet snapshot peaks around 1.5 TB"
  echo "    (compressed chunks + uncompressed tars + the database). Expect it to run out of space."
fi

# --- 2. docker ---------------------------------------------------------------------------
if ! command -v docker >/dev/null; then
  log "installing Docker (get.docker.com, the official convenience script)"
  curl -fsSL https://get.docker.com | sh >/dev/null
fi
systemctl enable --now docker >/dev/null 2>&1 || true
docker compose version >/dev/null || { echo "docker compose plugin missing"; exit 1; }
log "$(docker --version)"

cd "$DIR"

# --- 3a. testnet: there is no snapchain.sh for testnet; use its compose file directly ----
if [[ "$NETWORK" == "testnet" ]]; then
  curl -fsSL -o docker-compose.testnet.yml "https://raw.githubusercontent.com/farcasterxyz/snapchain/@latest/docker-compose.testnet.yml"
  docker compose -f docker-compose.testnet.yml up -d snapchain
  log "testnet read node started"
  exit 0
fi

# --- 3b. mainnet: Farcaster's own installer ----------------------------------------------
# Pre-answer its two questions so it can run unattended:
#   AGREE_NO_REWARDS_FOR_ME — you typed "Yes" to this on your laptop.
#   HUB_OPERATOR_FID        — only used to choose the weekday for the weekly auto-upgrade.
touch .env
grep -q '^AGREE_NO_REWARDS_FOR_ME=' .env || echo "AGREE_NO_REWARDS_FOR_ME=true" >>.env
grep -q '^HUB_OPERATOR_FID=' .env || echo "HUB_OPERATOR_FID=${OPERATOR_FID:-0}" >>.env

# snapchain.sh publishes Grafana (admin/admin) and statsd on every interface. The cloud
# firewall already blocks them, but defense in depth: bind them to localhost. Overrides go in
# docker-compose.override.yml, which snapchain.sh never touches (per its docs).
cat >docker-compose.override.yml <<'YAML'
# Written by Homestead: keep the metrics stack private. View Grafana via
#   ssh -L 3000:localhost:3000 root@<server>   then open http://localhost:3000
services:
  grafana:
    ports: !override
      - "127.0.0.1:3000:3000"
  statsd:
    ports: !override
      - "127.0.0.1:8125:8125/udp"
      - "127.0.0.1:8126:8126"
YAML

curl -fsSL -o snapchain.sh "https://raw.githubusercontent.com/farcasterxyz/snapchain/@latest/scripts/snapchain.sh"
chmod +x snapchain.sh

# `snapchain.sh upgrade` ends by following the logs forever. Run it in the background and stop
# the log tail once it reports success; the node keeps running under Docker.
log "running snapchain.sh upgrade (installs config, Grafana, the auto-upgrade cron job, starts the node)"
./snapchain.sh upgrade </dev/null >upgrade.log 2>&1 &
pid=$!
while kill -0 "$pid" 2>/dev/null; do
  if grep -q "Upgrade complete" upgrade.log; then
    sleep 5
    pkill -f "logs --tail 100 -f snapchain" || true
    break
  fi
  sleep 3
done
wait "$pid" 2>/dev/null || true
if ! grep -q "Upgrade complete" upgrade.log; then
  echo "snapchain.sh did not finish. Last lines of $DIR/upgrade.log:"
  tail -30 upgrade.log
  exit 1
fi
log "snapchain.sh finished; node container: $(docker inspect -f '{{.State.Status}}' "$(docker compose ps -q snapchain)" 2>/dev/null || echo unknown)"
