# Restart the Remote Control server, on request from daedalus.
#
# The recovery lever for the one unit a remote session cannot restart without
# killing itself mid-command: every session lives in claude-remote-control's
# cgroup, and rebuilds deliberately never restart the unit either
# (platform/claude-rc.nix, restartIfChanged = false). Before this bridge the
# only out-of-band hand was the power bridge — a whole-box reboot for a
# single wedged service. This is that hand, sized to the fault.
#
# One verb, `restart`, and the unit it touches is hard-coded — nothing from
# the request reaches a command line. Unlike power.sh this agent OUTLIVES its
# action (it restarts a sibling unit, not the machine), so it writes a real
# terminal status: done when the unit reports active again, failed otherwise.

set -euo pipefail

REQ="$APPLY_DIR/claude-rc-request.json"
STATUS="$APPLY_DIR/claude-rc-status.json"
UNIT=claude-remote-control.service

ACTION=""

write_status() {
  write_json_atomic "$STATUS" <<EOF
{"id":"$REQ_ID","action":$(jq -Rn --arg a "$ACTION" '$a'),"state":"$1","detail":$(jq -Rn --arg d "${2-}" '$d'),"error":$(jq -Rn --arg e "${3-}" '$e'),"startedAt":"$STARTED_AT","finishedAt":"$(date -Is)"}
EOF
}

# Same split as host/ci.sh and power.sh: a request this agent correctly
# refuses exits 0 (the agent worked; the refusal is shown on the page that
# asked). Only the agent being unable to do its job exits 1 and leaves a
# failed unit for `systemctl --failed`.
reject() {
  write_status failed "" "$1"
  echo "claude-rc request rejected: $1" >&2
  exit 0
}

fail() {
  write_status failed "" "$1"
  echo "claude-rc agent failure: $1" >&2
  exit 1
}

[ -f "$REQ" ] || exit 0

REQ_ID="$(jq -r '.id // ""' "$REQ")"
[ -n "$REQ_ID" ] || exit 0
STARTED_AT="$(date -Is)"

# Replay guard, same as every bridge: the path unit re-fires on a
# daemon-reload replay, and without this a boot would re-run the last restart
# it saw — killing whatever sessions had just reconnected.
if [ -f "$STATUS" ] && [ "$(jq -r '.id // ""' "$STATUS")" = "$REQ_ID" ]; then
  exit 0
fi

ACTION="$(jq -r '.action // ""' "$REQ")"
[ "$ACTION" = "restart" ] || reject "unknown action '$ACTION'"

write_status running "restarting $UNIT" ""

# This SIGTERMs every connected session — that is the point. The button
# exists for a server that is down, wedged, or running a stale build, and
# sessions stay resumable from claude.ai for ~4 hours.
systemctl restart "$UNIT" || fail "systemctl restart $UNIT was refused"

# Type=simple: "started" only means exec'd. Give the process a moment to
# crash-loop before calling it recovered — Restart=always means a broken
# server FLAPS rather than fails, and `active` two seconds in would be a lie
# with nothing else on the page to catch it.
sleep 5
STATE="$(systemctl is-active "$UNIT" || true)"
[ "$STATE" = "active" ] || fail "$UNIT is '$STATE' after the restart — read its journal"

write_status "done" "server restarted; sessions reconnect from claude.ai" ""
