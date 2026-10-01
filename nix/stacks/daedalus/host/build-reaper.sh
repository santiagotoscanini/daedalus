# ExecStopPost of daedalus-build@<run>.service: the status file's undertaker,
# like the rebuilding verbs' (host/update-reaper.sh).
#
# Inlined by build-agent.nix after host/lib.sh and host/build-stages/states.sh;
# expects STATUS (build-status.json, in the root-only verbs directory),
# LOG_DIR, WORK_ROOT, BUILD_USER, BUILD_GROUP, OPERATOR_USER, OPERATOR_GROUP and
# SETPRIV.
# SERVICE_RESULT is systemd's.
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

status_json="$(cat -- "$STATUS" 2>/dev/null || true)"

# A run that ended before build.sh published anything — the egress fence
# check (ExecStartPre) refusing the start, or a crash before stage 0's first
# status — would otherwise leave its build queued until the engine's clock
# runs out, and the words with it. Its build id is the request's (the run
# file's payload, which 0-request.sh reads the same way); the status answers
# for it with why, so the scheduler folds it however long the app was away.
run_build="$(run_payload 2>/dev/null | jq -r 'if (.id | type) == "string" then .id else "" end' 2>/dev/null || true)"
published="$(jq -r '.id // ""' <<<"$status_json" 2>/dev/null || true)"
if [[ "$run_build" =~ $BUILD_ID_RE ]] && [ "$published" != "$run_build" ]; then
  run_field() {
    run_payload 2>/dev/null | jq -r --arg k "$1" 'if (.[$k] | type) == "string" then .[$k] else "" end' 2>/dev/null || true
  }
  app="$(run_field app)"
  sha="$(run_field sha)"
  jq -n --arg id "$run_build" --arg app "${app:0:128}" --arg sha "${sha:0:64}" \
    --arg result "${SERVICE_RESULT:-?}" --arg at "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)" '{
      version: 1, id: $id, app: $app, sha: $sha,
      state: "failed", phase: "starting", strategy: "auto",
      tip: null, digest: null, imageRef: null, sizeBytes: null,
      pinned: false, candidate: false, detected: null, checks: null,
      error: ("the build did not start: its unit ended (" + $result + ") before the build ran — most often the builder is unfenced: the egress fence check refuses a start while the firewall has not loaded the fence (systemctl status firewall); see journalctl -u '"'"'daedalus-build@*'"'"'"),
      timings: {}, updatedAt: $at
    }' | write_json_atomic "$STATUS"
  exit 0
fi

[ -n "$status_json" ] || exit 0
state="$(jq -r '.state // ""' <<<"$status_json" 2>/dev/null || true)"
build_active "$state" || exit 0 # host/build-stages/states.sh
id="$(jq -r '.id // ""' <<<"$status_json")"
[[ "$id" =~ $BUILD_ID_RE ]] || exit 0 # host/build-stages/states.sh

jq --arg at "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)" \
  '.state = "failed" | .error = "interrupted" | .updatedAt = $at' <<<"$status_json" |
  write_json_atomic "$STATUS"

# $LOG_DIR is root's alone; the name is a validated id.
if [ -f "$LOG_DIR/$id.log" ] && [ ! -L "$LOG_DIR/$id.log" ]; then
  printf '\n[interrupted: the build unit ended (%s) during %s]\n' "${SERVICE_RESULT:-?}" "$state" >>"$LOG_DIR/$id.log"
fi
"$SETPRIV" --reuid="$BUILD_USER" --regid="$BUILD_GROUP" --init-groups --inh-caps=-all \
  rm -rf -- "$WORK_ROOT/$id" || true
