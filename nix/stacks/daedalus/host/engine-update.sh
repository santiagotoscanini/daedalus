# Move the engine's pin — the configuration's `daedalus` flake input — and
# rebuild onto it.
#
# The sibling of host/image-update.sh, aimed at flake.lock instead of a `.nix`
# file. An image update rewrites a digest and rebuilds; this one asks nix to
# re-resolve ONE input, and rebuilds. Everything else is the same shape, on
# purpose: build before anything is committed, one retry on the switch, verify
# that the thing being updated actually came back, revert rather than reset
# when it did not, push last and best-effort.
#
# ── what "latest" means ───────────────────────────────────────────────────
#
# The input is read out of the lock, never assumed. The reference arrangement
# is `git+file://<clone>?ref=main`: the engine's own working clone on this
# box, which the running control plane is bind-mounted from. There "latest"
# is that clone's `main` after a fast-forward from origin, and the clone is
# moved HERE, as the operator, before nix is asked — `nix flake update` reads
# commits, so a fetch that never touched the branch would resolve to what was
# already pinned. A `github:` input (the published engine, tag-pinning
# deferred) needs no clone step: nix resolves the branch head itself.
#
# One branch, `main`, always. A clone whose branch has commits that are not
# on origin is DIVERGED, and this refuses it rather than deciding what to do
# with the operator's unpushed work: push them, then update. A dirty working
# tree is fine — git refuses the fast-forward only if it would touch a dirty
# file, and then this refuses with git's reason.
#
# ── what makes this refuse before it starts ───────────────────────────────
#
# An engine override (site.json `developer.engineOverride`, host/lib.sh's
# site_engine_override). While it is set every Apply builds from a local tree
# with `--override-input` and the lock untouched, so the running system is
# not the pinned engine at all; moving the pin under it would commit a rev
# that nothing is running and that the next Apply would not build. The app
# refuses the request first (host/engine-flow.ts); this is the one that
# holds.
#
# A dirty flake.lock, for the reason platform/autoupgrade gives: the restore
# on a failed build and the commit on a successful one both assume the lock
# was clean when this started.
#
# ── verifying ─────────────────────────────────────────────────────────────
#
# "It came back" means the control plane answers its own health path at its
# published address, through the reverse proxy on the LAN address — the same
# request an operator makes by hand after a rebuild. Polled rather than
# checked once: an engine commit that touches the container's definition
# restarts it, and a dev-server start reinstalls its dependencies first,
# which takes minutes on a cold cache. Past the budget the lock commit is
# reverted and the box switched back onto the previous engine.
#
# Runs as root, because only root can `nixos-rebuild switch`. Every git call —
# in the configuration and in the clone — and `nix flake update` drop to the
# operator with setpriv: both trees are theirs, and one root-owned object
# under .git is the "unable to open loose object" push failure. Everything in
# $APPLY_DIR is read and written as the operator and never through a link;
# host/lib.sh has the argument.

set -euo pipefail

REQ="$APPLY_DIR/engine-request.json"
STATUS="$APPLY_DIR/engine-status.json"
LOGFILE="$APPLY_DIR/engine-last.log"

# The flake input this agent moves. The lock is read for it by name, so a
# configuration that calls the engine something else fails validating with
# the name rather than moving the wrong input.
INPUT=daedalus

# `from` is what the lock held when the run started, `to` what it moved to —
# published from the moment each is known, so the page can name the move
# while it happens. Equal on a no-op.
FROM_REV=""
TO_REV=""

write_status() {
  write_json_atomic "$STATUS" <<EOF
{"id":"$REQ_ID","state":"$1","phase":"$2","error":$(jq -Rn --arg e "${3-}" '$e'),"from":"$FROM_REV","to":"$TO_REV","startedAt":"$STARTED_AT","finishedAt":"$(date -Is)","commit":"${COMMIT_SHA-}"}
EOF
}

fail() {
  write_status failed "$1" "$2"
  echo "engine update failed at $1: $2" >&2
  exit 1
}

