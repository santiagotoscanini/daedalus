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
# installationId, account, repositorySelection, token, expiresAt,
# missingPermissions (what $PERMISSIONS names that the installation was not
# granted, so the token was minted without it), mintedAt —
# plus `lastError: { at, reason }`, which the decoder does not know and drops
# (its `obj` keeps declared keys only), so the engine is unaffected by it.
# `mintedAt` is when the token in the file was minted; in a file without a
# token, when that state was published.
#
# Three triggers, one unit: a 30-minute timer (a token lives 60, so a reader
# always holds one with 25+ minutes left), the app asking through the root
# helper (its `github-token` verb, daedalus-github.nix), and sops-nix
# restarting the unit when the key rotates. The helper reads its outcome
# entry (host/lib.sh `outcome`): `refused` when no token was minted and the
# unit still exits 0 (throttled, GitHub down, not installed), `done` a mint.
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
#
# EVERY run tries GitHub at most once per $MIN_INTERVAL seconds, measured from
# the later of the published mintedAt and lastError.at — the app's ask, the
# timer, a key rotation or a manual start alike: the app can ask as often as
# it likes, and GitHub hears from this box once a minute at most. The
# 30-minute timer never meets the limit. A key rotation that does keeps the
# still-valid token, and the next tick or ask mints with the new key.

set -euo pipefail

OUT="$OUT_DIR/installation.json"
# Every OTHER installation of the App (another account or org the operator
# installed it on) — read-only tokens for discovery, never for building.
OTHERS_OUT="$OUT_DIR/installations.json"
# Narrowed on purpose: a token carries only what the box uses, so a
# permission granted at GitHub still does nothing until it is named here.
# `actions: read` is the Actions page reading runs, jobs and workflows;
# `pages: read` is the off-box list reading each Pages site; `pull_requests`
# is granted to the App but unused until previews, so it is deliberately
# absent. Each is asked for only where it is granted (gh_narrow), and what
# is not lands in `missingPermissions`.
PERMISSIONS='{"permissions":{"contents":"read","metadata":"read","checks":"write","deployments":"write","actions":"read","pages":"read"}}'
# The other installations: read what is there, write nothing. `deployments`
# is how a workflow-built Pages site records each publish.
OTHER_PERMISSIONS='{"permissions":{"contents":"read","metadata":"read","actions":"read","pages":"read","deployments":"read"}}'
MIN_INTERVAL=60
# = TOKEN_MIN_REMAINING_MS in the engine's app/src/host/github-token.ts: a
# token with less left than this is one the engine will not use anyway.
TOKEN_MIN_REMAINING=300

NOW="$(date +%s)"
# This run's timestamp, in the form every file field uses.
NOW_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

