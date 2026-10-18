# shellcheck shell=bash
# Shared helpers for ./homestead. Sourced, not executed.

set -euo pipefail

HOMESTEAD_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="${HOMESTEAD_STATE_DIR:-$HOMESTEAD_ROOT/.homestead}"
STATE_FILE="$STATE_DIR/state"
SSH_KEY="$STATE_DIR/ssh/id_ed25519"

# --- output ------------------------------------------------------------------------------

if [[ -t 1 ]]; then
  BOLD=$'\e[1m'; DIM=$'\e[2m'; GREEN=$'\e[32m'; YELLOW=$'\e[33m'; RED=$'\e[31m'; RESET=$'\e[0m'
else
  BOLD=""; DIM=""; GREEN=""; YELLOW=""; RED=""; RESET=""
fi

step()  { printf '\n%s==> %s%s\n' "$BOLD" "$*" "$RESET"; }
info()  { printf '    %s\n' "$*"; }
ok()    { printf '    %s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
warn()  { printf '    %s!%s %s\n' "$YELLOW" "$RESET" "$*" >&2; }
die()   { printf '\n%serror:%s %s\n' "$RED" "$RESET" "$*" >&2; exit 1; }
explain() { printf '%s    %s%s\n' "$DIM" "$*" "$RESET"; }

# Ask for a typed confirmation word. Spending money or deleting things needs more than "y".
confirm_word() {
  local word="$1" prompt="$2" answer
  [[ "${HOMESTEAD_YES:-}" == "$word" ]] && return 0
  printf '\n%s\n    Type %s%s%s to continue (anything else cancels): ' "$prompt" "$BOLD" "$word" "$RESET"
  read -r answer </dev/tty || true
  [[ "$answer" == "$word" ]] || die "cancelled"
}

need() {
  local missing=()
  for cmd in "$@"; do command -v "$cmd" >/dev/null 2>&1 || missing+=("$cmd"); done
  if ((${#missing[@]})); then
    die "missing: ${missing[*]}. On macOS: brew install ${missing[*]}. On Debian/Ubuntu: sudo apt-get install -y ${missing[*]}"
  fi
}

# --- state -------------------------------------------------------------------------------
# A tiny key=value file in .homestead/state remembers what command 0 created, so commands
# 1 and 2 (and destroy) know where to go. It holds no secrets: API tokens are never saved.

state_get() {
  [[ -f "$STATE_FILE" ]] || return 0
  grep -E "^$1=" "$STATE_FILE" | tail -1 | cut -d= -f2- || true
}

state_set() {
  mkdir -p "$STATE_DIR"
  touch "$STATE_FILE"
  local tmp="$STATE_FILE.tmp"
  grep -vE "^$1=" "$STATE_FILE" >"$tmp" || true
  printf '%s=%s\n' "$1" "$2" >>"$tmp"
  mv "$tmp" "$STATE_FILE"
}

require_server() {
  [[ -n "$(state_get HOST)" ]] || die "no server yet. Run ./homestead provision first (command 0)."
}

# --- ssh ---------------------------------------------------------------------------------
# Homestead uses its own SSH key (.homestead/ssh/id_ed25519) so it never touches ~/.ssh.

ensure_ssh_key() {
  if [[ ! -f "$SSH_KEY" ]]; then
    mkdir -p "$(dirname "$SSH_KEY")"
    chmod 700 "$(dirname "$SSH_KEY")"
    ssh-keygen -q -t ed25519 -N "" -C "homestead@$(hostname -s 2>/dev/null || echo laptop)" -f "$SSH_KEY"
    ok "created an SSH key for this server: $SSH_KEY"
  fi
}

# Sets the SSH_OPTS array. (No mapfile: macOS still ships bash 3.2.)
load_ssh_opts() {
  SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=30 -o StrictHostKeyChecking=accept-new
    -o "UserKnownHostsFile=$STATE_DIR/known_hosts")
  local identity
  identity="$(state_get SSH_IDENTITY)"
  if [[ -n "$identity" ]]; then
    SSH_OPTS+=(-i "$identity")
  elif [[ -f "$SSH_KEY" ]]; then
    SSH_OPTS+=(-i "$SSH_KEY")
  fi
}

target() { printf '%s@%s' "$(state_get SSH_USER)" "$(state_get HOST)"; }

is_local() { [[ "$(state_get HOST)" == "local" ]]; }

# Run a command on the server (or locally for `provision byo local`).
remote() {
  if is_local; then bash -c "$*"; return; fi
  load_ssh_opts
  ssh "${SSH_OPTS[@]}" "$(target)" "$@"
}

# Same, with a TTY, for interactive or long-running output.
remote_tty() {
  if is_local; then bash -c "$*"; return; fi
  load_ssh_opts
  ssh -t "${SSH_OPTS[@]}" "$(target)" "$@"
}

# Run a local script on the server as root, passing NAME=value arguments as its environment.
remote_script() {
  local script="$1"; shift
  local sudo=""
  [[ "$(state_get SSH_USER)" != "root" ]] && sudo="sudo"
  if is_local; then
    $sudo env "$@" bash -s <"$script"
    return
  fi
  load_ssh_opts
  local quoted="" arg
  for arg in "$@"; do quoted+=" $(printf '%q' "$arg")"; done
  # shellcheck disable=SC2029  # expanded locally on purpose; values are %q-quoted
  ssh "${SSH_OPTS[@]}" "$(target)" "$sudo env$quoted bash -s" <"$script"
}

# Copy a local directory to the server (tar over ssh: no rsync needed on either end).
push_dir() {
  local src="$1" dest="$2" sudo=""
  [[ "$(state_get SSH_USER)" != "root" ]] && sudo="sudo"
  if is_local; then
    $sudo mkdir -p "$dest" && tar -C "$src" --exclude node_modules --exclude dist --exclude data --exclude 'data-*' -cf - . | $sudo tar -C "$dest" -xf -
    return
  fi
  load_ssh_opts
  COPYFILE_DISABLE=1 tar -C "$src" --exclude node_modules --exclude dist --exclude data --exclude 'data-*' -cf - . |
    ssh "${SSH_OPTS[@]}" "$(target)" "$sudo mkdir -p '$dest' && $sudo tar -C '$dest' -xf - --no-same-owner 2>/dev/null"
}

wait_for_ssh() {
  [[ -n "${HOMESTEAD_TEST_NO_SSH:-}" ]] && return 0 # used by scripts/test/provision.sh only
  local tries=0
  until remote true 2>/dev/null; do
    tries=$((tries + 1))
    ((tries > 60)) && die "server did not accept SSH after 5 minutes"
    sleep 5
  done
}

# --- http --------------------------------------------------------------------------------

# api METHOD URL TOKEN [JSON_BODY] — prints the response body, fails loudly on HTTP errors.
api() {
  local method="$1" url="$2" token="$3" body="${4:-}" response status
  if [[ -n "${HOMESTEAD_DRY_RUN:-}" && "$method" != "GET" ]]; then
    printf '%s[dry run] %s %s %s%s\n' "$DIM" "$method" "$url" "$body" "$RESET" >&2
    echo '{}'
    return
  fi
  response=$(curl -sS -X "$method" "$url" -H "Authorization: Bearer $token" -H "Content-Type: application/json" \
    ${body:+--data "$body"} -w $'\n%{http_code}') || die "could not reach $url"
  status="${response##*$'\n'}"
  response="${response%$'\n'*}"
  if [[ "$status" -ge 400 ]]; then
    die "$method $url failed ($status): $(jq -r '.error.message // .message // .' <<<"$response" 2>/dev/null || echo "$response")"
  fi
  printf '%s' "$response"
}

ask_secret() {
  local name="$1" prompt="$2" value="${!1:-}"
  if [[ -z "$value" ]]; then
    printf '    %s: ' "$prompt" >&2
    read -rs value </dev/tty || true
    printf '\n' >&2
  fi
  [[ -n "$value" ]] || die "$name is required"
  printf '%s' "$value"
}

random_passphrase() {
  # 4 groups of 5 from an unambiguous alphabet: ~95 bits, easy to type on a phone.
  LC_ALL=C tr -dc 'abcdefghjkmnpqrstuvwxyz23456789' </dev/urandom | head -c 20 | sed -E 's/(.{5})/\1-/g; s/-$//'
}
