# Daily cleanup behind daedalus's box builds (host/build.sh).
#
# BuildKit collects its own cache by policy (buildkitd.toml's gcpolicy blocks);
# this sweeps what sits outside that policy or slips past it:
#
#   work dirs   $WORK_ROOT/<id> older than a day. build.sh removes its own on
#               exit, so what is left here is a run killed hard enough to skip
#               its trap (a reboot mid-clone). No build runs for a day, so an
#               old one is never a live one.
#   logs        the newest $KEEP_LOGS in $LOG_DIR stay, the rest go. The build
#               page reads a log by build id, and a build older than the last
#               forty has no page anyone opens.
#   cache       `buildctl prune --keep-duration 168h`: records nothing has used
#               for a week, beyond whatever the daemon's own GC already took.
#
# Inlined by build-agent.nix after its variable block; expects WORK_ROOT,
# LOG_DIR, BUILDKIT_ADDR, BUILD_USER, BUILD_GROUP, BUILD_PATH, SETPRIV and
# ENV_BIN.
#
# The work dirs belong to the build user and so does every file a repository
# put in them, symlinks included — so the sweep there runs AS that user,
# where a planted link reaches nothing root's could. The logs sit in a
# directory only root can write, so root removes those by name.

set -euo pipefail

KEEP_LOGS=40

# Two runs at once (the timer's catch-up after boot and a manual start) would
# only race each other's rm; the second one has nothing to add.
exec 9>/run/daedalus-build-gc.lock
if ! flock -n 9; then
  echo "another daedalus-build-gc run holds the lock; nothing to do"
  exit 0
fi

# The build user, with an environment built from nothing.
as_build() {
  "$SETPRIV" --reuid="$BUILD_USER" --regid="$BUILD_GROUP" --init-groups --inh-caps=-all \
    "$ENV_BIN" -i PATH="$BUILD_PATH" HOME=/var/empty LANG=C.UTF-8 "$@"
}

rc=0

if [ -d "$WORK_ROOT" ]; then
  stale="$(as_build find "$WORK_ROOT" -mindepth 1 -maxdepth 1 -mtime +0 -printf '.' | wc -c)"
  if as_build find "$WORK_ROOT" -mindepth 1 -maxdepth 1 -mtime +0 -exec rm -rf -- '{}' +; then
    echo "removed $stale work dir(s) older than a day"
  else
    echo "could not remove every stale work dir under $WORK_ROOT" >&2
    rc=1
  fi
else
  echo "no work directory at $WORK_ROOT (dataset not mounted?)" >&2
  rc=1
fi

if [ -d "$LOG_DIR" ]; then
  mapfile -t old < <(
    find "$LOG_DIR" -maxdepth 1 -type f -name '*.log' -printf '%T@ %f\n' |
      sort -rn | tail -n +"$((KEEP_LOGS + 1))" | cut -d' ' -f2-
  )
  for f in "${old[@]}"; do
    rm -f -- "${LOG_DIR:?}/$f"
  done
  echo "removed ${#old[@]} build log(s) beyond the newest $KEEP_LOGS"
fi

# The prune prints every record it drops; the totals at the end are the part
# worth a journal line.
if as_build timeout 30m buildctl --addr "$BUILDKIT_ADDR" prune --keep-duration 168h >/tmp/prune.out 2>&1; then
  tail -n 3 /tmp/prune.out
else
  tail -n 20 /tmp/prune.out >&2
  echo "buildctl prune failed" >&2
  rc=1
fi

[ "$rc" -eq 0 ]
