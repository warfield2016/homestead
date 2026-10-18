# shellcheck shell=bash
# Command 0 on DigitalOcean: one droplet + one 2 TB volume + a cloud firewall.
# Same shape as the Hetzner path; DigitalOcean is pricier but available in more regions.
#
# API reference: https://docs.digitalocean.com/reference/api/

DO_API="${DO_API:-https://api.digitalocean.com/v2}"
DO_VOLUME_GB="${HOMESTEAD_DISK_GB:-2000}"
# Block storage is not priced by the API. $0.10/GiB/month per digitalocean.com/pricing/volumes
# (checked 2026-10). The script says so, rather than pretending to know.
DO_VOLUME_PER_GB="${DO_VOLUME_PER_GB:-0.10}"

dov() { api "$1" "$DO_API$2" "$DIGITALOCEAN_TOKEN" "${3:-}"; }

digitalocean_provision() {
  local region="${HOMESTEAD_LOCATION:-fra1}" forced="${HOMESTEAD_SERVER_TYPE:-}"
  explain "Get a token: cloud.digitalocean.com → API → Generate New Token (read + write)."
  DIGITALOCEAN_TOKEN="$(ask_secret DIGITALOCEAN_TOKEN "DigitalOcean API token (input hidden; not saved)")"

  step "Finding the cheapest droplet with ≥4 vCPU and ≥16 GB RAM in $region"
  local choice
  choice="$(dov GET "/sizes?per_page=200" | jq -c --arg r "$region" --arg forced "$forced" '
    [.sizes[] | select(.available and .vcpus >= 4 and .memory >= 16384 and (.regions | index($r)))
      | select($forced == "" or .slug == $forced)
      | {slug, vcpus, memory: (.memory / 1024), monthly: .price_monthly, hourly: .price_hourly, description}]
    | sort_by(.monthly) | first')"
  [[ "$choice" != "null" ]] || die "no droplet size with ≥4 vCPU / ≥16 GB in $region. Try HOMESTEAD_LOCATION=nyc3 (or sfo3, ams3, sgp1)."

  local slug monthly hourly volume_monthly total per_day
  slug="$(jq -r .slug <<<"$choice")"
  monthly="$(jq -r .monthly <<<"$choice")"
  hourly="$(jq -r .hourly <<<"$choice")"
  volume_monthly="$(awk -v g="$DO_VOLUME_GB" -v p="$DO_VOLUME_PER_GB" 'BEGIN { printf "%.2f", g * p }')"
  total="$(awk -v a="$monthly" -v b="$volume_monthly" 'BEGIN { printf "%.2f", a + b }')"
  per_day="$(awk -v a="$hourly" -v b="$volume_monthly" 'BEGIN { printf "%.2f", a * 24 + b / 30 }')"
  info "Droplet: $slug — $(jq -r '"\(.vcpus) vCPU, \(.memory) GB RAM"' <<<"$choice") — USD $monthly/month"
  info "Volume:  $DO_VOLUME_GB GB block storage — ≈ USD $volume_monthly/month (at \$$DO_VOLUME_PER_GB/GB; check current pricing)"
  info "Total:   ${BOLD}≈ USD $total/month${RESET}, billed by the hour (≈ USD $per_day per day)."
  confirm_word PROVISION "This creates billable resources in your DigitalOcean account."

  ensure_ssh_key
  local name
  name="homestead-$(date +%Y%m%d-%H%M)"

  step "Uploading this machine's Homestead SSH key"
  local key_id
  key_id="$(dov POST /account/keys "$(jq -nc --arg n "$name" --arg k "$(cat "$SSH_KEY.pub")" '{name: $n, public_key: $k}')" | jq -r '.ssh_key.id')"
  state_set PROVIDER digitalocean
  state_set DO_SSH_KEY_ID "$key_id"
  ok "ssh key $key_id"

  step "Creating a ${DO_VOLUME_GB} GB volume (formatted ext4)"
  local volume_id
  volume_id="$(dov POST /volumes "$(jq -nc --arg n "$name" --arg r "$region" --argjson s "$DO_VOLUME_GB" \
    '{name: $n, region: $r, size_gigabytes: $s, filesystem_type: "ext4", tags: ["homestead"]}')" | jq -r '.volume.id')"
  state_set DO_VOLUME_ID "$volume_id"
  state_set DATA_DEVICE "/dev/disk/by-id/scsi-0DO_Volume_$name"
  ok "volume $volume_id"

  step "Creating droplet $name ($slug, Ubuntu 24.04)"
  local droplet_id
  droplet_id="$(dov POST /droplets "$(jq -nc --arg n "$name" --arg r "$region" --arg s "$slug" --argjson k "$key_id" --arg v "$volume_id" \
    '{name: $n, region: $r, size: $s, image: "ubuntu-24-04-x64", ssh_keys: [$k], volumes: [$v], ipv6: true, tags: ["homestead"]}')" | jq -r '.droplet.id')"
  state_set DO_DROPLET_ID "$droplet_id"
  state_set SSH_USER root
  ok "droplet $droplet_id"

  step "Creating a cloud firewall"
  local inbound outbound firewall_id
  inbound="$(jq -nc '[["tcp","22"],["tcp","80"],["tcp","443"],["tcp","3381"],["udp","3382"],["tcp","3383"]]
    | map({protocol: .[0], ports: .[1], sources: {addresses: ["0.0.0.0/0", "::/0"]}})
    + [{protocol: "icmp", sources: {addresses: ["0.0.0.0/0", "::/0"]}}]')"
  outbound="$(jq -nc '["tcp","udp"] | map({protocol: ., ports: "all", destinations: {addresses: ["0.0.0.0/0", "::/0"]}})
    + [{protocol: "icmp", destinations: {addresses: ["0.0.0.0/0", "::/0"]}}]')"
  firewall_id="$(dov POST /firewalls "$(jq -nc --arg n "$name" --argjson i "$inbound" --argjson o "$outbound" --argjson d "$droplet_id" \
    '{name: $n, inbound_rules: $i, outbound_rules: $o, droplet_ids: [$d]}')" | jq -r '.firewall.id')"
  state_set DO_FIREWALL_ID "$firewall_id"
  ok "firewall $firewall_id: 22, 80, 443, 3381, 3382/udp, 3383"

  [[ -n "${HOMESTEAD_DRY_RUN:-}" ]] && return 0
  step "Waiting for the droplet to boot"
  local ip=""
  until [[ -n "$ip" ]]; do
    sleep 4
    ip="$(dov GET "/droplets/$droplet_id" | jq -r '.droplet | select(.status == "active") | .networks.v4[] | select(.type == "public") | .ip_address' | head -1)"
  done
  state_set HOST "$ip"
  wait_for_ssh
  ok "ssh root@$ip works"
}