# Captured BEFORE rollback runs, for the reason apply.sh spells out: rollback
# appends its own successful switch to this same log, and a tail taken
# afterwards shows a success with the real error scrolled out of the window.
errtail() {
  log_errtail "$LOGFILE"
}

[ -f "$REQ" ] || exit 0

# Read once, as the operator, never through a link (host/lib.sh); a symlinked
# request is refused with a failed unit — the app never writes one.
REQ_JSON="$(read_request "$REQ")" || exit 1

REQ_ID="$(jq -r '.id // ""' <<<"$REQ_JSON")"
[ -n "$REQ_ID" ] || exit 0
# Same UUID constraint as every other bridge: the id lands in a status file
# and a log line.
[[ "$REQ_ID" =~ ^[0-9a-fA-F-]+$ ]] || exit 0
STARTED_AT="$(date -Is)"
COMMIT_SHA=""

# Replay guard: the path unit fires on a daemon-reload at boot as well as on a
# write, and without this a completed update would rebuild the box on every
# reboot.
if [ -f "$STATUS" ] && [ "$(published_id "$STATUS")" = "$REQ_ID" ]; then
  exit 0
fi

ACTOR="$(jq -r '.actor // "daedalus"' <<<"$REQ_JSON")"

# git in the configuration checkout, as the operator. Absolute paths, because
# the privilege-dropped child does not inherit writeShellApplication's PATH —
# the trap every sibling script documents. No prompts: a fetch or push that
# wants a passphrase must fail, not hang the unit.
git_() {
  "$SETPRIV" --reuid="$OPERATOR_USER" --regid="$OPERATOR_GROUP" --init-groups --inh-caps=-all \
    "$ENV_BIN" HOME="$OPERATOR_HOME" GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND="ssh -o BatchMode=yes" \
    "$GIT" -C "$FLAKE" "$@"
}

# git in the engine clone, as the operator — the same call aimed at the other
# tree. $CLONE is set in validating, from the lock.
git_clone() {
  "$SETPRIV" --reuid="$OPERATOR_USER" --regid="$OPERATOR_GROUP" --init-groups --inh-caps=-all \
    "$ENV_BIN" HOME="$OPERATOR_HOME" GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND="ssh -o BatchMode=yes" \
    "$GIT" -C "$CLONE" "$@"
}

# System nix, not pkgs.nix, as the operator: platform/autoupgrade's reason —
# the running nix honors /etc/gitconfig's safe.directory for the
# operator-owned checkout, and a mismatched pkgs.nix trips libgit2's ownership
# check and fails the unit.
nix_() {
  "$SETPRIV" --reuid="$OPERATOR_USER" --regid="$OPERATOR_GROUP" --init-groups --inh-caps=-all \
    "$ENV_BIN" HOME="$OPERATOR_HOME" \
    /run/current-system/sw/bin/nix "$@"
}

# The lock's node for $INPUT, as JSON, read as the operator. Prints nothing
# when the lock has no such input.
lock_node() {
  { read_as_operator "$FLAKE/flake.lock" 2>/dev/null || true; } |
    jq -c --arg i "$INPUT" '.nodes[.nodes.root.inputs[$i] // ""] // empty' 2>/dev/null || true
}

# --- validate -------------------------------------------------------------
write_status running validating ""

override="$(site_engine_override)"
[ -z "$override" ] ||
  fail validating "clear the engine override first: the running system is built from $override, not from the pinned engine (site.json developer.engineOverride, Settings › Developer)"

[ -f "$FLAKE/flake.lock" ] || fail validating "$FLAKE has no flake.lock"
if ! git_ diff --quiet -- flake.lock; then
  fail validating "flake.lock has uncommitted changes in $FLAKE — commit or restore it first"
fi

node="$(lock_node)"
[ -n "$node" ] || fail validating "flake.lock in $FLAKE has no '$INPUT' input"
FROM_REV="$(jq -r '.locked.rev // ""' <<<"$node")"
[ -n "$FROM_REV" ] || fail validating "the '$INPUT' input is not locked to a rev"

