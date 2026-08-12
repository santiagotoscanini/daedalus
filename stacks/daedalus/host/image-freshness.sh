# Ask each registry whether a digest-pinned tag has moved on.
#
# The gap this covers: a pin like `searxng:latest@sha256:…` freezes an image
# forever (`--pull missing` matches on tag, and the digest wins anyway), and
# the GitHub releases-behind verdict has nothing to measure a channel against —
# `latest`, `main-stable`, `jvm-stable` name no release. So nobody ever asked
# the one party that actually knows: the registry. This does, once a day, and
# publishes per container whether the tag still points at the pinned digest.
#
# The candidate list is rendered by nix at eval time ($PINNED, container →
# {image, tag, pinnedDigest}) from the running config — ANY `:tag@sha256:` pin,
# not just the moving channels, because a re-pushed release tag is the same
# fact and deciding which tags "move" is the reader's judgement, not this
# script's. Local builds and the registry-loop apps carry no digest pin and
# fall out of the match naturally.
#
# One skopeo call per unique image ref; a SECOND call (for the remote config's
# `created` date) only when the digest actually moved — that is the handful of
# rows where "behind since when" is worth a request, and it keeps the daily
# budget at roughly one manifest HEAD per image. docker.io's anonymous limit is
# 100 pulls per 6 h per IP; ~30 of the pins live there, so a daily run with a
# polite sleep between refs is an order of magnitude inside it.
#
# A registry that does not answer is a ROW ("error": …), never a failed run:
# one sinkholed or flaky host must not blank the verdicts for the other fifty.
#
# Root, like system-snapshot: no rootless store to reach into, and the output
# dir under /run is root-created. No secrets touched — every ref is public.

set -euo pipefail

install -d -m 0755 -o santiago -g users "$OUT_DIR"

# Same-directory temp file, unlike image-snapshot's mktemp: /tmp and /run are
# different tmpfs mounts, and an mv across filesystems is a copy — the reader
# could see a torn file. In-dir, the rename is atomic.
tmp=$(mktemp "$OUT_DIR/.freshness.XXXXXX")
trap 'rm -f "$tmp"' EXIT

declare -A remote_cache error_cache created_cache

checked=0
moved_count=0
error_count=0
data='{}'

while IFS=$'\t' read -r name image tag pinned; do
  [ -n "$name" ] && [ -n "$image" ] || continue

  # Several containers can share one image (and one answer); ask once.
  if [[ ! -v "remote_cache[$image]" ]]; then
    # Politeness between NETWORK calls only — cache hits cost nothing.
    sleep 2
    if remote=$(timeout 45 skopeo inspect --no-tags --format '{{.Digest}}' \
      "docker://$image" 2>&1); then
      error_cache[$image]=""
    else
      # Last line of skopeo's complaint, bounded — the JSON is a dashboard
      # row, not a log archive.
      error_cache[$image]=$(printf '%s' "$remote" | tail -n 1 | cut -c1-200)
      remote=""
    fi
    remote_cache[$image]=$remote
  fi

  remote=${remote_cache[$image]}
  err=${error_cache[$image]}

  moved=false
  created=""
  if [ -z "$err" ] && [ "$remote" != "$pinned" ]; then
    moved=true
    # The second request, spent only here: when the tag moved, the remote
    # config's `created` date is what turns "behind" into "behind since".
    if [[ ! -v "created_cache[$image]" ]]; then
      created_cache[$image]=$(timeout 45 skopeo inspect --no-tags --config \
        "docker://$image" 2>/dev/null | jq -r '.created // empty' || true)
    fi
    created=${created_cache[$image]}
  fi

  row=$(jq -n \
    --arg image "$image" --arg tag "$tag" --arg pinned "$pinned" \
    --arg remote "$remote" --arg created "$created" --arg err "$err" \
    --arg at "$(date -Is)" --argjson moved "$moved" '{
      image: $image,
      tag: $tag,
      pinnedDigest: $pinned,
      remoteDigest: (if $remote == "" then null else $remote end),
      moved: $moved,
      remoteCreated: (if $created == "" then null else $created end),
      checkedAt: $at,
      error: (if $err == "" then null else $err end)
    }')
  data=$(jq --arg name "$name" --argjson row "$row" '. + {($name): $row}' <<<"$data")

  checked=$((checked + 1))
  [ "$moved" = true ] && moved_count=$((moved_count + 1))
  [ -n "$err" ] && error_count=$((error_count + 1))
done < <(jq -r 'to_entries[] | [.key, .value.image, .value.tag, .value.pinnedDigest] | @tsv' "$PINNED")

# The standard host envelope (same shape deploy.sh publishes); generatedAt is
# what the app's snapshot reader ages the file by.
jq -n --argjson data "$data" --arg g "$(date -Is)" '{
  daedalusExport: 1,
  domain: "image-freshness",
  schemaVersion: 1,
  source: "host",
  revision: null,
  generatedAt: $g,
  data: $data
}' >"$tmp"

chmod 0644 "$tmp"
chown santiago:users "$tmp"
mv "$tmp" "$OUT_DIR/freshness.json"
trap - EXIT

# Say what happened every run — the counts are the content: `moved` climbing
# is pins quietly aging, `errors` at the total is the network (or a rate
# limit), not the pins.
echo "checked $checked pinned images: $moved_count moved, $error_count unanswered"
