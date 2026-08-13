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

declare -A remote_cache error_cache created_cache version_cache tags_cache

# ── what else this tag could be ───────────────────────────────────────────
#
# The digest question above is the whole story only for a pin whose tag names
# a CHANNEL: `latest` moves, and re-resolving it is the update. Most pins here
# name a release instead — `v1.6.0-ls356`, `10.11.11ubu2404-ls42` — and those
# tags never move, so "has it moved" is permanently false while the service is
# four releases behind. For those the update is a different TAG, and the only
# party that knows which tags exist is the registry.
#
# The shape rule is what keeps that from being a guess. A candidate must match
# the current tag with every run of digits blanked out, so the suffix
# conventions that actually distinguish these images survive: a linuxserver
# `-lsNNN` build can only be replaced by another `-lsNNN`, `-openvino` by
# `-openvino`, `3.13-alpine` by another `-alpine`. Those are precisely the
# distinctions a "newest tag" heuristic gets wrong, and getting one wrong here
# means pulling a different image rather than a newer one.
#
# The reader still picks. This publishes the shortlist and which entry sorts
# highest; nothing here decides that highest is what anyone wants — crossing a
# major is a reading of a changelog, not of a version string.

# A tag, as an anchored ERE matching tags of the same shape. Everything that
# is not alphanumeric is escaped first (so `.` cannot match itself by
# accident), then each digit run becomes the wildcard.
tag_shape() {
  printf '%s' "$1" | sed -e 's/[^a-zA-Z0-9_-]/\\&/g' -e 's/[0-9][0-9]*/[0-9]+/g'
}

# Tags of the same shape as $2 in repo $1, newest first, at most MAX_CANDIDATES.
#
# Empty for a channel tag (no digits to vary — there is no "newer latest") and
# empty when the registry will not answer, both of which the reader renders as
# "no other tag to offer" rather than as an error. A tag list is a much bigger
# request than a manifest HEAD, so it is cached per repo and skipped entirely
# for the channel pins.
MAX_CANDIDATES=12

candidates_for() {
  local repo=$1 tag=$2 shape
  shape=$(tag_shape "$tag")
  case $shape in
  *'[0-9]+'*) ;;
  *) return 0 ;;
  esac

  if [[ ! -v "tags_cache[$repo]" ]]; then
    sleep 2
    tags_cache[$repo]=$(timeout 90 skopeo list-tags "docker://$repo" 2>/dev/null |
      jq -r '.Tags[]?' || true)
  fi

  printf '%s\n' "${tags_cache[$repo]}" |
    grep -xE -- "$shape" |
    sort -V |
    tail -n "$MAX_CANDIDATES" |
    tac
}

checked=0
moved_count=0
error_count=0
behind_count=0
data='{}'

while IFS=$'\t' read -r name image repo tag pinned; do
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
  remote_version=""
  if [ -z "$err" ] && [ "$remote" != "$pinned" ]; then
    moved=true
    # The second request, spent only here: when the tag moved, the remote
    # config answers both "behind since when" and "behind by what".
    #
    # The version half matters for a CHANNEL pin, where the tag string is the
    # same on both sides and "new digest" is the only thing the digests can
    # say. A stock runtime states its version in the config
    # (`PYTHON_VERSION`), so the row can report `3.13.14 → 3.13.15` — which
    # for an image whose project publishes no changelog IS the changelog.
    # Same `<LANG>_VERSION` convention image-snapshot.sh reads locally; the
    # name is derived from the image's own, never scanned for.
    if [[ ! -v "created_cache[$image]" ]]; then
      cfg=$(timeout 45 skopeo inspect --no-tags --config "docker://$image" 2>/dev/null || true)
      created_cache[$image]=$(printf '%s' "$cfg" | jq -r '.created // empty' 2>/dev/null || true)
      base=${repo##*/}
      envvar=$(printf '%s' "$base" | tr '[:lower:]-' '[:upper:]_')_VERSION
      version_cache[$image]=$(printf '%s' "$cfg" |
        jq -r --arg v "$envvar" '(.config.Env // [])[] | select(startswith($v + "=")) | sub("^[^=]+=";"")' \
          2>/dev/null | head -n 1 || true)
    fi
    created=${created_cache[$image]}
    remote_version=${version_cache[$image]}
  fi

  # The tags this pin could move to, and which of them sorts highest.
  # `newerTag` is null when the pinned tag IS the highest — a version-pinned
  # image that is genuinely current, which `moved: false` alone cannot say.
  cands=$(candidates_for "$repo" "$tag" || true)
  newest=$(printf '%s' "$cands" | head -n 1)
  newer=""
  if [ -n "$newest" ] && [ "$newest" != "$tag" ]; then
    # sort -V decides, rather than string order: `10514` must beat `9999`,
    # and a candidate list can contain tags OLDER than the pin.
    if [ "$(printf '%s\n%s\n' "$tag" "$newest" | sort -V | tail -n 1)" = "$newest" ]; then
      newer=$newest
    fi
  fi

  row=$(jq -n \
    --arg image "$image" --arg tag "$tag" --arg pinned "$pinned" \
    --arg remote "$remote" --arg created "$created" --arg err "$err" \
    --arg at "$(date -Is)" --argjson moved "$moved" --arg newer "$newer" \
    --arg rver "$remote_version" \
    --arg cands "$cands" '{
      image: $image,
      tag: $tag,
      pinnedDigest: $pinned,
      remoteDigest: (if $remote == "" then null else $remote end),
      moved: $moved,
      remoteCreated: (if $created == "" then null else $created end),
      remoteVersion: (if $rver == "" then null else $rver end),
      newerTag: (if $newer == "" then null else $newer end),
      candidates: ($cands | split("\n") | map(select(length > 0))),
      checkedAt: $at,
      error: (if $err == "" then null else $err end)
    }')
  data=$(jq --arg name "$name" --argjson row "$row" '. + {($name): $row}' <<<"$data")

  checked=$((checked + 1))
  [ "$moved" = true ] && moved_count=$((moved_count + 1))
  [ -n "$newer" ] && behind_count=$((behind_count + 1))
  [ -n "$err" ] && error_count=$((error_count + 1))
done < <(jq -r 'to_entries[] | [.key, .value.image, .value.repo, .value.tag, .value.pinnedDigest] | @tsv' "$PINNED")

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
echo "checked $checked pinned images: $moved_count moved, $behind_count with a newer tag, $error_count unanswered"
