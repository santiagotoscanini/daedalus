# host/build-stages/3-detect.sh — stage 3 of the build (see host/build.sh).
#
# `railpack prepare` writes the build plan. A plan that asks for a build secret
# is refused: the box passes none.
#
# ── 3. detect (railpack) ──────────────────────────────────────────────────

# `detected` for the status, size-capped: Railpack's info file and the plan,
# trimmed step by step (step commands and assets first — the runtime apt step
# stays, build-detect reads it — then everything but deploy) until it fits.
publish_detected() {
  local plan="$1" trim
  local steps='.plan.steps |= (if type == "array" then map(if .name == "packages:apt:runtime" then . else del(.commands, .assets) end) else . end)'
  jq -cn --slurpfile info "$P/info.json" --slurpfile plan "$plan" '{info: $info[0], plan: $plan[0]}' >"$P/detected.json"
  for trim in '.' "$steps" "$steps | .plan |= (if type == \"object\" then {deploy, secrets, steps} else . end)" \
    '.plan |= (if type == "object" then {deploy} else . end) | .info.logs |= (if type == "array" then .[-20:] else . end)'; do
    jq -c "$trim" "$P/detected.json" >"$P/detected.try.json"
    if [ "$(stat -c %s "$P/detected.try.json")" -le "$MAX_DETECTED_BYTES" ]; then
      status_set '.detected = $d[0]' --slurpfile d "$P/detected.try.json"
      return 0
    fi
  done
  say "Railpack's detection is over $MAX_DETECTED_BYTES bytes even trimmed; the status carries none"
}

if [ "$RESOLVED" = railpack ]; then
  enter detecting "railpack prepare"
  ENV_ARGS=()
  for n in "${RAILPACK_NAMES[@]}"; do
    ENV_ARGS+=(--env "$n")
  done
  # This app's mise cache, for prepare alone ("Railpack's mise cache, one per
  # app" above); unmounted once the loop is done, or by on_exit.
  mount_mise_cache
  attempt=1
  while :; do
    as_build rm -f -- "$WORK/plan/railpack-plan.json" "$WORK/plan/railpack-info.json"
    rc=0
    timed_as_build "$DETECT_LIMIT" with-env railpack prepare "$SRC" \
      --plan-out "$WORK/plan/railpack-plan.json" --info-out "$WORK/plan/railpack-info.json" \
      --error-missing-start "${ENV_ARGS[@]}" || rc=$?
    reap_build_processes
    [ "$rc" -ne 0 ] || break
    # 75 is Railpack's own "transient" (a mise download); a GitHub 403 or rate
    # limit in its output is the same thing wearing exit 1.
    if [ "$attempt" = 1 ] && { [ "$rc" = 75 ] || { [ "$rc" = 1 ] && grep -qiE 'rate[ -]?limit|403' "$P/scan"; }; }; then
      say "railpack prepare exited $rc, which looks transient; retrying once"
      attempt=2
      continue
    fi
    # The info file is written on a failed detection too, and says why.
    why=""
    if read_work_json "$WORK/plan/railpack-info.json" "$P/info.json"; then
      printf 'null' >"$P/no-plan.json"
      publish_detected "$P/no-plan.json"
      why="$(jq -r '[.logs[]? | select(((.Level // .level // "") | ascii_downcase) == "error") | (.Msg // .msg // "")] | last // ""' "$P/info.json")"
    fi
    if [ "$rc" = 124 ] || [ "$rc" = 137 ]; then
      fail "detecting timed out after $DETECT_LIMIT"
    fi
    fail "Railpack could not work out how to build this app (exit $rc)${why:+: $why}"
  done
  unmount_mise_cache || agent_fail "could not unmount $APP's mise cache from $MISE_MOUNT; refusing to go on with it in place"

  read_work_json "$WORK/plan/railpack-info.json" "$P/info.json" || fail "railpack prepare wrote no readable info file"
  read_work_json "$WORK/plan/railpack-plan.json" "$P/plan.raw.json" || fail "railpack prepare wrote no readable plan"
  # Every --env name became a required plan secret, the RAILPACK_* knobs
  # included; the frontend would demand those too (spike B11).
  jq 'if (.secrets | type) == "array" then .secrets |= map(select(type == "string" and (startswith("RAILPACK_") | not))) else . end' \
    "$P/plan.raw.json" >"$CTL/plan/railpack-plan.json"
  chmod 0644 "$CTL/plan/railpack-plan.json"
  publish_detected "$CTL/plan/railpack-plan.json"
  PROVIDER="$(jq -r '.detectedProviders[0] // "" | strings' "$P/info.json")"
  say "detected: ${PROVIDER:-no provider}"

  # What is left is the repository's own `secrets`. The box passes none, and
  # BuildKit fails on a missing secret only when a step runs, which a fully
  # cached step does not (spike B11): so the plan is refused here.
  SECRET_LIST="$(jq -r '[(.secrets // [])[]? | tostring | .[0:64]] | join(", ") | .[0:300]' "$CTL/plan/railpack-plan.json")"
  if [ -n "$SECRET_LIST" ]; then
    fail "the Railpack plan declares build secret(s) $SECRET_LIST; the box passes none. Declare dummy build-time values in the repo's railpack.json instead."
  fi
fi
