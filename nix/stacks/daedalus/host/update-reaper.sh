# ExecStopPost of the rebuilding verbs — daedalus-image-update,
# -engine-update, -version-update and -claude-code-update: the status file's
# undertaker, one script for all four.
#
# Inlined by mkAgent after host/lib.sh; expects STATUS (the verb's status
# file), NEXT_STEPS (what to check, as one sentence without its full stop),
# OPERATOR_USER, OPERATOR_GROUP and SETPRIV. SERVICE_RESULT is systemd's.
#
# The agent writes its own terminal state, so this only ever fires when it did
# not get to: killed, out of memory, or dead on a line nobody tested. Without
# it that run stays `running` in the status file until the app's staleness
# clock expires — and because the flow refuses to start while one is running,
# a single crash disables that verb's button for the whole of that window
# (an hour for a queued image batch). Observed: a `command not found` in the
# image updater's resolve loop.
#
# Reads the file rather than synthesising one: the id, the phase it died in
# and the targets are the only things that make the failure readable, and
# they are all already there. A status that names a pre-update ZFS snapshot
# (version-update's) gets it in the message, since the rollback it was taken
# for may not have run.

# A clean exit is the overwhelmingly common case and has nothing to do here.
[ "${SERVICE_RESULT:-success}" = "success" ] && exit 0
[ -f "$STATUS" ] || exit 0

# Read once, as the operator and never through a link — the status sits in
# the container's directory (host/lib.sh) — and rewritten from that copy.
# Unreadable means there is nothing trustworthy to mark failed.
status_json="$(read_as_operator "$STATUS")" || exit 0
[ "$(jq -r '.state // ""' <<<"$status_json")" = "running" ] || exit 0

jq --arg r "${SERVICE_RESULT:-unknown}" --arg next "$NEXT_STEPS" '
  .state = "failed"
  | .finishedAt = (now | todate)
  | .error = "the host agent died during \"" + (.phase // "?") + "\" (" + $r
      + ") without reporting a result. " + $next
      + (if (.snapshot // "") != "" then ", and whether the container still runs — the pre-update snapshot is " + .snapshot else "" end)
      + "."
' <<<"$status_json" | write_json_atomic "$STATUS"
