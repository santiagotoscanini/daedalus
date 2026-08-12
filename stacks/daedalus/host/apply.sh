# Apply a registry change: put the exported file in the flake, commit it,
# rebuild the system. Roll everything back if the rebuild fails.
#
# Deliberately dumb. It does NOT generate, transform or validate the registry
# — daedalus renders the exact bytes (src/lib/registry-file.ts) and drops them
# at $APPLY_DIR/payload-<id>.json; this copies that file verbatim. Every
# decision about shape is application logic and belongs in TypeScript, where
# it can be typed and tested. What is left here is the part that genuinely
# needs the host: a privileged rebuild, and git.
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
STATUS="$APPLY_DIR/status.json"
LOGFILE="$APPLY_DIR/last.log"

# Status is the ONLY channel back to the UI, so it is written at every exit
# path including the failure ones. `phase` drives the progress display;
# `error` is shown verbatim, so it carries the real message rather than
# "something went wrong". Atomic via write_json_atomic (host/lib.sh) — a
# torn status reads as "idle" in the app, which mid-rebuild is a lie.
write_status() {
  write_json_atomic "$STATUS" <<EOF
{"id":"$REQ_ID","state":"$1","phase":"$2","error":$(jq -Rn --arg e "${3-}" '$e'),"startedAt":"$STARTED_AT","finishedAt":"$(date -Is)","commit":"${COMMIT_SHA-}"}
EOF
}

fail() {
  write_status failed "$1" "$2"
  echo "apply failed at $1: $2" >&2
  exit 1
}

# What to show the operator when a rebuild fails.
#
# MUST be captured BEFORE rollback() runs. rollback appends its own
# `nixos-rebuild switch` to this same log, and that one succeeds — so a tail
# taken afterwards shows the rollback finishing with "Done. The new
# configuration is /nix/store/…" and the real error scrolled out of the
# window. That is exactly what happened to the argus/postgres apply: the panel
# reported a failure whose text read like a success, and the assertion that
# actually stopped it was 14 kB earlier in the file.
#
# The `--sdnotify=conmon` eval warnings are dropped for the same reason: there
# is one per rootless container (~40 of them, two lines each), they are
# cosmetic — see the note in platform/podman.nix — and left in they fill the
# whole window on their own.
errtail() {
  grep -vE '^(evaluation warning: Podman container|[[:space:]]+with `--sdnotify=conmon)' "$LOGFILE" |
    tail -c 1200
}

[ -f "$REQ" ] || exit 0

REQ_ID="$(jq -r '.id // ""' "$REQ")"
[ -n "$REQ_ID" ] || exit 0
# The id names a path below, and request.json is written by the container —
# the far side of the trust boundary. Constrain it to UUID characters so a
# crafted id cannot traverse out of $APPLY_DIR; a request the app didn't
# write this way is not one worth answering.
[[ "$REQ_ID" =~ ^[0-9a-fA-F-]+$ ]] || exit 0
STARTED_AT="$(date -Is)"

# The payload rides under the request's own id — derived from the id HERE,
# never read as a filename from the request body. A second Apply queued while
# this one runs writes payload-<other-id>.json and cannot touch the bytes
# this run is committing; the old fixed apps.json name was the last TOCTOU
# sliver in the bridge.
PAYLOAD="$APPLY_DIR/payload-$REQ_ID.json"

# The path unit fires on any write to the request file, and again on a
# daemon-reload replay at boot. Without this guard a completed apply could
# re-run its own rebuild forever.
if [ -f "$STATUS" ] && [ "$(jq -r '.id // ""' "$STATUS")" = "$REQ_ID" ]; then
  exit 0
fi

COMMIT_SHA=""

# --- serialise against every other rebuild --------------------------------
# One lock for anything that rebuilds this system or commits to /etc/nixos.
# The other holder in practice is flake-autoupgrade, which does `nix flake
# update --commit-lock-file` AND `nixos-rebuild boot` — so it can be building,
# committing and pushing at the same moment an apply is doing all three.
# Overlapping activations and interleaved commits on a shared repo are exactly
# how this ends up with a system that matches neither branch.
#
# A shared path, not a daedalus-private one: a lock only this script respects
# would protect nothing. platform/autoupgrade takes the same one, and a human
# running `nixos-rebuild` by hand can take it with
# `flock /run/lock/s2-rebuild.lock nixos-rebuild switch`.
#
# WAIT rather than fail: the common case is a weekly upgrade that finishes in
# minutes, and the UI shows the wait as its own phase. Released implicitly when
# fd 9 closes at exit — including on failure, so a crashed apply cannot wedge
# every future rebuild.
exec 9>"$LOCKFILE"
write_status running waiting ""
if ! flock -w 1200 9; then
  fail waiting "another rebuild held $LOCKFILE for 20 minutes (flake-autoupgrade, or a manual nixos-rebuild). Nothing was changed."
fi

write_status running validating ""

# request.json is written after the payload precisely so this cannot race,
# but check rather than assume: a missing payload here would otherwise commit
# an empty registry and take every app down.
[ -s "$PAYLOAD" ] || fail validating "no payload-$REQ_ID.json alongside the request"