# What kind of input, and therefore where "latest" comes from. The original
# (as written in flake.nix) rather than the locked form: the locked url of a
# git input is the same string, and the ref is only in the original.
kind="$(jq -r '.original.type // ""' <<<"$node")"
url="$(jq -r '.original.url // ""' <<<"$node")"
REF="$(jq -r '.original.ref // "main"' <<<"$node")"
CLONE=""
case "$kind" in
git)
  case "$url" in
  file://*) CLONE="${url#file://}" ;;
  *) fail validating "the '$INPUT' input is a git url this agent does not fast-forward ($url); only a local clone (file://) or a github: input" ;;
  esac
  [ -d "$CLONE/.git" ] || fail validating "$CLONE (the '$INPUT' input's clone) is not a git checkout"
  ;;
github) ;;
*) fail validating "the '$INPUT' input is of type '$kind'; this agent moves a git+file clone or a github: input" ;;
esac

# --- serialise against every other rebuild --------------------------------
# The shared lock, same as apply.sh and image-update.sh: overlapping
# activations and interleaved commits on one repo are how this box ends up
# matching neither branch. Waits rather than fails; released when fd 9 closes
# at exit, including on failure.
exec 9>"$LOCKFILE"
write_status running waiting ""
if ! flock -w 1200 9; then
  fail waiting "another rebuild held $LOCKFILE for 20 minutes (flake-autoupgrade, or a manual nixos-rebuild). Nothing was changed."
fi

log_reset "$LOGFILE"

# --- fetch ----------------------------------------------------------------
# The clone's branch, brought up to origin — fast-forward only. Nothing here
# checks out, resets or merges: a dirty tree is left as found, and git refuses
# the fast-forward itself if an incoming commit would touch a dirty file.
write_status running fetching ""
if [ -n "$CLONE" ]; then
  current="$(git_clone rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  [ "$current" = "$REF" ] ||
    fail fetching "the clone $CLONE is on '${current:-?}', not '$REF' (the branch the '$INPUT' input names) — check it out first"

  if ! log_run "$LOGFILE" git_clone fetch --quiet --prune origin "$REF"; then
    fail fetching "could not fetch origin/$REF in $CLONE — $(errtail)"
  fi

  # Diverged: local commits that origin does not have. Refused, never
  # merged or rebased — those are the operator's commits, and "one branch,
  # main, always" means they belong on origin before anything pins them.
  ahead="$(git_clone rev-list --count "origin/$REF..$REF" 2>/dev/null || echo "?")"
  [ "$ahead" = 0 ] ||
    fail fetching "the clone's $REF has $ahead commit(s) that are not on origin/$REF — push them first (one branch, main, always), then update"

  if ! log_run "$LOGFILE" git_clone merge --ff-only --quiet "origin/$REF"; then
    fail fetching "could not fast-forward $REF in $CLONE — $(errtail)"
  fi
fi

# --- resolve --------------------------------------------------------------
# `nix flake update <input>`: re-resolve this one input to its branch head
# and rewrite the lock. The lock is what nixos-rebuild reads, so nothing has
# changed on the box yet — and if the lock did not move, nothing will.
write_status running resolving ""
if ! log_run "$LOGFILE" nix_ flake update "$INPUT" --flake "$FLAKE"; then
  resolve_error="$(errtail)"
  git_ checkout -- flake.lock
  fail resolving "$resolve_error"
fi

node="$(lock_node)"
TO_REV="$(jq -r '.locked.rev // ""' <<<"$node")"

if git_ diff --quiet -- flake.lock || [ "$TO_REV" = "$FROM_REV" ]; then
  # Already current — or the lock moved without the rev moving (a metadata
  # refresh), which is not an update anyone asked for.
  git_ checkout -- flake.lock
  TO_REV="$FROM_REV"
  write_status "done" "no-change" ""
  exit 0
fi

