# host/build-stages/0-request.sh — stage 0 of the build (see host/build.sh).
#
# Read and validate the request; make the scratch dirs, start the log and the
# heartbeat; check the egress fence and that the daemon answers.
#
# ── 0. the request ────────────────────────────────────────────────────────

# The run file's payload (host/lib.sh take_request): the engine's request, as
# the scheduler serialised it. The container chose these bytes, so every
# field is checked below exactly as if it had written them itself.
REQ_JSON="$(take_request | jq -r 'if (.payload | type) == "string" then .payload else "" end' | head -c "$((MAX_REQUEST_BYTES + 1))")" || true
if [ -z "$REQ_JSON" ]; then
  echo "the run carries no build request" >&2
  exit 1
fi
if [ "${#REQ_JSON}" -gt "$MAX_REQUEST_BYTES" ]; then
  echo "refusing the build request: over $MAX_REQUEST_BYTES bytes" >&2
  exit 1
fi

# The id names the log file and is what the status answers; without a usable
# one there is nothing to answer, so this is the one refusal that only mails.
BUILD_ID="$(jq -r 'if type == "object" and (.id | type) == "string" then .id else "" end' <<<"$REQ_JSON" 2>/dev/null || true)"
if ! [[ "$BUILD_ID" =~ $BUILD_ID_RE ]]; then
  echo "refusing the build request: it carries no usable build id" >&2
  exit 1
fi

gh_init
trap on_exit EXIT
trap 'INTERRUPTED=1; exit 143' TERM INT HUP

CTL="$(mktemp -d /tmp/daedalus-build.XXXXXXXXXX)"
chmod 0755 "$CTL"
P="$CTL/private"
install -d -m 0700 "$P"
install -d -m 0755 "$CTL/plan" "$CTL/checks" "$CTL/docker-none"
install -d -m 0750 -g "$BUILD_GROUP" "$CTL/git"

# A string field of the request, or "" — for the status, before validation.
raw_field() {
  jq -r --arg k "$1" 'if (.[$k] | type) == "string" then .[$k] else "" end' <<<"$REQ_JSON" 2>/dev/null || true
}
APP="$(raw_field app)"
SHA="$(raw_field sha)"
STRATEGY="$(raw_field strategy)"
PUBLISH="$(raw_field publish)"
case "$STRATEGY" in
auto | railpack | dockerfile) STATUS_STRATEGY="$STRATEGY" ;;
*) STATUS_STRATEGY=auto ;;
esac

jq -n --arg id "$BUILD_ID" --arg app "${APP:0:128}" --arg sha "${SHA:0:64}" \
  --arg strategy "$STATUS_STRATEGY" --arg at "$(now_iso)" '{
    version: 1, id: $id, app: $app, sha: $sha,
    state: "cloning", phase: "validating the request", strategy: $strategy,
    tip: null, digest: null, imageRef: null, sizeBytes: null,
    pinned: false, candidate: false, detected: null, checks: null, error: null,
    timings: {}, updatedAt: $at
  }' >"$P/status.json"
now_ms >"$P/t0"
start_log
STATUS_READY=1
write_json_atomic "$STATUS" <"$P/status.json"
start_heartbeat

