# The root helper's `build-cancel` verb: `daedalus-build-cancel@<app>.service`
# (build-agent.nix), started by the helper (stacks/daedalus root-helper.nix)
# with the app it names as the instance, `$1` here.
#
# Inlined by build-agent.nix after host/lib.sh and host/build-stages/states.sh;
# expects STATUS (build-status.json, in the root-only verbs directory) and
# BUILDABLE.
#
# The engine cannot stop a build itself — the agent is a root unit — so it
# names the app whose build it means, and this turns that into the one thing
# that actually stops a run: stopping the unit, whose ExecStopPost reaper
# (host/build-reaper.sh) then publishes `failed: interrupted`. The engine waits
# for this unit's answer and only on a stop writes the row as
# cancelled-by-operator, over that `interrupted` (app lib/repo/builds.ts
# `markCancelled`); a refusal leaves the row to the host.
#
# It stops the CURRENT run only, and only when it is that app's: a cancel that
# arrives after the build it meant finished and another app's started must not
# kill an innocent build.
#
# Every refusal is `refuse` (host/lib.sh), exit 0: a cancel that arrives too
# late is ordinary, and a failing unit here would mail the operator about
# nothing.

want="${1-}"
# The helper passes only a value from BUILDABLE; asked again on the side that
# stops a unit.
[ -n "$want" ] || refuse "no app named"
case " $BUILDABLE " in
*" $want "*) ;;
*) refuse "'$want' is not an app this box builds" ;;
esac

status_json="$(cat -- "$STATUS" 2>/dev/null)" || refuse "no build is running"
[ "$(jq -r '.app // ""' <<<"$status_json" 2>/dev/null || true)" = "$want" ] ||
  refuse "the build in flight is not $want's"
# host/build-stages/states.sh
build_active "$(jq -r '.state // ""' <<<"$status_json" 2>/dev/null || true)" ||
  refuse "$want has no build in flight"

echo "cancelling $want's build at the operator's request"
# Every instance: the helper runs one build at a time.
systemctl stop 'daedalus-build@*.service' || true
verb_done "stopped"
