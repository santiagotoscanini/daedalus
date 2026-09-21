# GitHub App helpers for the host's token minter (host/github-token.sh).
# Inlined by its writeShellApplication wrapper after host/lib.sh; expects PEM
# (the App's private key file), CLIENT_ID, OWNER and OWNER_ID.
#
# ── the one rule these helpers exist for ──────────────────────────────────
#
# Two secrets pass through here: the App's JWT (ten minutes of "act as the
# App", signed with a key that never leaves this host) and the installation
# token it buys (an hour of repository access). Neither may reach:
#
#   argv      /proc/<pid>/cmdline is readable by every process on the box, so
#             a `curl -H "Authorization: …"` or a `jq --arg token …` publishes
#             the value for the life of the call. Credentials go into a curl
#             --config file; jq reads them from files or stdin; shell builtins
#             (printf, read) carry them between the two, and a builtin is no
#             process.
#   the log   every function that touches one starts with `set +x`, and text
#             from GitHub or curl passes gh_redact before it is kept anywhere.
#   the disk  every temp lives in one `mktemp -d` directory (0700, inside the
#             unit's PrivateTmp), removed by the EXIT trap gh_init installs.
#             The caller must not install an EXIT trap of its own.

GH_API="https://api.github.com"
GH_TMP=""
# Set by the functions below for the caller: the HTTP status of the last call,
# why GitHub could not be asked (curl's message or GitHub's), and why the App
# has no usable installation. Never carries a secret.
GH_STATUS=""
GH_ERROR=""
GH_REASON=""

gh_init() {
  set +x
  umask 077
  GH_TMP="$(mktemp -d)"
  chmod 0700 "$GH_TMP"
  trap gh_cleanup EXIT
}

gh_cleanup() {
  if [ -n "$GH_TMP" ]; then
    rm -rf -- "$GH_TMP"
  fi
}

# stdin → base64url without padding (RFC 7515 §2).
gh_b64url() {
  openssl base64 -A | tr '+/' '-_' | tr -d '='
}

# stdin → one line, anything shaped like a GitHub token or a JWT cut out,
# capped at 300 characters. For error text on its way into a published file:
# GitHub does not echo credentials back, and this makes sure of it.
gh_redact() {
  local s
  s="$(tr '\r\n' '  ' | sed -E 's/(gh[opusr]_|github_pat_)[A-Za-z0-9_]+/[redacted]/g; s/eyJ[A-Za-z0-9._-]+/[redacted]/g')"
  printf '%s' "${s:0:300}"
}

# An RS256 JWT for the App, on stdout — capture it, never pass it on.
#
# `iss` is the client ID, which GitHub accepts in place of the numeric App
# id. `iat` is back-dated 60 s so a host clock slightly ahead of GitHub's is
# not "issued in the future"; `exp` is 9 minutes out, inside GitHub's
# 10-minute ceiling by the same margin.
gh_jwt() {
  set +x
  local now header payload sig
  now="$(date +%s)"
  header="$(printf '%s' '{"alg":"RS256","typ":"JWT"}' | gh_b64url)" || return 1
  payload="$(
    jq -cjn --argjson iat "$((now - 60))" --argjson exp "$((now + 540))" --arg iss "$CLIENT_ID" \
      '{iat: $iat, exp: $exp, iss: $iss}' | gh_b64url
  )" || return 1
  sig="$(printf '%s.%s' "$header" "$payload" | openssl dgst -sha256 -sign "$PEM" -binary | gh_b64url)" || return 1
  [ -n "$sig" ] || return 1
  printf '%s.%s.%s' "$header" "$payload" "$sig"
}

# Write curl config $1: GitHub's fixed headers plus a bearer credential read
# from STDIN, so the credential is never an argument. A credential with a
# character outside the JWT/token alphabet is refused rather than written: it
# would otherwise be able to close the quoted header and add curl options.
gh_write_config() {
  set +x
  local out="$1" cred=""
  IFS= read -r cred || [ -n "$cred" ] || return 1
  [ -n "$cred" ] || return 1
  case "$cred" in
  *[!A-Za-z0-9._-]*) return 1 ;;
  esac
  {
    printf 'header = "Authorization: Bearer %s"\n' "$cred"
    printf 'header = "Accept: application/vnd.github+json"\n'
    printf 'header = "X-GitHub-Api-Version: 2022-11-28"\n'
  } >"$out"
}

# Sign a fresh JWT into $GH_TMP/app.curlrc, the config every App-level call
# below uses. Non-zero means the key could not sign — a local fault.
gh_app_auth() {
  set +x
  local jwt
  jwt="$(gh_jwt)" || return 1
  printf '%s' "$jwt" | gh_write_config "$GH_TMP/app.curlrc"
}