SUMMARY="$(jq -r '.summary // "update app registry"' "$REQ")"
ACTOR="$(jq -r '.actor // "daedalus"' "$REQ")"

# --- write ----------------------------------------------------------------
write_status running writing ""
install -m 0644 -o santiago -g users "$PAYLOAD" "$TARGET"
# Copied into the flake; the id-stamped file has served its purpose. Removed
# now rather than at exit so a failure path cannot leave payloads
# accumulating in the mount — rollback works from git, not from this file.
rm -f "$PAYLOAD"

# --- commit ---------------------------------------------------------------
# The flake only sees git-tracked files, so `git add` is not bookkeeping — an
# unstaged change is invisible to the rebuild below.
write_status running committing ""
setpriv --reuid=santiago --regid=users --init-groups git -C "$FLAKE" add "$TARGET"

# Scoped to $TARGET, both times.
#
# This repo's index is shared: a human at a shell, or flake-autoupgrade, can
# have unrelated work staged when an apply fires. A bare `git commit` commits
# the whole INDEX, so an apply would sweep that work into a commit titled
# "apps: <some field>" and then push it — which is exactly what happened once.
# `commit -- "$TARGET"` commits only this file and leaves everything else
# staged and untouched; the emptiness check is scoped the same way so foreign
# staged changes cannot make an apply look non-empty either.
if setpriv --reuid=santiago --regid=users --init-groups \
  git -C "$FLAKE" diff --cached --quiet -- "$TARGET"; then
  write_status "done" "no-change" ""
  exit 0
fi

setpriv --reuid=santiago --regid=users --init-groups \
  git -C "$FLAKE" -c "user.name=daedalus" -c "user.email=$GIT_EMAIL" \
  commit -q -m "apps: $SUMMARY" -m "Applied from daedalus by $ACTOR." -- "$TARGET" ||
  fail committing "git commit failed"

COMMIT_SHA="$(setpriv --reuid=santiago --regid=users --init-groups git -C "$FLAKE" rev-parse --short HEAD)"
# The exact commit this apply created — what rollback() reverts. Captured
# rather than recomputed, so a concurrent commit cannot make the rollback
# target something this apply never wrote.
APPLY_COMMIT="$COMMIT_SHA"

# --- roll back ------------------------------------------------------------
# Undo this apply's change and put the running system back on the result.
#
# `git revert`, NOT `git reset --hard $PREV_HEAD`. The reset version destroyed
# any commit made between the start of the apply and its failure — this repo is
# shared with a human at a shell and with flake-autoupgrade, and it really did
# eat an unrelated commit the first time a switch failed. A revert undoes
# exactly this apply's commit and leaves everything else alone, at the cost of
# two commits in the log instead of none. That is the right trade for a repo
# whose whole job is to be an honest record.
rollback() {
  setpriv --reuid=santiago --regid=users --init-groups \
    git -C "$FLAKE" -c "user.name=daedalus" -c "user.email=$GIT_EMAIL" \
    revert --no-edit "$APPLY_COMMIT" >>"$LOGFILE" 2>&1 ||
    # A revert can only fail if the tree moved under us in a conflicting way.
    # Leave the repo alone in that case: a human untangling a conflict is far
    # better than a script guessing.
    echo "revert of $APPLY_COMMIT failed — repo left as-is, resolve by hand" >>"$LOGFILE"
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
  build_error="$(errtail)"
  rollback
  fail building "$build_error"
fi

# --- switch ---------------------------------------------------------------
# Retried once before giving up. `switch` exits non-zero if ANY unit fails to
# come back, and some of those failures are transient rather than caused by the
# change: DNS is briefly unavailable while pi-hole restarts, so a unit that
# talks to the network (cloudflared-route-sync, reconciling CF CNAMEs) can fail
# and then succeed on its own Restart=on-failure seconds later. Rolling back on
# that is both unnecessary and destructive — it reverts a change that was
# perfectly good. Observed in practice; the second attempt succeeds.
write_status running switching ""
if ! nixos-rebuild switch --flake "$FLAKE#$HOSTNAME" >>"$LOGFILE" 2>&1; then
  echo "switch failed once — retrying in 20s before rolling back" >>"$LOGFILE"
  sleep 20
  if ! nixos-rebuild switch --flake "$FLAKE#$HOSTNAME" >>"$LOGFILE" 2>&1; then
    switch_error="$(errtail)"
    rollback
    fail switching "$switch_error"
  fi
  echo "switch succeeded on retry (first failure was transient)" >>"$LOGFILE"
fi

# --- push -----------------------------------------------------------------
# Best-effort: /etc/nixos lives on rpool/root, which has no snapshots and is
# not in the syncoid mirror, so the remote is the only backup. But a network
# blip must not turn a successful rebuild into a reported failure.
write_status running pushing ""
setpriv --reuid=santiago --regid=users --init-groups git -C "$FLAKE" push >>"$LOGFILE" 2>&1 ||
  echo "push failed (the switch succeeded; the commit is local only)" >>"$LOGFILE"

write_status "done" "complete" ""
