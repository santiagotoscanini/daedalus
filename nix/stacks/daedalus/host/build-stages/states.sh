# host/build-stages/states.sh — what the build's status says, as every script
# that reads it needs to know: which states mean "in flight", and what a build
# id is.
#
# Read by the build itself (helpers.sh: the stage clock in _advance;
# 0-request.sh: the request's id), by its reaper (host/build-reaper.sh: only
# an in-flight run is marked interrupted) and by the cancel verb
# (host/build-cancel.sh: only an in-flight run is stopped). The engine's copies
# are ACTIVE_BUILD_STATES and BUILD_ID_RE in app/src/lib/builds.ts:
# builds.test.ts reads BUILD_ID_RE out of this file and fails on any
# difference, and a state added to one list is added to the other.
BUILD_ACTIVE_STATES='cloning detecting checking building publishing'

# A build id: the engine's builds row id, and the log file's stem — so
# nothing a request carries can name a path. (Unused by the cancel verb.)
# shellcheck disable=SC2034
BUILD_ID_RE='^[0-9a-fA-F-]{1,64}$'

# Is state $1 exactly one of them? Compared word by word, never as a
# substring, so a status of "cloning detecting" does not read as in flight.
build_active() {
  local s
  for s in $BUILD_ACTIVE_STATES; do
    [ "${1-}" = "$s" ] && return 0
  done
  return 1
}
