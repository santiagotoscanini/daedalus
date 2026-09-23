# Mint the daedalus GitHub App's installation token and publish it where the
# daedalus container can read it.
#
# ── why the private key never enters the container ────────────────────────
#
# The App's private key IS the App: whoever holds it mints tokens for every
# repository on every installation, for as long as the key lives — it has no
# expiry, and the only revocation is generating a new one in GitHub's UI. The
# daedalus container is the wrong place for that. It runs a dev server with a
# public webhook path in front of it and a node_modules tree nobody audits,
# and container root is the operator's uid under rootless podman. So the key
# stays here: decrypted by sops-nix to a root-only 0400 file on tmpfs, read by
# this root oneshot, and nothing in the container's mount namespace can reach
# it. What crosses over is the most a compromised container could ever steal:
# one installation token, dead within the hour, narrowed below the App's own
# grant (no pull_requests:write), and revoked outright by uninstalling the App.
#
# ── what it does ──────────────────────────────────────────────────────────
#
# Sign a JWT with the key, find the installation on the box owner's account
# (by numeric id), mint a token narrowed to $PERMISSIONS, and publish
# installation.json into $OUT_DIR — root-owned and root-only-writable
# (tmpfiles), so write_json_atomic takes its root branch and nothing the
# container controls can be planted at the name. The file is 0400 and the
# operator's, which is what lets the rootless container read it through its
# read-only /github-token mount. The shape is app/src/host/github-token.ts's
# decoder in the engine: version, state ok|not-installed|error, reason,
# installationId, account, repositorySelection, token, expiresAt, mintedAt —
# plus `lastError: { at, reason }`, which the decoder does not know and drops
# (its `obj` keeps declared keys only), so the engine is unaffected by it.
# `mintedAt` is when the token in the file was minted; in a file without a
# token, when that state was published.
#
# Three triggers, one unit: a 30-minute timer (a token lives 60, so a reader
# always holds one with 25+ minutes left), a request from the app through the
# bridge ($APPLY_DIR/github-token-request.json), and sops-nix restarting the
# unit when the key rotates.
#
# ── failure policy ────────────────────────────────────────────────────────
#
#   GitHub down or refusing   While the last token still has more than
#                             $TOKEN_MIN_REMAINING seconds left (the engine's
#                             own usability floor, TOKEN_MIN_REMAINING_MS),
#                             it is KEPT with state: ok and the failure goes
#                             in `lastError` — a GitHub outage must not take
#                             away a working credential early, and the engine
#                             only uses a token whose state is ok. With no
#                             such token: state: error with the reason, no
#                             token. Exit 0 either way: the next tick retries,
#                             and an email per outage tick is noise. The next
#                             successful mint writes a fresh file, which
#                             clears `lastError`.
#   not installed / suspended state: not-installed, no token. A still-valid
#                             previous token is revoked first (best-effort).
#                             Not a failure to reach GitHub: the answer is
#                             that the token no longer has anything to open.
#   local malfunction         key missing or unable to sign: the same keep
#                             rule as above, then exit 1, so monitoredJobs
#                             mails it. A publish that fails: exit 1.
#   refused request           a symlinked or unreadable request file: the run
#                             still refreshes the token (throttle permitting)
#                             and exits 1.
#
# EVERY run tries GitHub at most once per $MIN_INTERVAL seconds, measured from
# the later of the published mintedAt and lastError.at — request, timer, key
# rotation or manual start alike. The trigger cannot be told apart safely:
# the container writes both the request file and the status file the replay
# guard reads, so any rule of the form "this run was not asked for" is one it
# can forge (an answered request rewritten in a loop once minted per write).
# The 30-minute timer never meets the limit. A key rotation that does keeps
# the still-valid token, and the next tick or request mints with the new key.

set -euo pipefail

