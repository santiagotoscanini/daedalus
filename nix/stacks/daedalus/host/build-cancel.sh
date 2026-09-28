# The root helper's `build-cancel` verb: `daedalus-build-cancel@<app>.service`
# (build-agent.nix), started by the helper (stacks/daedalus controller.nix,
# `root`) with the app it names as the instance, `$1` here.
#
# Inlined by build-agent.nix after host/lib.sh and host/build-stages/states.sh;
# expects STATUS (build-status.json), BUILDABLE, OPERATOR_USER, OPERATOR_GROUP
# and SETPRIV.
#
# The engine cannot stop a build itself — the agent is a root unit — so it
# names the app whose build it means, and this turns that into the one thing
# that actually stops a run: stopping the unit, whose ExecStopPost reaper
# (host/build-reaper.sh) then publishes `failed: interrupted`. The engine has
# already written the row as cancelled-by-operator, and `cancelled` is
# terminal, so the reaper cannot overwrite it.
#
# It stops the CURRENT run only, and only when it is that app's: a cancel that
# arrives after the build it meant finished and another app's started must not
# kill an innocent build.
#
# Every refusal is exit 0 with a last line `refused: <reason>` (the helper's
# word for it): a cancel that arrives too late is ordinary, and a failing unit
# here would mail the operator about nothing.

refuse() {
  echo "refused: $1"
  exit 0
}

want="${1-}"
# The helper passes only a value from BUILDABLE; asked again on the side that
# stops a unit.
[ -n "$want" ] || refuse "no app named"
case " $BUILDABLE " in
*" $want "*) ;;
*) refuse "'$want' is not an app this box builds" ;;
esac

status_json="$(read_as_operator "$STATUS")" || refuse "no build is running"
[ "$(jq -r '.app // ""' <<<"$status_json" 2>/dev/null || true)" = "$want" ] ||
  refuse "the build in flight is not $want's"
# host/build-stages/states.sh
build_active "$(jq -r '.state // ""' <<<"$status_json" 2>/dev/null || true)" ||
  refuse "$want has no build in flight"

echo "cancelling $want's build at the operator's request"
systemctl stop daedalus-build.service || true
echo "stopped"
