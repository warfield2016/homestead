# shellcheck shell=bash
# Command 0 on Hetzner Cloud: one server + one 2 TB block volume + a firewall.
#
# Why these resources:
#   - Snapchain wants 4 vCPU, 16 GB RAM and 2 TB of disk. No Hetzner cloud plan has 2 TB of
#     local disk, so the database lives on an attached volume mounted at ~/snapchain.
#   - Snapchain publishes arm64 images, so the cheapest fit is often an ARM (CAX) server.
#   - The firewall opens only what the node and client need. Grafana (3000) and statsd stay
#     closed to the internet.
#
# API reference: https://docs.hetzner.cloud/

HCLOUD_API="${HCLOUD_API:-https://api.hetzner.cloud/v1}"
HETZNER_VOLUME_GB="${HOMESTEAD_DISK_GB:-2000}"

hetzner() { api "$1" "$HCLOUD_API$2" "$HCLOUD_TOKEN" "${3:-}"; }

hetzner_provision() {
  local location="${HOMESTEAD_LOCATION:-fsn1}" forced_type="${HOMESTEAD_SERVER_TYPE:-}"
  explain "Get a token: Hetzner Console → your project → Security → API tokens → Read & Write."
  explain "Use a new, empty project so this token can't touch anything else."
  HCLOUD_TOKEN="$(ask_secret HCLOUD_TOKEN "Hetzner API token (input hidden; not saved)")"

  step "Finding the cheapest server with ≥4 vCPU and ≥16 GB RAM in $location"
  local types datacenters available
  types="$(hetzner GET /server_types?per_page=50)"
  datacenters="$(hetzner GET "/datacenters?per_page=50")"
  # Server type ids that are actually in stock in this location right now.
  available="$(jq -c --arg loc "$location" '[.datacenters[] | select(.location.name == $loc) | .server_types.available[]] | unique' <<<"$datacenters")"
  [[ "$available" != "[]" ]] || die "no datacenter found for location '$location' (try fsn1, nbg1, hel1, ash, hil)"

  local choice
  choice="$(jq -c --arg loc "$location" --arg forced "$forced_type" --argjson avail "$available" '
    [.server_types[]
      | select(.deprecation == null)
      | select(.cores >= 4 and .memory >= 16)
      | select(.id as $id | $avail | index($id))
      | select($forced == "" or .name == $forced)
      | . as $t
      | (.prices[] | select(.location == $loc)) as $p
      | {name, cores, memory, architecture, cpu_type, monthly: ($p.price_monthly.gross | tonumber), hourly: ($p.price_hourly.gross | tonumber)}]
    | sort_by(.monthly) | first' <<<"$types")"
  [[ "$choice" != "null" ]] || die "no server type with ≥4 vCPU / ≥16 GB is available in $location right now. Try HOMESTEAD_LOCATION=nbg1 (or hel1, ash, hil)."

  local pricing volume_per_gb currency server_type server_monthly server_hourly volume_monthly total_monthly per_day
  pricing="$(hetzner GET /pricing)"
  currency="$(jq -r '.pricing.currency' <<<"$pricing")"
  volume_per_gb="$(jq -r '.pricing.volume.price_per_gb_month.gross' <<<"$pricing")"
  server_type="$(jq -r .name <<<"$choice")"
  server_monthly="$(jq -r .monthly <<<"$choice")"
  server_hourly="$(jq -r .hourly <<<"$choice")"
  volume_monthly="$(awk -v g="$HETZNER_VOLUME_GB" -v p="$volume_per_gb" 'BEGIN { printf "%.2f", g * p }')"
  total_monthly="$(awk -v a="$server_monthly" -v b="$volume_monthly" 'BEGIN { printf "%.2f", a + b }')"
  # Hetzner bills hourly, capped at the monthly price; a one-day test costs about 1/30 of a month.
  per_day="$(awk -v a="$server_hourly" -v b="$volume_monthly" 'BEGIN { printf "%.2f", a * 24 + b / 30 }')"

  info "Server:  $server_type — $(jq -r '"\(.cores) vCPU (\(.architecture), \(.cpu_type)), \(.memory) GB RAM"' <<<"$choice") — $currency $(printf '%.2f' "$server_monthly")/month"
  info "Volume:  $HETZNER_VOLUME_GB GB block storage for the Snapchain database — $currency $volume_monthly/month"
  info "Total:   ${BOLD}$currency $total_monthly/month${RESET}, billed by the hour (≈ $currency $per_day per day). Delete it any time with ./homestead destroy."
  confirm_word PROVISION "This creates billable resources in your Hetzner project."

  ensure_ssh_key
  local name
  name="homestead-$(date +%Y%m%d-%H%M)"
  local labels='{"managed-by":"homestead"}'

  step "Uploading this machine's Homestead SSH key"
  local ssh_key_id
  ssh_key_id="$(hetzner POST /ssh_keys "$(jq -nc --arg n "$name" --arg k "$(cat "$SSH_KEY.pub")" --argjson l "$labels" '{name: $n, public_key: $k, labels: $l}')" | jq -r '.ssh_key.id')"
  state_set PROVIDER hetzner
  state_set HETZNER_SSH_KEY_ID "$ssh_key_id"
  ok "ssh key $ssh_key_id"

  step "Creating a firewall"
  local rules firewall_id
  rules="$(jq -nc '[
      {port: "22",   protocol: "tcp", description: "ssh"},
      {port: "80",   protocol: "tcp", description: "https certificate challenge"},
      {port: "443",  protocol: "tcp", description: "homestead client (https)"},
      {port: "3381", protocol: "tcp", description: "snapchain http api"},
      {port: "3382", protocol: "udp", description: "snapchain gossip (quic)"},
      {port: "3383", protocol: "tcp", description: "snapchain grpc api"}
    ] | map(. + {direction: "in", source_ips: ["0.0.0.0/0", "::/0"]})
      + [{direction: "in", protocol: "icmp", source_ips: ["0.0.0.0/0", "::/0"]}]')"
  firewall_id="$(hetzner POST /firewalls "$(jq -nc --arg n "$name" --argjson r "$rules" --argjson l "$labels" '{name: $n, rules: $r, labels: $l}')" | jq -r '.firewall.id')"
  state_set HETZNER_FIREWALL_ID "$firewall_id"
  ok "firewall $firewall_id: 22, 80, 443, 3381, 3382/udp, 3383"

  step "Creating a ${HETZNER_VOLUME_GB} GB volume (formatted ext4)"
  local volume volume_id device
  volume="$(hetzner POST /volumes "$(jq -nc --arg n "$name" --arg loc "$location" --argjson s "$HETZNER_VOLUME_GB" --argjson l "$labels" \
    '{name: $n, size: $s, location: $loc, format: "ext4", automount: false, labels: $l}')")"
  volume_id="$(jq -r '.volume.id' <<<"$volume")"
  device="$(jq -r '.volume.linux_device' <<<"$volume")"
  state_set HETZNER_VOLUME_ID "$volume_id"
  state_set DATA_DEVICE "$device"
  ok "volume $volume_id → $device"

  step "Creating server $name ($server_type, Ubuntu 24.04)"
  local server server_id ip
  server="$(hetzner POST /servers "$(jq -nc --arg n "$name" --arg t "$server_type" --arg loc "$location" \
    --argjson key "$ssh_key_id" --argjson fw "$firewall_id" --argjson vol "$volume_id" --argjson l "$labels" \
    '{name: $n, server_type: $t, image: "ubuntu-24.04", location: $loc, ssh_keys: [$key],
      firewalls: [{firewall: $fw}], volumes: [$vol], automount: false, labels: $l,
      public_net: {enable_ipv4: true, enable_ipv6: true}}')")"
  server_id="$(jq -r '.server.id' <<<"$server")"
  ip="$(jq -r '.server.public_net.ipv4.ip' <<<"$server")"
  state_set HETZNER_SERVER_ID "$server_id"
  state_set HOST "$ip"
  state_set SSH_USER root
  state_set ARCH "$(jq -r .architecture <<<"$choice")"
  ok "server $server_id at $ip"

  [[ -n "${HOMESTEAD_DRY_RUN:-}" ]] && return 0
  step "Waiting for the server to boot"
  until [[ "$(hetzner GET "/servers/$server_id" | jq -r '.server.status')" == "running" ]]; do sleep 3; done
  wait_for_ssh
  ok "ssh root@$ip works"
}