digitalocean_destroy() {
  DIGITALOCEAN_TOKEN="$(ask_secret DIGITALOCEAN_TOKEN "DigitalOcean API token (input hidden; not saved)")"
  local droplet_id volume_id firewall_id key_id
  droplet_id="$(state_get DO_DROPLET_ID)"
  volume_id="$(state_get DO_VOLUME_ID)"
  firewall_id="$(state_get DO_FIREWALL_ID)"
  key_id="$(state_get DO_SSH_KEY_ID)"
  if [[ -n "$droplet_id" ]]; then
    step "Deleting droplet $droplet_id"
    dov DELETE "/droplets/$droplet_id" >/dev/null || true
    while [[ -n "$volume_id" && "$(dov GET "/volumes/$volume_id" | jq -r '.volume.droplet_ids | length')" != "0" ]]; do sleep 3; done
  fi
  [[ -n "$volume_id" ]] && { step "Deleting volume $volume_id (the Snapchain database)"; dov DELETE "/volumes/$volume_id" >/dev/null; }
  [[ -n "$firewall_id" ]] && { step "Deleting firewall $firewall_id"; dov DELETE "/firewalls/$firewall_id" >/dev/null || true; }
  [[ -n "$key_id" ]] && { step "Deleting ssh key $key_id"; dov DELETE "/account/keys/$key_id" >/dev/null || true; }
  ok "nothing left billing in DigitalOcean from this Homestead"
}
