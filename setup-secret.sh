#!/usr/bin/env bash
# setup-secret.sh — interactively store pi-gondolin secrets in macOS Keychain.
# Reads available secrets from config.json (same directory as this script).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="$SCRIPT_DIR/config.json"

# ---------------------------------------------------------------------------
# Sanity checks
# ---------------------------------------------------------------------------
if [[ ! -f "$CONFIG" ]]; then
  echo "Error: config.json not found at $CONFIG" >&2
  exit 1
fi

# Detect JSON parser — prefer jq, fall back to python3
if command -v jq &>/dev/null; then
  PARSER=jq
elif command -v python3 &>/dev/null; then
  PARSER=python3
else
  echo "Error: neither jq nor python3 is available — install one and retry." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Config helpers
# ---------------------------------------------------------------------------
get_secret_names() {
  if [[ "$PARSER" == jq ]]; then
    jq -r '.secrets | keys[]' "$CONFIG"
  else
    python3 - <<PYEOF
import json
with open("$CONFIG") as f:
    d = json.load(f)
for k in d["secrets"]:
    print(k)
PYEOF
  fi
}

get_keychain_account() {
  local name="$1"
  if [[ "$PARSER" == jq ]]; then
    jq -r --arg k "$name" '.secrets[$k].keychain' "$CONFIG"
  else
    python3 - <<PYEOF
import json
with open("$CONFIG") as f:
    d = json.load(f)
print(d["secrets"]["$name"]["keychain"])
PYEOF
  fi
}

get_hosts() {
  local name="$1"
  if [[ "$PARSER" == jq ]]; then
    jq -r --arg k "$name" '.secrets[$k].hosts[]' "$CONFIG"
  else
    python3 - <<PYEOF
import json
with open("$CONFIG") as f:
    d = json.load(f)
for h in d["secrets"]["$name"]["hosts"]:
    print(h)
PYEOF
  fi
}

# ---------------------------------------------------------------------------
# Determine which secret to configure
# ---------------------------------------------------------------------------
if [[ $# -ge 1 ]]; then
  SECRET_NAME="$1"
  if ! get_secret_names | grep -qx "$SECRET_NAME"; then
    echo "Error: '$SECRET_NAME' is not defined in config.json" >&2
    echo "Available secrets:" >&2
    get_secret_names | sed 's/^/  /' >&2
    exit 1
  fi
else
  echo "Available secrets:"
  declare -a SECRET_NAMES=()
  i=1
  while IFS= read -r name; do
    echo "  $i) $name"
    SECRET_NAMES+=("$name")
    i=$((i + 1))
  done < <(get_secret_names)
  echo
  printf "Pick a secret (number or name): "
  read -r SELECTION

  if [[ "$SELECTION" =~ ^[0-9]+$ ]]; then
    idx=$((SELECTION - 1))
    if [[ $idx -lt 0 || $idx -ge ${#SECRET_NAMES[@]} ]]; then
      echo "Error: invalid selection '$SELECTION'" >&2
      exit 1
    fi
    SECRET_NAME="${SECRET_NAMES[$idx]}"
  else
    SECRET_NAME="$SELECTION"
    found=0
    for n in "${SECRET_NAMES[@]}"; do
      [[ "$n" == "$SECRET_NAME" ]] && found=1 && break
    done
    if [[ $found -eq 0 ]]; then
      echo "Error: '$SECRET_NAME' is not defined in config.json" >&2
      exit 1
    fi
  fi
fi

KEYCHAIN_ACCOUNT="$(get_keychain_account "$SECRET_NAME")"

echo
echo "Configuring: $SECRET_NAME"
echo "  Keychain account : $KEYCHAIN_ACCOUNT"
echo "  Hosts that will use this secret:"
get_hosts "$SECRET_NAME" | sed 's/^/    /'
echo

# ---------------------------------------------------------------------------
# Token type
# ---------------------------------------------------------------------------
printf "Token type — (t)oken or (c)redentials (user:pass, base64-encoded)? [t/c]: "
read -r TOKEN_TYPE
echo

SECRET_VALUE=""

case "$TOKEN_TYPE" in
  t|T)
    printf "Enter token: "
    read -rs SECRET_VALUE
    echo
    ;;
  c|C)
    printf "Enter username: "
    read -r USERNAME
    echo
    printf "Enter password: "
    read -rs PASSWORD
    echo
    SECRET_VALUE="$(printf '%s:%s' "$USERNAME" "$PASSWORD" | base64 | tr -d '\n')"
    unset USERNAME PASSWORD
    ;;
  *)
    echo "Error: expected 't' or 'c', got '$TOKEN_TYPE'" >&2
    exit 1
    ;;
esac

# ---------------------------------------------------------------------------
# Store in Keychain
# ---------------------------------------------------------------------------
echo "Storing in Keychain (service=pi-gondolin, account=$KEYCHAIN_ACCOUNT)..."
security add-generic-password \
  -s "pi-gondolin" \
  -a "$KEYCHAIN_ACCOUNT" \
  -w "$SECRET_VALUE" \
  -U

unset SECRET_VALUE

echo
echo "✓ Secret stored."
echo "  Service : pi-gondolin"
echo "  Account : $KEYCHAIN_ACCOUNT"
printf "  Hosts   : "
get_hosts "$SECRET_NAME" | tr '\n' ' '
echo