OUT="$OUT_DIR/installation.json"
REQ="$APPLY_DIR/github-token-request.json"
STATUS="$APPLY_DIR/github-token-status.json"
# Narrowed on purpose: a token carries only what the box uses, so a
# permission granted at GitHub still does nothing until it is named here.
# `actions: read` is the Actions page reading runs, jobs and workflows;
# `pull_requests` is granted to the App but unused until previews, so it
# is deliberately absent.
PERMISSIONS='{"permissions":{"contents":"read","metadata":"read","checks":"write","deployments":"write","actions":"read"}}'
MIN_INTERVAL=60
# = TOKEN_MIN_REMAINING_MS in the engine's app/src/host/github-token.ts: a
# token with less left than this is one the engine will not use anyway.
TOKEN_MIN_REMAINING=300

STARTED_AT="$(date -Is)"
NOW="$(date +%s)"
# This run's timestamp, in the form every file field uses.
NOW_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

gh_init

# ── the request, if this run answers one ──────────────────────────────────
#
# REQ_ID    the unanswered request this run answers in $STATUS. Bookkeeping
#           only: whether this run mints never depends on it (see the
#           throttle below — the container controls both files involved).
# REFUSED   why the request file was not read; fails the unit at the end.
REQ_ID=""
REFUSED=""
if [ -L "$REQ" ]; then
  REFUSED="refusing $REQ: it is a symlink, and the bridge only accepts regular files"
elif [ -e "$REQ" ]; then
  # Read once, as the operator, never through a link (host/lib.sh).
  if REQ_JSON="$(read_request "$REQ")"; then
    req_id="$(jq -r '.id // ""' <<<"$REQ_JSON" 2>/dev/null || true)"
    if [[ "$req_id" =~ ^[0-9a-fA-F-]+$ ]] && [ "$(published_id "$STATUS")" != "$req_id" ]; then
      REQ_ID="$req_id"
    fi
  else
    REFUSED="could not read $REQ as $OPERATOR_USER"
  fi
fi
if [ -n "$REFUSED" ]; then
  echo "$REFUSED" >&2
fi

# ── helpers over the published file ───────────────────────────────────────
#
# $OUT is in a root-only directory, so root reads it by name directly — the
# rule in host/lib.sh is about directories somebody else can write.

have_prev() {
  [ -f "$OUT" ] && [ ! -L "$OUT" ] && jq -e 'type == "object"' "$OUT" >/dev/null 2>&1
}

# Epoch seconds of the timestamp at jq path $1 (a literal from this script,
# e.g. `.expiresAt`) in the published file; 0 when absent or unparseable.
prev_epoch() {
  local v
  v="$(jq -r "($1) // \"\" | strings" "$OUT" 2>/dev/null || true)"
  if [ -n "$v" ] && date -d "$v" +%s 2>/dev/null; then
    return 0
  fi
  echo 0
}

# When this minter last tried GitHub: the later of the token's mint and the
# last recorded failure.
prev_attempt_epoch() {
  local minted failed
  minted="$(prev_epoch .mintedAt)"
  failed="$(prev_epoch .lastError.at)"
  if [ "$failed" -gt "$minted" ]; then echo "$failed"; else echo "$minted"; fi
}

# Does the published file still carry a token the engine would use — more
# than $TOKEN_MIN_REMAINING seconds before it expires?
prev_token_valid() {
  have_prev || return 1
  jq -e '(.token | type) == "string" and .token != ""' "$OUT" >/dev/null 2>&1 || return 1
  [ "$(prev_epoch .expiresAt)" -gt "$((NOW + TOKEN_MIN_REMAINING))" ]
}

# The fresh token. Both inputs are FILES: the token never becomes an argument.
# A new object, so a `lastError` from an earlier failure does not survive it.
publish_ok() {
  jq -n --slurpfile inst "$GH_TMP/installation.json" --arg mintedAt "$NOW_ISO" '
    $inst[0] as $i | input as $t | {
      version: 1,
      state: "ok",
      reason: null,
      installationId: $i.id,
      account: { login: $i.account.login, id: $i.account.id },
      repositorySelection: $i.repository_selection,
      token: $t.token,
      expiresAt: $t.expires_at,
      mintedAt: $mintedAt
    }' "$GH_TMP/token.json" | write_json_atomic "$OUT" 0400
}

