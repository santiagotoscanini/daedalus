# ExecStartPre gate for daedalus-build.service: the egress fence, checked
# before anything starts — with an answer for the request that triggered it.
#
# Inlined by build-agent.nix after host/lib.sh; expects FENCE_CHECK (builder.nix's
# fleet.builder.fenceCheck), APPLY_DIR, OPERATOR_USER, OPERATOR_GROUP and
# SETPRIV. Runs as root, outside the unit's sandboxing (`+`).
#
# A bare `fenceCheck` in ExecStartPre fails the unit before build.sh runs, so
# nothing answers the request and the engine's staleness clock reports the
# build "interrupted" 90 s later — the one verdict that says nothing about the
# cause. This publishes `failed: builder unfenced` for the pending request
# instead, then still fails: the unit goes red and monitoredJobs mails.
#
# The request is handled exactly as build.sh handles it: a symlink is refused,
# the file is read once as the operator and never through a link, the id must
# match the engine's BUILD_ID_RE, and an id the status already answers is
# never answered again.

set -euo pipefail

REQ="$APPLY_DIR/build-request.json"
STATUS="$APPLY_DIR/build-status.json"
MAX_REQUEST_BYTES=65536

fenced=0
if out="$("$FENCE_CHECK" 2>&1)"; then
  fenced=1
fi

if [ "$fenced" = 0 ]; then
  why="$(printf '%s' "$out" | tr '\n' ' ' | head -c 300)"
  echo "egress fence check failed: $why" >&2

  req_json=""
  if [ -L "$REQ" ]; then
    echo "not answering $REQ: it is a symlink" >&2
  elif [ -e "$REQ" ]; then
    req_json="$(read_request "$REQ" | head -c "$((MAX_REQUEST_BYTES + 1))")" || req_json=""
    if [ "${#req_json}" -gt "$MAX_REQUEST_BYTES" ]; then
      req_json=""
    fi
  fi

  id=""
  if [ -n "$req_json" ]; then
    id="$(jq -r 'if type == "object" and (.id | type) == "string" then .id else "" end' <<<"$req_json" 2>/dev/null || true)"
  fi
  if [[ "$id" =~ ^[0-9a-fA-F-]{1,64}$ ]] && [ "$(published_id "$STATUS")" != "$id" ]; then
    field() {
      jq -r --arg k "$1" 'if (.[$k] | type) == "string" then .[$k][0:128] else "" end' <<<"$req_json" 2>/dev/null || true
    }
    if jq -n --arg id "$id" --arg app "$(field app)" --arg sha "$(field sha)" \
      --arg error "builder unfenced: the egress fence is not in place, so the build did not start (systemctl status firewall): $why" \
      --arg at "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)" '{
        version: 1, id: $id, app: $app, sha: $sha,
        state: "failed", phase: "cloning", strategy: "auto",
        tip: null, digest: null, imageRef: null, sizeBytes: null,
        pinned: false, candidate: false, detected: null, checks: null,
        error: $error, timings: {}, updatedAt: $at
      }' | write_json_atomic "$STATUS"; then
      echo "answered build $id: builder unfenced" >&2
    else
      echo "could not publish $STATUS" >&2
    fi
  fi
fi

# The unit starts only behind the fence.
[ "$fenced" = 1 ]