hetzner_destroy() {
  HCLOUD_TOKEN="$(ask_secret HCLOUD_TOKEN "Hetzner API token (input hidden; not saved)")"
  local server_id volume_id firewall_id ssh_key_id
  server_id="$(state_get HETZNER_SERVER_ID)"
  volume_id="$(state_get HETZNER_VOLUME_ID)"
  firewall_id="$(state_get HETZNER_FIREWALL_ID)"
  ssh_key_id="$(state_get HETZNER_SSH_KEY_ID)"

  if [[ -n "$server_id" ]]; then
    step "Deleting server $server_id"
    hetzner DELETE "/servers/$server_id" >/dev/null || true
    # The volume can only be deleted once the server has released it.
    while [[ -n "$volume_id" && "$(hetzner GET "/volumes/$volume_id" | jq -r '.volume.server // "null"')" != "null" ]]; do sleep 3; done
  fi
  [[ -n "$volume_id" ]] && { step "Deleting volume $volume_id (the Snapchain database)"; hetzner DELETE "/volumes/$volume_id" >/dev/null; }
  [[ -n "$firewall_id" ]] && { step "Deleting firewall $firewall_id"; hetzner DELETE "/firewalls/$firewall_id" >/dev/null || true; }
  [[ -n "$ssh_key_id" ]] && { step "Deleting ssh key $ssh_key_id"; hetzner DELETE "/ssh_keys/$ssh_key_id" >/dev/null || true; }
  ok "nothing left billing in Hetzner from this Homestead"
}