# A state without a token: $1 state, $2 reason.
publish_state() {
  jq -n --arg state "$1" --arg reason "$2" --arg mintedAt "$NOW_ISO" \
    '{version: 1, state: $state, reason: $reason, mintedAt: $mintedAt}' |
    write_json_atomic "$OUT" 0400
}

# The previous file, token and mintedAt untouched, still state: ok, with the
# failure ($1, already free of secrets) recorded as lastError. The token
# stays inside jq: it reads the file, never an argument. jq reads the whole
# file before write_json_atomic renames over it.
publish_kept() {
  jq --arg at "$NOW_ISO" --arg reason "$1" \
    '. + {state: "ok", reason: null, lastError: {at: $at, reason: $reason}}' "$OUT" |
    write_json_atomic "$OUT" 0400
}

# The failure rule shared by GitHub errors and local ones: keep a token the
# engine can still use, or publish the error without one.
publish_failure() {
  if prev_token_valid; then
    echo "keeping the last token (expires $(jq -r '.expiresAt' "$OUT")) and recording the failure as lastError" >&2
    publish_kept "$1"
  else
    publish_state error "$1"
  fi
}

# Answer the request, if there is one: $1 state (done|failed), $2 result
# (ok|not-installed|error|throttled), $3 error text (already redacted).
answer() {
  [ -n "$REQ_ID" ] || return 0
  write_json_atomic "$STATUS" <<EOF
{"id":"$REQ_ID","state":"$1","result":"$2","error":$(jq -Rn --arg e "$3" '$e'),"startedAt":"$STARTED_AT","finishedAt":"$(date -Is)"}
EOF
}

# Answer, then exit with $4 (default 0) — or 1 when a request was refused.
finish() {
  if ! answer "$1" "$2" "$3"; then
    echo "could not publish $STATUS" >&2
    exit 1
  fi
  if [ -n "$REFUSED" ]; then
    exit 1
  fi
  exit "${4:-0}"
}

github_error() {
  echo "GitHub: $1" >&2
  publish_failure "$1"
  finish failed error "$1" 0
}

local_failure() {
  echo "$1" >&2
  publish_failure "$1"
  finish failed error "$1" 1
}

# ── throttle ──────────────────────────────────────────────────────────────

# Whatever started this run (see the header). No published file — a fresh
# boot, a first install — means nothing to throttle against.
if have_prev; then
  if [ $((NOW - $(prev_attempt_epoch))) -lt "$MIN_INTERVAL" ]; then
    echo "GitHub was last tried less than ${MIN_INTERVAL}s ago; not trying again yet"
    finish "done" throttled ""
  fi
fi

# ── mint ──────────────────────────────────────────────────────────────────

if [ ! -r "$PEM" ]; then
  local_failure "the App's private key is not on the host ($PEM)"
fi
if ! gh_app_auth; then
  local_failure "could not sign a JWT with the App's private key ($PEM)"
fi

rc=0
gh_installation || rc=$?
case "$rc" in
0) ;;
2)
  if prev_token_valid; then
    gh_revoke "$OUT" || echo "could not revoke the previous token (${GH_ERROR:-HTTP $GH_STATUS}); it expires on its own" >&2
  fi
  echo "$GH_REASON"
  publish_state not-installed "$GH_REASON"
  finish "done" not-installed ""
  ;;
*)
  github_error "$GH_ERROR"
  ;;
esac

printf '%s' "$PERMISSIONS" >"$GH_TMP/permissions.json"
if ! gh_mint "$GH_TMP/permissions.json"; then
  github_error "$GH_ERROR"
fi

publish_ok
echo "minted a token for installation $(jq -r '.id' "$GH_TMP/installation.json") on $(jq -r '.account.login' "$GH_TMP/installation.json"), expiring $(jq -r '.expires_at' "$GH_TMP/token.json")"

# finish()'s steps written out rather than called: when a script's LAST
# command always exits, ShellCheck 0.11 reports every function it cannot see
# being called (lib.sh's op_* run through as_operator_fn, gh_cleanup through
# the trap) as SC2329, and writeShellApplication fails the build on it.
if ! answer "done" ok ""; then
  echo "could not publish $STATUS" >&2
  exit 1
fi
if [ -n "$REFUSED" ]; then
  exit 1
fi
