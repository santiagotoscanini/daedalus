# Apply a registry change: put the exported file in the flake, commit it,
# rebuild the system. Roll everything back if the rebuild fails.
#
# Deliberately dumb. It does NOT generate, transform or validate the registry
# — daedalus renders the exact bytes (src/lib/registry-file.ts) and drops them
# at $APPLY_DIR/apps.json; this copies that file verbatim. Every decision about
# shape is application logic and belongs in TypeScript, where it can be typed
# and tested. What is left here is the part that genuinely needs the host: a
# privileged rebuild, and git.
#
# jq survives for exactly two jobs, both about *this* script's own bookkeeping
# rather than the registry: reading the request metadata, and emitting a status
# file with a correctly-escaped error string.
#
# Runs as root, because only root can `nixos-rebuild switch`. Every git call
# drops to santiago with setpriv so the repo never acquires root-owned objects
# — the same reason flake-autoupgrade does it. setpriv, not sudo/runuser:
# those open a PAM session per call.
#
# The container never runs any of this. It writes files into a bind mount; a
# systemd.path unit notices and starts this. So the app holds no privilege it
# could lose — the trust boundary is "can write into $APPLY_DIR", and
# everything that can already has NOPASSWD sudo.

set -euo pipefail

REQ="$APPLY_DIR/request.json"
PAYLOAD="$APPLY_DIR/apps.json"
STATUS="$APPLY_DIR/status.json"
LOGFILE="$APPLY_DIR/last.log"

# Status is the ONLY channel back to the UI, so it is written at every exit
# path including the failure ones. `phase` drives the progress display;
# `error` is shown verbatim, so it carries the real message rather than
# "something went wrong".
write_status() {
  install -m 0644 -o santiago -g users /dev/stdin "$STATUS" <<EOF
{"id":"$REQ_ID","state":"$1","phase":"$2","error":$(jq -Rn --arg e "${3-}" '$e'),"finishedAt":"$(date -Is)","commit":"${COMMIT_SHA-}"}
EOF
}

fail() {
  write_status failed "$1" "$2"
  echo "apply failed at $1: $2" >&2
  exit 1
}

[ -f "$REQ" ] || exit 0

REQ_ID="$(jq -r '.id // ""' "$REQ")"
[ -n "$REQ_ID" ] || exit 0

# The path unit fires on any write to the request file, and again on a
# daemon-reload replay at boot. Without this guard a completed apply could
# re-run its own rebuild forever.
if [ -f "$STATUS" ] && [ "$(jq -r '.id // ""' "$STATUS")" = "$REQ_ID" ]; then
  exit 0
fi

COMMIT_SHA=""
write_status running validating ""

# request.json is written after apps.json precisely so this cannot race, but
# check rather than assume: a missing payload here would otherwise commit an
# empty registry and take every app down.
[ -s "$PAYLOAD" ] || fail validating "no apps.json payload alongside the request"

SUMMARY="$(jq -r '.summary // "update app registry"' "$REQ")"
ACTOR="$(jq -r '.actor // "daedalus"' "$REQ")"

PREV_HEAD="$(setpriv --reuid=santiago --regid=users --init-groups git -C "$FLAKE" rev-parse HEAD)"

# --- write ----------------------------------------------------------------
write_status running writing ""
install -m 0644 -o santiago -g users "$PAYLOAD" "$TARGET"

# --- commit ---------------------------------------------------------------
# The flake only sees git-tracked files, so `git add` is not bookkeeping — an
# unstaged change is invisible to the rebuild below.
write_status running committing ""
setpriv --reuid=santiago --regid=users --init-groups git -C "$FLAKE" add "$TARGET"

if setpriv --reuid=santiago --regid=users --init-groups git -C "$FLAKE" diff --cached --quiet; then
  write_status "done" "no-change" ""
  exit 0
fi

setpriv --reuid=santiago --regid=users --init-groups \
  git -C "$FLAKE" -c "user.name=daedalus" -c "user.email=$GIT_EMAIL" \
  commit -q -m "apps: $SUMMARY" -m "Applied from daedalus by $ACTOR." ||
  fail committing "git commit failed"

COMMIT_SHA="$(setpriv --reuid=santiago --regid=users --init-groups git -C "$FLAKE" rev-parse --short HEAD)"

# --- roll back ------------------------------------------------------------
# Used by both failure paths below. Resets the repo to the pre-apply commit
# and puts the running system back on it, so a bad apply leaves neither a
# broken box nor a lying git history.
rollback() {
  setpriv --reuid=santiago --regid=users --init-groups git -C "$FLAKE" reset --hard "$PREV_HEAD" >/dev/null 2>&1 || true
  nixos-rebuild switch --flake "$FLAKE#$HOSTNAME" >>"$LOGFILE" 2>&1 || true
  COMMIT_SHA=""
}

# --- build ----------------------------------------------------------------
# `build` first: it catches eval errors and build failures without touching
# the running system, which is the difference between a rejected change and a
# broken box. A malformed registry dies here.
write_status running building ""
: >"$LOGFILE"
chown santiago:users "$LOGFILE"
if ! nixos-rebuild build --flake "$FLAKE#$HOSTNAME" >>"$LOGFILE" 2>&1; then
  rollback
  fail building "$(tail -c 1200 "$LOGFILE")"
fi

# --- switch ---------------------------------------------------------------
write_status running switching ""
if ! nixos-rebuild switch --flake "$FLAKE#$HOSTNAME" >>"$LOGFILE" 2>&1; then
  rollback
  fail switching "$(tail -c 1200 "$LOGFILE")"
fi

# --- push -----------------------------------------------------------------
# Best-effort: /etc/nixos lives on rpool/root, which has no snapshots and is
# not in the syncoid mirror, so the remote is the only backup. But a network
# blip must not turn a successful rebuild into a reported failure.
write_status running pushing ""
setpriv --reuid=santiago --regid=users --init-groups git -C "$FLAKE" push >>"$LOGFILE" 2>&1 ||
  echo "push failed (the switch succeeded; the commit is local only)" >>"$LOGFILE"

write_status "done" "complete" ""
