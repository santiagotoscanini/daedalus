# Restart the box, on request from daedalus.
#
# The fourth file-drop bridge, and the narrowest: it accepts exactly one verb.
# There is deliberately no poweroff, halt or shutdown branch anywhere in this
# file — the operator's rule is that this machine must never be turned OFF from
# a browser, because the way back on is physical and the browser is usually not
# in the house. A verb that has no branch is not reachable by a mistake in the
# app, and not reachable by a compromised container either: the trust boundary
# is "can write into $APPLY_DIR", and everything past it is this case list.
#
# It is also the only bridge that never writes a terminal status. The process
# dies with the machine, so `running` is the last thing that will ever be on
# disk for a request; the app stops reading this file at that point and watches
# /api/healthz for the box coming back instead.

set -euo pipefail

REQ="$APPLY_DIR/power-request.json"
STATUS="$APPLY_DIR/power-status.json"

ACTION=""

write_status() {
  write_json_atomic "$STATUS" <<EOF
{"id":"$REQ_ID","action":$(jq -Rn --arg a "$ACTION" '$a'),"state":"$1","detail":$(jq -Rn --arg d "${2-}" '$d'),"error":$(jq -Rn --arg e "${3-}" '$e'),"startedAt":"$STARTED_AT","finishedAt":"$(date -Is)"}
EOF
}

# Same split as host/ci.sh, for the same reason. A request this agent correctly
# refuses — a verb it does not have, a rebuild in flight — is reported in the UI
# and exits 0, because the agent worked. Only the agent being unable to do its
# job at all exits 1 and leaves a failed unit for `systemctl --failed` and the
# Grafana alert. Otherwise every refused restart leaves a permanently failed
# unit, and the failed-units alert becomes something you scroll past.
reject() {
  write_status failed "" "$1"
  echo "power request rejected: $1" >&2
  exit 0
}

fail() {
  write_status failed "" "$1"
  echo "power agent failure: $1" >&2
  exit 1
}

[ -f "$REQ" ] || exit 0

REQ_ID="$(jq -r '.id // ""' "$REQ")"
[ -n "$REQ_ID" ] || exit 0
STARTED_AT="$(date -Is)"

# ⚠ The single most important line in this file. The path unit re-fires on a
# daemon-reload replay at boot, and this agent's action is a reboot: without the
# guard the request that rebooted the box would be replayed on the way back up,
# and the box would spend the rest of its life rebooting. The other three
# bridges lose a redeploy or a workflow run to a missing replay guard — this one
# loses the machine.
if [ -f "$STATUS" ] && [ "$(jq -r '.id // ""' "$STATUS")" = "$REQ_ID" ]; then
  exit 0
fi

ACTION="$(jq -r '.action // ""' "$REQ")"

# One verb. Not a case with the dangerous branches commented out — they are
# absent, which is a stronger statement and the one the operator asked for.
[ "$ACTION" = "reboot" ] || reject "unknown action '$ACTION'"

# A reboot in the middle of a `nixos-rebuild switch` is the one way this button
# can leave the box worse than it found it: the bootloader entry, the store
# paths and the activation script land at different moments, so a switch cut in
# half can boot a generation that was never finished being installed. All three
# checks below are the same question asked of the three things that rebuild this
# system.
if systemctl is-active --quiet daedalus-apply.service; then
  reject "an apply is running — rebooting mid-rebuild would leave a half-applied generation. Wait for it to finish."
fi

if pgrep -f nixos-rebuild >/dev/null 2>&1; then
  reject "a nixos-rebuild is running on this box — rebooting mid-switch would leave a half-applied generation. Wait for it to finish."
fi

# fleet.rebuildLock, taken NON-blocking: held means somebody is rebuilding
# (flake-autoupgrade, an apply past its waiting phase, or a human who took it),
# and this is a request from someone watching a page — it should be refused
# with a reason, not queued behind twenty minutes of silence.
#
# Deliberately never released. fd 9 stays open until this process dies with the
# machine, so no rebuild can start in the window between passing this check and
# the reboot actually happening.
exec 9>"$LOCKFILE"
if ! flock -n 9; then
  reject "another rebuild holds $LOCKFILE (flake-autoupgrade, or a manual nixos-rebuild) — try again when it finishes"
fi

# The last thing this bridge ever writes, and the reason it is written BEFORE
# the action rather than after it: there is no "after" in this process. sync so
# the rename is on disk even if the shutdown that follows turns out not to be a
# clean one — a status the app never sees is a restart that looks like a button
# that did nothing.
write_status running "rebooting" ""
sync

# --no-block: this agent is itself a unit, and the shutdown transaction it is
# asking for includes stopping this unit. Waiting for that job to complete
# would be waiting for its own SIGTERM.
systemctl --no-block reboot || fail "systemctl reboot was refused"