# One API call: $1 method, $2 path from the root (`/app/installations`), $3 a
# curl config from gh_write_config, $4 an optional JSON request body FILE.
# The response body lands in $GH_TMP/body and its status in GH_STATUS; a
# non-zero return means GitHub never answered (GH_STATUS=000, curl's own
# message in GH_ERROR). Not for use in $(…): the globals would stay in the
# subshell.
gh_api() {
  set +x
  local method="$1" path="$2" cfg="$3" body="${4-}" code
  local args=(
    --config "$cfg"
    --silent --show-error
    --proto '=https'
    --max-time 15
    --request "$method"
    --output "$GH_TMP/body"
    --write-out '%{http_code}'
  )
  if [ -n "$body" ]; then
    args+=(--header 'Content-Type: application/json' --data-binary "@$body")
  fi
  GH_STATUS="000"
  GH_ERROR=""
  : >"$GH_TMP/body"
  if ! code="$(curl "${args[@]}" "$GH_API$path" 2>"$GH_TMP/curl.err")"; then
    GH_ERROR="$(gh_redact <"$GH_TMP/curl.err")"
    GH_ERROR="${GH_ERROR:-curl failed without a message}"
    return 1
  fi
  GH_STATUS="$code"
}

# GitHub's explanation of the last non-2xx answer, redacted: `HTTP 401: …`.
gh_message() {
  local m
  m="$(jq -r '.message // empty' "$GH_TMP/body" 2>/dev/null || true)"
  printf 'HTTP %s%s' "$GH_STATUS" "${m:+: $m}" | gh_redact
}

# Find the App's installation on the account OWNER_ID names — by id, because
# a login can be renamed and a new account can take the old name.
#
#   0  found; the installation object is in $GH_TMP/installation.json
#   2  not installed there, or suspended; GH_REASON says which, naming the
#      accounts the App IS installed on so a wrong-account install reads as
#      one
#   1  GitHub could not be asked; GH_ERROR says why
#
# One page of 100: an App made for one box is installed on a handful of
# accounts at most.
gh_installation() {
  set +x
  local others
  GH_REASON=""
  gh_api GET "/app/installations?per_page=100" "$GH_TMP/app.curlrc" || return 1
  if [ "$GH_STATUS" != 200 ]; then
    GH_ERROR="listing the App's installations: $(gh_message)"
    return 1
  fi
  if ! jq -e 'type == "array"' "$GH_TMP/body" >/dev/null 2>&1; then
    GH_ERROR="listing the App's installations: GitHub answered 200 with something that is not a list"
    return 1
  fi
  if ! jq -e --argjson owner "$OWNER_ID" 'first(.[] | select(.account.id == $owner))' \
    "$GH_TMP/body" >"$GH_TMP/installation.json" 2>/dev/null; then
    others="$(jq -r '[.[].account.login] | join(", ")' "$GH_TMP/body" 2>/dev/null || true)"
    GH_REASON="the App is not installed on $OWNER${others:+ (it is installed on: $others)}"
    return 2
  fi
  if jq -e '.suspended_at != null' "$GH_TMP/installation.json" >/dev/null 2>&1; then
    GH_REASON="the App's installation on $OWNER is suspended"
    return 2
  fi
}

# Mint an installation token for the installation gh_installation found.
# $1 = the request body file (the permissions to narrow the token to). On
# success the token answer (token, expires_at, …) is in $GH_TMP/token.json.
gh_mint() {
  set +x
  local body="$1" id
  GH_ERROR=""
  id="$(jq -r '.id // ""' "$GH_TMP/installation.json" 2>/dev/null || true)"
  if ! [[ "$id" =~ ^[0-9]+$ ]]; then
    GH_ERROR="the installation GitHub listed has no numeric id"
    return 1
  fi
  gh_api POST "/app/installations/$id/access_tokens" "$GH_TMP/app.curlrc" "$body" || return 1
  if [ "$GH_STATUS" != 201 ]; then
    GH_ERROR="minting an installation token: $(gh_message)"
    return 1
  fi
  if ! jq -e '(.token | type) == "string" and .token != "" and (.expires_at | type) == "string"' \
    "$GH_TMP/body" >/dev/null 2>&1; then
    GH_ERROR="minting an installation token: GitHub's answer carried no token"
    return 1
  fi
  mv -f -- "$GH_TMP/body" "$GH_TMP/token.json"
}

# Revoke the installation token in JSON file $1 (its `.token`). Authenticated
# by that token itself, so it needs no key. 0 only on GitHub's 204.
gh_revoke() {
  set +x
  local file="$1"
  jq -j '.token // ""' "$file" | gh_write_config "$GH_TMP/revoke.curlrc" || return 1
  gh_api DELETE /installation/token "$GH_TMP/revoke.curlrc" || return 1
  [ "$GH_STATUS" = 204 ]
}