gh_init

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
  jq -n --slurpfile inst "$GH_TMP/installation.json" --slurpfile missing "$GH_TMP/missing.json" \
    --arg mintedAt "$NOW_ISO" '
    $inst[0] as $i | input as $t | {
      version: 1,
      state: "ok",
      reason: null,
      installationId: $i.id,
      account: { login: $i.account.login, id: $i.account.id },
      repositorySelection: $i.repository_selection,
      token: $t.token,
      expiresAt: $t.expires_at,
      missingPermissions: $missing[0],
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

github_error() {
  echo "GitHub: $1" >&2
  publish_failure "$1"
  refuse "GitHub did not mint a token: $1"
}

local_failure() {
  echo "$1" >&2
  publish_failure "$1"
  exit 1
}

# ── the other installations ───────────────────────────────────────────────
#
# Every account or org the App is installed on besides the owner's, and
# that the operator TRUSTS ($TRUSTED_ACCOUNT_IDS, from site.json's
# github.trustedAccounts), gets a READ-ONLY token ($OTHER_PERMISSIONS,
# narrowed to its grant). A public App can be installed by anyone: any other
# installation is listed as state: untrusted, with no token, so the page can
# offer to trust it — and a token it held while it was trusted is revoked.
# All in $OTHERS_OUT: { version: 1, installations: [ { installationId, account,
# repositorySelection, state ok|error|untrusted, reason, token, expiresAt,
# missingPermissions, mintedAt, lastError? } ] }. The engine discovers what
# those accounts host (their Pages sites) with it; nothing builds from them,
# so nothing there needs more. Same failure rule per entry as the primary:
# a still-usable previous token is kept with `lastError`, else state: error.
# An installation that is gone simply drops out — its last token dies
# within the hour. Never fails the run: the owner's token is the one that
# matters, and it is already published.

# Whether account id $1 is one the operator trusts.
trusted_account() {
  local t
  for t in "${TRUSTED_ACCOUNT_IDS[@]}"; do
    [ "$t" = "$1" ] && return 0
  done
  return 1
}

# Revoke the token the previous file held for installation id $1, if any:
# its account is no longer trusted. Best-effort — it expires within the hour.
revoke_other() {
  [ -f "$OTHERS_OUT" ] && [ ! -L "$OTHERS_OUT" ] || return 0
  jq -c --argjson id "$1" 'first((.installations // [])[] | select(.installationId == $id and (.token | type) == "string" and .token != ""))' \
    "$OTHERS_OUT" >"$GH_TMP/revoke.json" 2>/dev/null || return 0
  [ -s "$GH_TMP/revoke.json" ] || return 0
  gh_revoke "$GH_TMP/revoke.json" || echo "could not revoke the token of untrusted installation $1; it expires on its own" >&2
}

# The previous entry for installation id $1, still usable, with lastError
# ($2) recorded, on stdout as one line; nothing when there is none.
kept_other() {
  [ -f "$OTHERS_OUT" ] && [ ! -L "$OTHERS_OUT" ] || return 0
  jq -c --argjson id "$1" --arg at "$NOW_ISO" --arg reason "$2" \
    --argjson floor "$((NOW + TOKEN_MIN_REMAINING))" '
    first((.installations // [])[]
      | select(.installationId == $id and (.token | type) == "string" and .token != ""
          and ((.expiresAt // "" | try fromdateiso8601 catch 0) > $floor)))
    | . + {state: "ok", reason: null, lastError: {at: $at, reason: $reason}}
  ' "$OTHERS_OUT" 2>/dev/null || true
}

mint_others() {
  local n i id login kept reason
  printf '%s' "$OTHER_PERMISSIONS" >"$GH_TMP/other-wanted.json"
  : >"$GH_TMP/others.jsonl"
  n="$(jq 'length' "$GH_TMP/others.json")"
  for ((i = 0; i < n; i++)); do
    jq ".[$i]" "$GH_TMP/others.json" >"$GH_TMP/other.json"
    id="$(jq -r '.id' "$GH_TMP/other.json")"
    login="$(jq -r '.account.login' "$GH_TMP/other.json")"
    if ! trusted_account "$(jq -r '.account.id' "$GH_TMP/other.json")"; then
      revoke_other "$id"
      jq -nc --slurpfile inst "$GH_TMP/other.json" --arg mintedAt "$NOW_ISO" '
        $inst[0] as $i | {
          installationId: $i.id,
          account: { login: $i.account.login, id: $i.account.id },
          repositorySelection: $i.repository_selection,
          state: "untrusted",
          reason: "not trusted on this box",
          token: null,
          expiresAt: null,
          missingPermissions: [],
          mintedAt: $mintedAt
        }' >>"$GH_TMP/others.jsonl"
      echo "installation $id on $login is not trusted; no token" >&2
      continue
    fi
    if gh_narrow "$GH_TMP/other-wanted.json" "$GH_TMP/other.json" \
      "$GH_TMP/other-request.json" "$GH_TMP/other-missing.json" &&
      gh_mint "$GH_TMP/other-request.json" "$GH_TMP/other.json"; then
      jq -c --slurpfile inst "$GH_TMP/other.json" --slurpfile missing "$GH_TMP/other-missing.json" \
        --arg mintedAt "$NOW_ISO" '
        $inst[0] as $i | {
          installationId: $i.id,
          account: { login: $i.account.login, id: $i.account.id },
          repositorySelection: $i.repository_selection,
          state: "ok",
          reason: null,
          token: .token,
          expiresAt: .expires_at,
          missingPermissions: $missing[0],
          mintedAt: $mintedAt
        }' "$GH_TMP/token.json" >>"$GH_TMP/others.jsonl"
      echo "minted a read-only token for installation $id on $login" >&2
      continue
    fi
    reason="${GH_ERROR:-could not narrow the permissions to what the installation was granted}"
    echo "GitHub: installation $id on $login: $reason" >&2
    kept="$(kept_other "$id" "$reason")"
    if [ -n "$kept" ]; then
      printf '%s\n' "$kept" >>"$GH_TMP/others.jsonl"
    else
      jq -nc --slurpfile inst "$GH_TMP/other.json" --arg reason "$reason" --arg mintedAt "$NOW_ISO" '
        $inst[0] as $i | {
          installationId: $i.id,
          account: { login: $i.account.login, id: $i.account.id },
          repositorySelection: $i.repository_selection,
          state: "error",
          reason: $reason,
          token: null,
          expiresAt: null,
          missingPermissions: [],
          mintedAt: $mintedAt
        }' >>"$GH_TMP/others.jsonl"
    fi
  done
  jq -s '{version: 1, installations: .}' "$GH_TMP/others.jsonl" |
    write_json_atomic "$OTHERS_OUT" 0400 ||
    echo "could not publish $OTHERS_OUT" >&2
}

# ── throttle ──────────────────────────────────────────────────────────────

# Whatever started this run (see the header). No published file — a fresh
# boot, a first install — means nothing to throttle against.
if have_prev; then
  if [ $((NOW - $(prev_attempt_epoch))) -lt "$MIN_INTERVAL" ]; then
    refuse "GitHub was last tried less than ${MIN_INTERVAL}s ago; not trying again yet"
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
  publish_state not-installed "$GH_REASON"
  refuse "$GH_REASON"
  ;;
*)
  github_error "$GH_ERROR"
  ;;
esac

OTHERS_LISTED=1
gh_other_installations || OTHERS_LISTED=0

printf '%s' "$PERMISSIONS" >"$GH_TMP/wanted.json"
if ! gh_narrow "$GH_TMP/wanted.json" "$GH_TMP/installation.json" "$GH_TMP/permissions.json" "$GH_TMP/missing.json"; then
  local_failure "could not narrow the permissions to the installation's grant"
fi
if ! gh_mint "$GH_TMP/permissions.json"; then
  github_error "$GH_ERROR"
fi

publish_ok
if [ "$OTHERS_LISTED" = 1 ]; then
  mint_others
else
  echo "could not read the App's other installations; $OTHERS_OUT left as it was" >&2
fi
# The helper's `done` detail. Not an exit: when a script's
# LAST command always exits, ShellCheck 0.11 reports every function it cannot
# see being called (lib.sh's op_* run through as_operator_fn, gh_cleanup
# through the trap) as SC2329, and writeShellApplication fails the build on it.
verb_done "minted a token for installation $(jq -r '.id' "$GH_TMP/installation.json") on $(jq -r '.account.login' "$GH_TMP/installation.json"), expiring $(jq -r '.expires_at' "$GH_TMP/token.json")"
