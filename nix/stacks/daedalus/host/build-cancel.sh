# The `cancel` verb: daedalus-build-cancel.service, started by its path unit
# when the engine drops build-cancel-request.json.
#
# Inlined by build-agent.nix after host/lib.sh and host/build/states.sh;
# expects REQ (the cancel
# request), STATUS (build-status.json), OPERATOR_USER, OPERATOR_GROUP and
# SETPRIV.
#
# The engine cannot stop a build itself — the agent is a root unit — so it
# drops a request naming the build it means, and this turns that into the one
# thing that actually stops a run: stopping the unit, whose ExecStopPost
# reaper (host/build-reaper.sh) then publishes `failed: interrupted`. The
# engine has already written the row as cancelled-by-operator, and `cancelled`
# is terminal, so the reaper cannot overwrite it.
#
# It stops the CURRENT run only: a request that names anything other than the
# build the status file says is in flight is ignored. Without that, a cancel
# that arrived a second late — after the build it named finished and the next
# one started — would kill an innocent build.

# Every refusal is exit 0: a cancel that arrives too late is ordinary, and a
# failing unit here would mail the operator about nothing.
req_json="$(read_request "$REQ")" || exit 0
[ "$(jq -r '.version // 0' <<<"$req_json" 2>/dev/null || echo 0)" = "1" ] || exit 0
want="$(jq -r '.id // ""' <<<"$req_json" 2>/dev/null || true)"
[[ "$want" =~ ^[0-9a-fA-F-]{1,64}$ ]] || exit 0

status_json="$(read_as_operator "$STATUS")" || exit 0
[ "$(jq -r '.id // ""' <<<"$status_json" 2>/dev/null || true)" = "$want" ] || exit 0
build_active "$(jq -r '.state // ""' <<<"$status_json" 2>/dev/null || true)" || exit 0 # host/build/states.sh

echo "cancelling build $want at the operator's request"
systemctl stop daedalus-build.service || true
