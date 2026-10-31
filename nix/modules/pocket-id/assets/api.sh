# shellcheck shell=bash
# The Pocket ID admin API from the host, shared by sync-clients.sh and
# harden-metadata-clients.sh (both wrappers in ../clients.nix prepend it).
# Needs IDP_ENV and CURL_BIN; why the requests run inside the container with
# a static curl is the header of sync-clients.sh.

set -euo pipefail

PID_API_KEY=$(grep '^STATIC_API_KEY=' "$IDP_ENV" | head -1 | cut -d= -f2-)
[ -n "$PID_API_KEY" ] || { echo "STATIC_API_KEY missing from $IDP_ENV" >&2; exit 1; }
export PID_API_KEY

RESP=$(mktemp)
trap 'rm -f "$RESP"' EXIT

# Ship curl into the container (see the header). Idempotent: a restart
# wipes /tmp, so this re-lands it on every run rather than assuming.
CURL_IN=/tmp/.pid-sync-curl
podman cp "$CURL_BIN" "pocket-id:$CURL_IN" \
  || { echo "could not stage curl into the pocket-id container" >&2; exit 1; }

# api <METHOD> <PATH> [<JSON body>]
#   -> response body in $RESP, status in $API_CODE.
# Deliberately NOT `body=$(api ...)`: a command substitution runs in a
# subshell, so the status assignment would be discarded and every call
# would read as HTTP "". curl's stdout carries both halves (body, then a
# final line with the code) because one podman exec is one round trip.
API_CODE=""
api() {
  local method=$1 path=$2 body=${3-} out
  if [ -n "$body" ]; then
    out=$(printf '%s' "$body" | podman exec -i -e PID_API_KEY pocket-id \
      "$CURL_IN" -sS --max-time 10 -w '\n%{http_code}' -X "$method" \
      -H "X-API-KEY: $PID_API_KEY" -H 'Content-Type: application/json' \
      --data-binary @- "http://localhost:1411$path")
  else
    out=$(podman exec -e PID_API_KEY pocket-id \
      "$CURL_IN" -sS --max-time 10 -w '\n%{http_code}' -X "$method" \
      -H "X-API-KEY: $PID_API_KEY" \
      "http://localhost:1411$path")
  fi
  API_CODE=${out##*$'\n'}
  printf '%s' "${out%$'\n'*}" > "$RESP"
}
