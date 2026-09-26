# host/build/3-detect.sh — stage 3 of the build (see host/build.sh).
#
# `railpack prepare` writes the build plan; the build-time placeholder values
# become secret files BuildKit mounts, never arguments or layers.
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
  for n in "${PLACEHOLDER_NAMES[@]}" "${RAILPACK_NAMES[@]}"; do
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

  mapfile -t SECRET_NAMES < <(jq -r '(.secrets // [])[]' "$CTL/plan/railpack-plan.json")
  for n in "${SECRET_NAMES[@]}"; do
    [[ "$n" =~ ^[A-Za-z_][A-Za-z0-9_]{0,127}$ ]] || fail "the Railpack plan declares a secret name this builder will not pass: ${n:0:80}"
  done
  # BuildKit fails on a missing secret only when a step runs, and a fully
  # cached step does not (spike B11): this is the guard that holds.
  MISSING=()
  for n in "${SECRET_NAMES[@]}"; do
    in_list "$n" "${PLACEHOLDER_NAMES[*]}" || MISSING+=("$n")
  done
  if [ "${#MISSING[@]}" -gt 0 ]; then
    fail "the Railpack plan needs build secret(s) ${MISSING[*]}, but the app has no build placeholder for them (daedalus: the app's build settings)"
  fi
else
  SECRET_NAMES=("${PLACEHOLDER_NAMES[@]}")
fi

# The secrets, as files BuildKit's client reads (root-owned, build-user
# readable), and the Railpack cache-invalidation hash over the sorted
# NAME=value lines — computed here, since the CLI's own iterates a Go map.
SECRET_ARGS=()
SECRETS_HASH=""
HASH_ARGS=()
: >"$P/secrets-hash-input"
i=0
for n in "${SECRET_NAMES[@]}"; do
  i=$((i + 1))
  jq -j --arg n "$n" '.buildEnv.placeholders[$n]' <<<"$REQ_JSON" >"$CTL/secrets/$i"
  chgrp "$BUILD_GROUP" "$CTL/secrets/$i"
  chmod 0440 "$CTL/secrets/$i"
  SECRET_ARGS+=(--secret "id=$n,src=$CTL/secrets/$i")
  {
    printf '%s=' "$n"
    cat "$CTL/secrets/$i"
    printf '\n'
  } >>"$P/secrets-hash-input"
done
if [ "$RESOLVED" = railpack ] && [ "$i" -gt 0 ]; then
  SECRETS_HASH="$(LC_ALL=C sort "$P/secrets-hash-input" | sha256sum | cut -d' ' -f1)"
  HASH_ARGS=(--opt "build-arg:secrets-hash=$SECRETS_HASH")
fi
