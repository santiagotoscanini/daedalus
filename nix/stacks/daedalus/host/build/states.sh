# host/build/states.sh — what "a build is in flight" means on the host side.
#
# Read by the build itself (helpers.sh: the stage clock in _advance), by its
# reaper (host/build-reaper.sh: only an in-flight run is marked interrupted)
# and by the cancel verb (host/build-cancel.sh: only an in-flight run is
# stopped). The engine's copy is ACTIVE_BUILD_STATES in app/src/lib/builds.ts;
# a state added to one is added to the other.
BUILD_ACTIVE_STATES='cloning detecting checking building publishing'

# Is state $1 exactly one of them? Compared word by word, never as a
# substring: the status file sits in a container-writable directory, so a
# planted "cloning detecting" must not read as in flight.
build_active() {
  local s
  for s in $BUILD_ACTIVE_STATES; do
    [ "${1-}" = "$s" ] && return 0
  done
  return 1
}