INVALID="$(jq -r '
  def str($k; $max): (.[$k] | type) == "string" and (.[$k] | length) <= $max;
  if type != "object" then "the request is not a JSON object"
  elif .version != 1 then "unsupported request version"
  elif (str("app"; 63) | not) then "app must be a string of at most 63 characters"
  elif (str("sha"; 40) | not) then "sha must be a string of 40 characters"
  elif (.repoId | type) != "number" then "repoId must be a number"
  elif (str("strategy"; 16) | not) then "strategy must be a string"
  elif (str("publish"; 16) | not) then "publish must be a string"
  elif ((.requestedBy // "") | type) != "string" or ((.requestedBy // "") | length) > 32 then "requestedBy must be a short string"
  elif ((.at // "") | type) != "string" or ((.at // "") | length) > 64 then "at must be a short string"
  else "" end' <<<"$REQ_JSON" 2>/dev/null || echo "the request is not valid JSON")"
[ -z "$INVALID" ] || fail "invalid build request: $INVALID"

REPO_ID="$(jq -r '.repoId | tostring' <<<"$REQ_JSON")"
REQUESTED_BY="$(raw_field requestedBy)"

[[ "$APP" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] || fail "invalid build request: app is not an app name"
# Cache-mount ids are global to the BuildKit daemon, and this box namespaces
# them `<app>-…`: Railpack's frontend prefixes every plan cache with the
# cache-key (`<cache-key>-<name>`, railpack buildkit/build_llb/cache_store.go),
# the repo Dockerfile scan below demands it, Dockerfile.checks uses it. A
# hyphen in the app name would let app `foo` with cache `bar-x` meet app
# `foo-bar` with cache `x`.
if [[ "$APP" == *-* ]]; then
  fail "request refused: app names containing '-' are not built on this box (cache mount ids are namespaced as <app>-…)"
fi
# Which apps this builds (build.sh, "which apps it builds"): one the committed
# registry names, from the registry, and not one the host declares by hand.
ENTRY="$(registry_entry "$APP")"
[ -n "$ENTRY" ] || fail "$APP is not in the committed app registry (site/apps.json), so this box does not build it"
[ "$(jq -r '.sourceMode // "registry"' <<<"$ENTRY")" = registry ] ||
  fail "$APP's source is not the registry, so this box does not build it"
! in_list "$APP" "$NIX_APPS" || fail "$APP is declared by hand on this host, not in the registry, so this box does not build it"
# Still waiting for its first image: nothing exists for it yet but this
# build (6-done.sh).
AWAITING="$(jq -r 'if .awaitingImage == true then "yes" else "no" end' <<<"$ENTRY")"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || fail "invalid build request: sha is not a 40-hex commit sha"
[[ "$REPO_ID" =~ ^[1-9][0-9]{0,15}$ ]] || fail "invalid build request: repoId is not a positive integer"
case "$STRATEGY" in
auto | railpack | dockerfile) ;;
*) fail "invalid build request: strategy must be auto, railpack or dockerfile" ;;
esac
case "$PUBLISH" in
live | candidate) ;;
*) fail "invalid build request: publish must be live or candidate" ;;
esac
[[ "$REQUESTED_BY" =~ ^[a-z]{0,16}$ ]] || REQUESTED_BY="?"

# The Railpack switches (RAILPACK_KNOBS above): the only thing buildEnv carries.
INVALID="$(jq -r --argjson knobs "$RAILPACK_KNOBS" '
  (.buildEnv // {}) as $b
  | if ($b | type) != "object" then "buildEnv must be an object"
    elif ($b | keys - ["railpack"]) != [] then "buildEnv carries only railpack, not " + ($b | keys - ["railpack"] | join(", "))
    else ($b.railpack // {}) as $rp
    | def bad_value: (type != "string") or length > 512 or (explode | any(. == 0 or . == 10 or . == 13));
      def unknown_knob: . as $k | $knobs | has($k) | not;
      def bad_knob_value: .key as $k | .value | test($knobs[$k]) | not;
    if ($rp | type) != "object" then "buildEnv.railpack must be an object"
    elif ($rp | length) > 40 then "buildEnv.railpack carries more than 40 names"
    elif ([$rp | to_entries[] | .value | bad_value] | any) then "every buildEnv value must be a single-line string of at most 512 characters"
    elif ([$rp | keys[] | unknown_knob] | any) then "not a Railpack switch this builder passes on: " + ([$rp | keys[] | select(unknown_knob)] | join(", ")) + " (it passes on " + ($knobs | keys_unsorted | join(", ")) + ")"
    elif ([$rp | to_entries[] | bad_knob_value] | any) then "Railpack switch values this builder will not pass on (the app build settings say what each takes): " + ([$rp | to_entries[] | select(bad_knob_value) | .key] | join(", "))
    else "" end
    end' <<<"$REQ_JSON")"
[ -z "$INVALID" ] || fail "invalid build request: ${INVALID:0:400}"

# NAME=value lines for build_env's with-env mode (root 0700 $P).
jq -r '(.buildEnv.railpack // {}) | to_entries[] | "\(.key)=\(.value)"' <<<"$REQ_JSON" >"$P/build-env"
mapfile -t RAILPACK_NAMES < <(jq -r '(.buildEnv.railpack // {}) | keys[]' <<<"$REQ_JSON")

say "build $BUILD_ID: $APP at $SHA (strategy $STRATEGY, publish $PUBLISH, requested by $REQUESTED_BY)"

if [ ! -d "$WORK_ROOT" ]; then
  agent_fail "the work directory $WORK_ROOT is missing: is $BUILD_ROOT mounted?"
fi
# Nothing has run as the build user yet in this unit's fresh /tmp.
make_mise_mountpoint

# Fail closed on the egress fence, per build. The unit runs the same check
# before starting, but a firewall reload that failed since then removes the
# fence while buildkitd keeps running, and what is about to run is a
# repository's code. $FENCE_CHECK is builder.nix's (fleet.builder.fenceCheck):
# every fenced owner — the daemon's buildkit, the build user — v4 and v6.
if ! "$FENCE_CHECK" >"$P/fence.out" 2>&1; then
  fail "builder unfenced: the egress fence is not in place; refusing to run repository code until the firewall is back (systemctl status firewall): $(head -c 300 "$P/fence.out" | tr '\n' ' ')"
fi

say "checking the builder at $BUILDKIT_ADDR"
if ! as_build "$TIMEOUT_BIN" 20s buildctl --addr "$BUILDKIT_ADDR" debug workers >/dev/null 2>"$P/probe.err"; then
  fail "builder unavailable: buildkitd did not answer ($(head -c 300 "$P/probe.err" | tr '\n' ' '))"
fi
