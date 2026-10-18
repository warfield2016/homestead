#!/usr/bin/env bash
# Runs ON THE SERVER as root. Builds and starts the Homestead client from /opt/homestead.
# Inputs: HOMESTEAD_HOST, NETWORK, PUBLIC=yes|no.
set -euo pipefail
cd /opt/homestead/deploy
secure=true
[[ "${PUBLIC:-yes}" == "yes" ]] || secure=false
cat >.env <<ENV
HOMESTEAD_HOST=${HOMESTEAD_HOST}
HOMESTEAD_NETWORK=${NETWORK:-mainnet}
SECURE_COOKIES=${secure}
ENV
profile=()
[[ "${PUBLIC:-yes}" == "yes" ]] && profile=(--profile public)
echo "    building the client image from source (first time: ~1 minute)"
docker compose "${profile[@]}" up -d --build --remove-orphans 2>&1 | grep -vE '^\s*$' | tail -5 | sed 's/^/    /'
# Stop Caddy if this deploy is private (it may be left over from a public deploy).
[[ "${PUBLIC:-yes}" == "yes" ]] || docker compose --profile public stop caddy >/dev/null 2>&1 || true
for _ in $(seq 1 30); do
  curl -sf localhost:8080/api/status >/dev/null && break
  sleep 2
done
curl -sf localhost:8080/api/status >/dev/null || { docker compose logs --tail 30 client; exit 1; }
echo "    client is up on localhost:8080"
