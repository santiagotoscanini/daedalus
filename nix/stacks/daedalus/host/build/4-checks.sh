# host/build/4-checks.sh — stage 4 of the build (see host/build.sh).
#
# Run the repository's own ci / lint / typecheck / test scripts inside
# BuildKit, on the image's own toolchain, exporting nothing. A failure stops
# the build before anything is published.
#
# ── 4. checks ─────────────────────────────────────────────────────────────

# The two facts this stage worked out and used to throw away. The runner is
# the one every check command is prefixed with; the hash is a sha256 over
# NAME=value lines, so it is not itself a secret — but the status carries only
# its first 12 characters anyway: enough to see at a glance that a rebuild's
# cache key moved, far too little to confirm a guessed value against.
status_set '.build.runner = $r' --arg r "$RUNNER"
if [ -n "$SECRETS_HASH" ]; then
  status_set '.build.secretsHash = $h' --arg h "${SECRETS_HASH:0:12}"
fi

if [ "$RESOLVED" = railpack ]; then
  [ "$PROVIDER" = node ] && NODE=1 || NODE=0
else
  has package.json && NODE=1 || NODE=0
fi

CHECK_NAMES=()
SCRIPTS_JSON='[]'
if [ "$NODE" = 1 ]; then
  if ! read_work_json "$SRC/package.json" "$P/package.json"; then
    fail "package.json is not a readable JSON object (or is over 16 MiB); refusing to build without checks"
  fi
  # The contract (v1): a `ci` script if the repo has one, else the known
  # scripts that exist, in this order — generate-routes first, because
  # src/routeTree.gen.ts is gitignored and lint is type-aware.
  SCRIPTS_JSON="$(jq -c '
    (if (.scripts | type) == "object" then .scripts else {} end) as $s
    | if ($s.ci | type) == "string" then ["ci"]
      else ["generate-routes", "format:check", "lint", "typecheck", "test"] | map(select(($s[.] | type) == "string"))
      end' "$P/package.json")"
  mapfile -t CHECK_NAMES < <(jq -r '.[]' <<<"$SCRIPTS_JSON")
fi

# Which check failed, from the scanned output: the Dockerfile target echoes
# `check failed: <name>`; a Railpack step is the vertex named `check: <name>`
# whose number carries the first ERROR.
failed_check() {
  local name vid
  name="$({ grep -oE 'check failed: [A-Za-z0-9:_-]+' "$P/scan" || true; } | tail -n 1 | sed 's/^check failed: //')"
  if [ -z "$name" ]; then
    vid="$({ grep -oE '^#[0-9]+ ERROR' "$P/scan" || true; } | head -n 1 | cut -d' ' -f1)"
    if [ -n "$vid" ]; then
      name="$({ grep -E "^$vid( \\[[^]]*\\])? check: " "$P/scan" || true; } | head -n 1 | sed -E 's/^.*check: ([A-Za-z0-9:_-]+).*$/\1/')"
    fi
  fi
  if [ -n "$name" ] && in_list "$name" "${CHECK_NAMES[*]}"; then
    printf '%s' "$name"
  fi
}

enter checking "running checks"
if [ "$NODE" = 0 ]; then
  say "no checks declared: checks run for Node apps only in v1 (provider: ${PROVIDER:-none})"
  status_set '.checks = {ran: [], failed: null}'
elif [ "${#CHECK_NAMES[@]}" -eq 0 ]; then
  say "no checks declared: package.json has no ci, generate-routes, format:check, lint, typecheck or test script"
  status_set '.checks = {ran: [], failed: null}'
elif [ "$RESOLVED" = dockerfile ] && [ "$RUNNER" != pnpm ]; then
  say "no checks declared: the Dockerfile checks target supports pnpm repositories only in v1 (this one uses $RUNNER)"
  status_set '.checks = {ran: [], failed: null}'
else
  say "checks: ${CHECK_NAMES[*]}"
  status_set '.phase = $p' --arg p "running ${CHECK_NAMES[*]}"
  rc=0
  if [ "$RESOLVED" = railpack ]; then
    # A copy of the plan with one more step on top of the build step and
    # `deploy` replaced, so the solve runs exactly the image's toolchain and
    # exports nothing. One argv command per script: plan commands are not
    # shell-interpreted. `secrets: ["*"]`: a partial list makes the frontend
    # pull a floating alpine.
    BASE_STEP="$(jq -r '[.steps[]?.name | strings] | if any(.[]; . == "build") then "build" else (last // "") end' "$CTL/plan/railpack-plan.json")"
    [ -n "$BASE_STEP" ] || fail "the Railpack plan has no step to run checks on"
    jq --argjson scripts "$SCRIPTS_JSON" --arg runner "$RUNNER" --arg base "$BASE_STEP" '
      .steps += [{ name: "checks", inputs: [{ step: $base }],
        commands: ($scripts | map({ cmd: ($runner + " run " + .), customName: ("check: " + .) })),
        secrets: ["*"] }]
      | .deploy = { base: { step: "checks" } }' \
      "$CTL/plan/railpack-plan.json" >"$CTL/checks/railpack-plan.json"
    chmod 0644 "$CTL/checks/railpack-plan.json"
    timed_as_build "$CHECKS_LIMIT" plain buildctl --addr "$BUILDKIT_ADDR" build --progress=plain \
      --frontend gateway.v0 --opt "source=$RAILPACK_FRONTEND" \
      --local "context=$SRC" --local "dockerfile=$CTL/checks" \
      --opt "build-arg:cache-key=$APP" "${HASH_ARGS[@]}" "${SECRET_ARGS[@]}" \
      --import-cache "type=registry,ref=$CACHE_REF" || rc=$?
  else
    cp -- "$CHECKS_DOCKERFILE" "$CTL/checks/Dockerfile"
    chmod 0644 "$CTL/checks/Dockerfile"
    jq -r '(.buildEnv.placeholders // {}) | to_entries[] | @sh "export \(.key)=\(.value)"' \
      <<<"$REQ_JSON" >"$CTL/secrets/check-env"
    chgrp "$BUILD_GROUP" "$CTL/secrets/check-env"
    chmod 0440 "$CTL/secrets/check-env"
    timed_as_build "$CHECKS_LIMIT" plain buildctl --addr "$BUILDKIT_ADDR" build --progress=plain \
      --frontend dockerfile.v0 --local "context=$SRC" --local "dockerfile=$CTL/checks" \
      --opt target=checks --opt "build-arg:NODE_IMAGE=$NODE_IMAGE" --opt "build-arg:APP=$APP" \
      --opt "build-arg:REGISTRY_URL=$NPM_REGISTRY_URL" --opt "build-arg:CHECKS=${CHECK_NAMES[*]}" \
      "${NPM_MIRROR_ARGS[@]}" \
      --secret "id=daedalus-check-env,src=$CTL/secrets/check-env" || rc=$?
  fi
  if [ "$rc" -ne 0 ]; then
    FAILED_CHECK="$(failed_check)"
    if [ -n "$FAILED_CHECK" ]; then
      status_set '.checks = {ran: ($all[: ($all | index($f)) + 1]), failed: $f}' \
        --argjson all "$SCRIPTS_JSON" --arg f "$FAILED_CHECK"
      fail "check failed: $FAILED_CHECK"
    fi
    status_set '.checks = {ran: [], failed: null}'
    systemctl is-active --quiet buildkitd.service || fail "builder unavailable: buildkitd stopped during the checks"
    fail "$(stage_error checks "$rc" "$CHECKS_LIMIT")"
  fi
  status_set '.checks = {ran: $ran, failed: null}' --argjson ran "$SCRIPTS_JSON"
fi