# --- build ----------------------------------------------------------------
# Without touching the running system: an eval error or a build failure dies
# here, with the lock put back — nothing was committed.
write_status running building ""
if ! log_run "$LOGFILE" nixos-rebuild build --flake "$FLAKE#$HOSTNAME"; then
  build_error="$(errtail)"
  git_ checkout -- flake.lock
  TO_REV=""
  fail building "$build_error"
fi

# --- commit ---------------------------------------------------------------
# Scoped to flake.lock, here and in the message: this index is shared with a
# person at a shell, and a bare commit would sweep their staged work into a
# commit titled after an engine bump and then push it.
write_status running committing ""
git_ add -- flake.lock
git_ -c "user.name=$(commit_name)" -c "user.email=$(commit_email)" \
  commit -q \
  -m "engine: $INPUT ${FROM_REV:0:7} → ${TO_REV:0:7}" \
  -m "flake.lock: '$INPUT' $FROM_REV → $TO_REV" \
  -m "Applied from daedalus by $ACTOR." \
  -- flake.lock ||
  fail committing "git commit failed"

COMMIT_SHA="$(git_ rev-parse --short HEAD)"
UPDATE_COMMIT="$COMMIT_SHA"

# --- roll back ------------------------------------------------------------
# `git revert`, not `reset --hard`: this repo is shared, and a reset really
# did eat an unrelated commit the first time an apply's switch failed.
rollback() {
  log_run "$LOGFILE" git_ -c "user.name=$(commit_name)" -c "user.email=$(commit_email)" \
    revert --no-edit "$UPDATE_COMMIT" ||
    log_line "$LOGFILE" "revert of $UPDATE_COMMIT failed — repo left as-is, resolve by hand"
  log_run "$LOGFILE" nixos-rebuild switch --flake "$FLAKE#$HOSTNAME" || true
  COMMIT_SHA=""
}

# --- switch ---------------------------------------------------------------
# One retry before rolling back, for the reason apply.sh documents: `switch`
# exits non-zero if ANY unit fails to come back, and some of those failures
# are transient rather than caused by the change.
write_status running switching ""
if ! log_run "$LOGFILE" nixos-rebuild switch --flake "$FLAKE#$HOSTNAME"; then
  log_line "$LOGFILE" "switch failed once — retrying in 20s before rolling back"
  sleep 20
  if ! log_run "$LOGFILE" nixos-rebuild switch --flake "$FLAKE#$HOSTNAME"; then
    switch_error="$(errtail)"
    rollback
    fail switching "$switch_error"
  fi
  log_line "$LOGFILE" "switch succeeded on retry (first failure was transient)"
fi

# --- verify ---------------------------------------------------------------
# The control plane at its published address, through the proxy on the LAN
# address: the request an operator makes by hand. Polled for up to ten
# minutes, because a restarted dev server reinstalls before it listens; a
# 200 ends the wait at once. Anything else at the end of the budget is a
# failed update, and the box goes back.
write_status running verifying ""
url="https://$CONTROL_PLANE_HOST$HEALTH_PATH"
answer=""
for _ in $(seq 1 120); do
  answer="$(curl -sk --max-time 10 --resolve "$CONTROL_PLANE_HOST:443:$LAN_IP" \
    -o /dev/null -w '%{http_code}' "$url" 2>/dev/null || true)"
  [ "$answer" = "200" ] && break
  sleep 5
done

if [ "$answer" != "200" ]; then
  log_line "$LOGFILE" "verification failed: $url answered '${answer:-nothing}' for ten minutes after the switch"
  rollback
  fail verifying "the switch succeeded but the control plane at $url did not answer 200 within ten minutes (last answer: ${answer:-none}) — reverted to $FROM_REV"
fi

# --- push -----------------------------------------------------------------
# Best-effort: the configuration checkout usually sits on a root dataset,
# which has no snapshots and is not in the syncoid mirror, so the remote is
# the only backup — but a network blip must not turn a successful rebuild
# into a reported failure.
write_status running pushing ""
log_run "$LOGFILE" git_ push ||
  log_line "$LOGFILE" "push failed (the switch succeeded; the commit is local only)"

write_status "done" "complete" ""
