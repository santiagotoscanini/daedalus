# ExecStopPost of daedalus-build.service: the status file's undertaker, after
# the image-update agent's reaper (verbs-lib.nix).
#
# Inlined by build-agent.nix after host/lib.sh; expects STATUS (the apply
# dir's build-status.json), LOG_DIR, WORK_ROOT, BUILD_USER, BUILD_GROUP,
# OPERATOR_USER, OPERATOR_GROUP and SETPRIV. SERVICE_RESULT is systemd's.
#
# The agent publishes its own terminal state, including on SIGTERM; this
# fires when it could not — SIGKILL after the stop timeout, an OOM kill, a
# crash in the trap — so a dead run reads `failed: interrupted` within seconds
# instead of after the engine's 90 s staleness clock. It also drops the run's
# work dir, which a skipped trap leaves behind.

# A clean result — including a SIGTERM stop, which the unit's
# SuccessExitStatus=143 counts as success — means the agent's own trap already
# published a terminal state. Otherwise the state check is the guard: a run
# that did publish one falls through the case below.
[ "${SERVICE_RESULT:-success}" = "success" ] && exit 0
[ -f "$STATUS" ] || exit 0

# Read once, as the operator and never through a link (host/lib.sh).
status_json="$(read_as_operator "$STATUS")" || exit 0
state="$(jq -r '.state // ""' <<<"$status_json" 2>/dev/null || true)"
case "$state" in
cloning | detecting | checking | building | publishing) ;;
*) exit 0 ;;
esac
id="$(jq -r '.id // ""' <<<"$status_json")"
[[ "$id" =~ ^[0-9a-fA-F-]{1,64}$ ]] || exit 0

jq --arg at "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)" \
  '.state = "failed" | .error = "interrupted" | .updatedAt = $at' <<<"$status_json" |
  write_json_atomic "$STATUS"

# $LOG_DIR is root's alone; the name is a validated id.
if [ -f "$LOG_DIR/$id.log" ] && [ ! -L "$LOG_DIR/$id.log" ]; then
  printf '\n[interrupted: the build unit ended (%s) during %s]\n' "${SERVICE_RESULT:-?}" "$state" >>"$LOG_DIR/$id.log"
fi
"$SETPRIV" --reuid="$BUILD_USER" --regid="$BUILD_GROUP" --init-groups --inh-caps=-all \
  rm -rf -- "$WORK_ROOT/$id" || true
