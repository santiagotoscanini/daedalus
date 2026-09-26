# host/build/5-publish.sh — stage 5 of the build (see host/build.sh).
#
# The real build: BuildKit builds the image and pushes it to the registry in
# one call, the only one that holds the push credential. The digest, size,
# tags and cache facts go into the status.
#
# ── 5. build and publish ──────────────────────────────────────────────────

SOURCE_URL="https://github.com/$OWNER/$APP"
if [ "$PUBLISH" = live ]; then
  IMAGE_REF="$REGISTRY/$APP:sha-$SHA"
  TAGS="$IMAGE_REF,$REGISTRY/$APP:latest"
else
  IMAGE_REF="$REGISTRY/$APP:candidate-$SHA"
  TAGS="$IMAGE_REF"
fi

if [ "$RESOLVED" = railpack ]; then
  FRONTEND_ARGS=(
    --frontend gateway.v0 --opt "source=$RAILPACK_FRONTEND"
    --local "context=$SRC" --local "dockerfile=$CTL/plan"
    # The build-arg: prefix is required; a bare cache-key is silently ignored.
    --opt "build-arg:cache-key=$APP" "${HASH_ARGS[@]}"
  )
else
  FRONTEND_ARGS=(
    --frontend dockerfile.v0
    --local "context=$SRC" --local "dockerfile=$SRC"
    "${NPM_MIRROR_ARGS[@]}"
    --opt "label:org.opencontainers.image.revision=$SHA"
    --opt "label:org.opencontainers.image.source=$SOURCE_URL"
    --opt "label:org.opencontainers.image.title=$APP"
    --opt "label:org.opencontainers.image.created=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  )
fi

enter building "building the image"
rm -f -- "$P/pushing" "$P/timedout"

# The push credential, for this one call only (header: the registry
# credential). Nothing of the build user's may still run when it appears; the
# rendered original is root's, and is read here never through a link.
reap_build_processes
rm -rf -- "$CTL/docker"
install -d -m 0700 -o "$BUILD_USER" -g "$BUILD_GROUP" "$CTL/docker"
if ! dd if="$DOCKER_CONFIG_DIR/config.json" iflag=nofollow,nonblock bs=65536 count=1 status=none 2>/dev/null |
  install -m 0400 -o "$BUILD_USER" -g "$BUILD_GROUP" /dev/stdin "$CTL/docker/config.json" ||
  [ ! -s "$CTL/docker/config.json" ]; then
  rm -rf -- "$CTL/docker"
  agent_fail "the registry push credential is not readable at $DOCKER_CONFIG_DIR/config.json (is daedalus-build-dockerconfig healthy?)"
fi

with_lock _set_deadline "$BUILD_SECS" building
BUILD_STARTED="$(date +%s)"
rc=0
timed_as_build "$((BUILD_SECS + PUBLISH_SECS))s" push buildctl --addr "$BUILDKIT_ADDR" build --progress=plain \
  "${FRONTEND_ARGS[@]}" "${SECRET_ARGS[@]}" \
  --output "type=image,\"name=$TAGS\",push=true,oci-mediatypes=true,annotation.org.opencontainers.image.revision=$SHA,annotation.org.opencontainers.image.source=$SOURCE_URL" \
  --export-cache "type=registry,ref=$CACHE_REF,mode=max,image-manifest=true,oci-mediatypes=true,ignore-error=true" \
  --import-cache "type=registry,ref=$CACHE_REF" \
  --metadata-file "$WORK/out/metadata.json" || rc=$?
rm -rf -- "$CTL/docker"

if [ "$rc" -ne 0 ]; then
  with_lock _set_deadline 0 none
  : >"$P/deadline"
  # Frontend and LLB errors land in the daemon's journal, not buildctl's
  # output.
  say "── buildkitd's journal since the build started ──"
  journalctl -u buildkitd.service --since "@$BUILD_STARTED" --no-pager -o short-iso 2>&1 | tail -n 400 || true
  if [ -s "$P/timedout" ]; then
    fail "$(cat "$P/timedout") timed out (building is limited to $((BUILD_SECS / 60))m, publishing to $((PUBLISH_SECS / 60))m)"
  fi
  systemctl is-active --quiet buildkitd.service || fail "builder unavailable: buildkitd stopped during the build"
  fail "$(stage_error "$(current_state)" "$rc" "$(((BUILD_SECS + PUBLISH_SECS) / 60))m")"
fi
with_lock _after_build

# BuildKit's own report of the push, into root's copy: the digest below, and
# the tags and descriptor image_facts reads out of the same file.
as_build dd if="$WORK/out/metadata.json" iflag=nofollow,nonblock bs=65536 count=16 status=none \
  >"$P/metadata.json" 2>/dev/null || : >"$P/metadata.json"
DIGEST="$(jq -r '."containerimage.digest" // "" | strings' "$P/metadata.json" 2>/dev/null)" || DIGEST=""
[[ "$DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] || fail "BuildKit reported no image digest for the push"

# The image's size: config plus layers, from the manifest zot serves
# anonymously. Informational — a failure costs the number, not the build.
image_size() {
  local accept ref="$DIGEST" hop
  accept='application/vnd.oci.image.manifest.v1+json, application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.docker.distribution.manifest.list.v2+json'
  for hop in 1 2; do
    curl -fsS --proto '=https' --max-time 20 -H "Accept: $accept" \
      -o "$P/manifest.json" "https://$REGISTRY/v2/$APP/manifests/$ref" || return 1
    if jq -e '(.manifests | type) == "array"' "$P/manifest.json" >/dev/null 2>&1; then
      [ "$hop" = 1 ] || return 1
      ref="$(jq -r '[.manifests[] | select(.platform.os == "linux" and .platform.architecture == "amd64")][0].digest // ""' "$P/manifest.json")"
      [[ "$ref" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
      continue
    fi
    jq -e '[(.config.size // 0), (.layers[]?.size // 0)] | add' "$P/manifest.json"
    return
  done
  return 1
}
SIZE="$(image_size 2>/dev/null)" || SIZE=""
if ! [[ "$SIZE" =~ ^[0-9]+$ ]]; then
  say "could not read the image size from $REGISTRY"
  SIZE=null
fi
status_set '.digest = $d | .imageRef = $r | .sizeBytes = $s' --arg d "$DIGEST" --arg r "$IMAGE_REF" --argjson s "$SIZE"
say "pushed $IMAGE_REF ($DIGEST, ${SIZE} bytes)"

# ── what the push and the solve say about themselves ──────────────────────
#
# Both are read from what the stage above already produced — the metadata file
# BuildKit wrote, the manifest image_size fetched, and the vertex verdicts
# scan_output kept — so neither costs the build a second of work, and both are
# best-effort: a key that cannot be worked out is left out, because an absent
# key reads as "unknown" to the engine while a wrong one would lie. Each runs
# in a command substitution and the publish happens out here, so a jq that
# trips costs its own subshell rather than the status (`jq >next | mv` is safe
# only while errexit can stop the script between the two).

# The `image` object on stdout. The tags are the ones BuildKit reports it
# PUSHED (`image.name` in the metadata), not the $TAGS this script asked for;
# they agree today, and a daemon that ever rewrote one is exactly the sort of
# thing worth being able to see. Each is cut down to its tag — the repository
# prefix is the same for all of them and already in `imageRef`.
image_facts() {
  [ -e "$P/manifest.json" ] || : >"$P/manifest.json"
  jq -cn --slurpfile meta "$P/metadata.json" --slurpfile manifest "$P/manifest.json" \
    --arg repo "$REGISTRY/$APP" --arg asked "$TAGS" \
    --argjson maxTags "$MAX_IMAGE_TAGS" --argjson maxLayers "$MAX_IMAGE_LAYERS" '
    (($meta[0] | objects) // {}) as $m
    # An index is the one thing image_size can leave behind unresolved: its
    # sizes belong to no image, so only the descriptor speaks for it.
    | (($manifest[0] | objects | select((.manifests | type) != "array")) // {}) as $f
    | (($f.layers | arrays) // null) as $layers
    | { tags: ((($m["image.name"] | strings) // $asked) | split(",")
               | map(select(length > 0)
                     | if startswith($repo + ":") then .[($repo | length) + 1:] else . end
                     | .[0:200])
               | .[0:$maxTags]),
        layers: (if $layers == null then null else ($layers | length) end),
        layerSizes: (if $layers == null then null
                     else [$layers[] | if (type == "object") and ((.size | type) == "number")
                                       then .size else 0 end][0:$maxLayers] end),
        configSize: (($f.config | objects | .size | numbers) // null),
        mediaType: (((($f.mediaType | strings)
                      // ($m["containerimage.descriptor"] | objects | .mediaType | strings)) // null)
                    | if . == null then null else .[0:200] end) }
    | with_entries(select(.value != null))' | redact_json
}

# The cache and step half of `build` on stdout, counted from the publishing
# solve's own vertex verdicts ($P/vertices, this call's alone). Numbers and
# booleans only, so there is nothing here for redact to do.
#
# We stayed on --progress=plain rather than moving the publishing solve to
# --progress=rawjson. This log is what the build page tails live and what the
# GitHub check run quotes at whoever pushed, and plain is the format a person
# already knows how to read; rawjson would mean rendering our own progress UI
# to keep it that way, and re-deriving four existing readers (failed_check's
# vertex numbers, stage_error's hint, scan_output's push marker, the
# buildkitd journal dump) from a format buildctl documents as unstable. These
# facts are cheap to parse out of plain and change nothing a human sees.
#
#   #12 CACHED                             a step BuildKit did not have to run
#   #12 DONE 4.2s                          a step that ran
#   #6 importing cache manifest from <ref> … then its own DONE or ERROR
#   #34 exporting cache to registry        … then its own DONE or ERROR
#
# A cache import that misses is `ERROR: failed to configure registry cache
# importer: <ref>: not found` and does NOT fail the build — an app's first
# build always misses — and an export failure is swallowed whole by
# ignore-error=true. Both keep ignore-error, because a cache problem must
# never fail a build; publishing the verdict is what turns that silence into
# a fact somebody can act on.
#
# The two cache vertices are facts in their own right, so they are not counted
# as steps; every other vertex that reached a verdict is one. A vertex can
# print its block more than once in plain progress, hence the per-id table.
build_facts() {
  local counts cached total imported exported
  [ -s "$P/vertices" ] || return 1
  counts="$(awk -v cache="$CACHE_REF" '
    /^#[0-9]+ / {
      id = substr($1, 2)
      if ($2 == "importing" && index($0, cache) > 0) { impId = id; next }
      if ($2 == "exporting" && $3 == "cache") { expId = id; next }
      # A verdict is DONE, CACHED, or ERROR with a colon stuck to it.
      verdict = $2
      sub(/:$/, "", verdict)
      if (verdict != "DONE" && verdict != "CACHED" && verdict != "ERROR") next
      if (impId != "" && id == impId) impState = verdict
      else if (expId != "" && id == expId) expState = verdict
      else if (verdict != "ERROR") state[id] = verdict
    }
    END {
      for (k in state) { total++; if (state[k] == "CACHED") cached++ }
      printf "%d %d %s %s\n", cached + 0, total + 0,
        (impState == "" ? "-" : impState), (expState == "" ? "-" : expState)
    }' "$P/vertices")" || return 1
  read -r cached total imported exported <<<"$counts" || return 1
  jq -cn --argjson cached "$cached" --argjson total "$total" \
    --arg imported "$imported" --arg exported "$exported" '
    (if $total > 0 then { stepsCached: $cached, stepsTotal: $total } else {} end)
    + (if $imported == "DONE" then { cacheImported: true }
       elif $imported == "ERROR" then { cacheImported: false } else {} end)
    + (if $exported == "DONE" then { cacheExported: true }
       elif $exported == "ERROR" then { cacheExported: false } else {} end)'
}

if IMAGE_FACTS="$(image_facts)" && [ -n "$IMAGE_FACTS" ] && jq -e . <<<"$IMAGE_FACTS" >/dev/null 2>&1; then
  status_set '.image = $i' --argjson i "$IMAGE_FACTS"
else
  say "could not read the pushed image's manifest facts for the status"
fi

# `.build +=`, because the runner and the secrets hash were published into the
# same object back in stage 3.
if BUILD_FACTS="$(build_facts)" && [ -n "$BUILD_FACTS" ] && [ "$BUILD_FACTS" != "{}" ] &&
  jq -e . <<<"$BUILD_FACTS" >/dev/null 2>&1; then
  status_set '.build += $b' --argjson b "$BUILD_FACTS"
  # The same facts as a sentence, because the log is read by people too.
  FACTS_LINE="$(jq -r '
    ["steps: \(.stepsCached // "?") of \(.stepsTotal // "?") cached",
     "registry cache import \(if has("cacheImported") then (if .cacheImported then "hit" else "missed" end) else "not attempted" end)",
     "export \(if has("cacheExported") then (if .cacheExported then "written" else "FAILED" end) else "not attempted" end)"]
    | join("; ")' <<<"$BUILD_FACTS")" || FACTS_LINE="build facts: $BUILD_FACTS"
  say "$FACTS_LINE"
else
  say "could not read the solve's cache and step facts for the status"
fi
