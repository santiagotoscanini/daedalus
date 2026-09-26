# What only the HOST can say about the builder (builder.nix, build-agent.nix),
# for System › Builder.
#
# The builds themselves are the app's own records; this is the machinery
# under them, none of which the container can see:
#
#   buildkit    whether the daemon answers on its socket, and its cache —
#               total and reclaimable, from `buildctl du`
#   storage     whether the scratch dataset is really mounted (it mounts
#               nofail, so a failed mount is otherwise silent), and its use
#               against its quota
#   mise        each app's Railpack mise cache, in bytes
#   fence       whether the egress fence's OUTPUT jumps are loaded
#   credential  whether the registry push password is well-formed
#   units       the builder's units: active/sub state, result, last exit
#
# ── what is deliberately NOT in here ──────────────────────────────────────
#
# Anything secret. The push credential is checked by running its one reader
# with stdout thrown away: only the exit code is kept, never a byte of what
# it printed. The fence check is kept as an exit code too. The rest is sizes,
# versions and unit states, so the file is 0644 in a 0755 directory like the
# image snapshot's.
#
# /run rather than a state dir, like its siblings: derived state that should
# not survive a reboot.

set -euo pipefail

install -d -m 0755 -o "$OPERATOR_USER" -g "$OPERATOR_GROUP" "$OUT_DIR"

# A non-negative integer, or JSON null.
int_or_null() {
  case "$1" in
    '' | *[!0-9]*) echo null ;;
    *) echo "$1" ;;
  esac
}

# ── BuildKit ──────────────────────────────────────────────────────────────
#
# Bounded: a wedged daemon must not hold this unit, and with it the
# container's start, which is ordered after it. Summed the way `buildctl du`
# sums its own Total and Reclaimable lines.
buildkit_json() {
  local du
  if du=$(timeout 10 "$BUILDCTL" --addr "$BUILDKIT_ADDR" du --format '{{json .}}' 2>/dev/null) &&
    printf '%s' "$du" | jq -e 'type == "array" or . == null' >/dev/null 2>&1; then
    printf '%s' "$du" | jq -c --arg v "$BUILDKIT_VERSION" '(. // []) as $r | {
      version: $v,
      reachable: true,
      cacheBytes: ([$r[].size] | add // 0),
      reclaimableBytes: ([$r[] | select(.inUse | not) | .size] | add // 0)
    }'
  else
    jq -nc --arg v "$BUILDKIT_VERSION" \
      '{ version: $v, reachable: false, cacheBytes: null, reclaimableBytes: null }'
  fi
}

# ── the scratch dataset ───────────────────────────────────────────────────
#
# `findmnt --target` answers for the nearest mount at or above the path, so
# an unmounted dataset reports its parent's source instead of failing — the
# SOURCE is what is compared (builder/storage.nix, the same check hourly).
storage_json() {
  local src mounted=false used=null quota=null vals
  src=$(findmnt -n -o SOURCE --target "$BUILD_ROOT" 2>/dev/null || true)
  [ "$src" = "$DATASET" ] && mounted=true
  if vals=$("$ZFS" get -Hp -o value used,quota "$DATASET" 2>/dev/null); then
    used=$(int_or_null "$(sed -n 1p <<<"$vals")")
    quota=$(int_or_null "$(sed -n 2p <<<"$vals")")
    # zfs says 0 for "no quota".
    [ "$quota" = 0 ] && quota=null
  fi
  jq -nc --arg d "$DATASET" --arg m "$BUILD_ROOT" --argjson on "$mounted" \
    --argjson used "$used" --argjson quota "$quota" \
    '{ dataset: $d, mountpoint: $m, mounted: $on, usedBytes: $used, quotaBytes: $quota }'
}

# ── the mise caches ───────────────────────────────────────────────────────
#
# One directory per app. The parent is root 0700 (builder/storage.nix), so
# nothing but root names an entry in it; `du` only stats what is below and
# follows no link.
mise_json() {
  local app
  if [ ! -d "$MISE_CACHE_DIR" ]; then
    echo '[]'
    return
  fi
  find "$MISE_CACHE_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort |
    while IFS= read -r app; do
      printf '%s\t%s\n' "$app" "$(du -sbx -- "$MISE_CACHE_DIR/$app" 2>/dev/null | cut -f1)"
    done |
    jq -Rnc '[inputs | split("\t") | { app: .[0], bytes: (.[1] | tonumber? // null) }]'
}

# ── the fence and the credential: exit codes only ─────────────────────────
ok() {
  if "$@" >/dev/null 2>&1; then echo true; else echo false; fi
}

# ── the units ─────────────────────────────────────────────────────────────
units_json() {
  local u
  for u in "${UNITS[@]}"; do
    systemctl show --timestamp=unix -p ActiveState,SubState,Result,ExecMainExitTimestamp -- "$u" |
      jq -Rnc --arg unit "$u" '
        [inputs | capture("^(?<key>[^=]+)=(?<value>.*)$")] | from_entries as $p | {
          unit: $unit,
          active: ($p.ActiveState // "unknown"),
          sub: ($p.SubState // ""),
          result: (if ($p.Result // "") == "" then null else $p.Result end),
          lastExitAt: (($p.ExecMainExitTimestamp // "") as $t |
            if $t | startswith("@") then ($t[1:] | tonumber | todate) else null end)
        }'
  done | jq -sc '.'
}

# Each part into a variable first: under errexit and pipefail a reader that
# breaks fails the unit (and mails) instead of publishing an empty list as
# though it were the answer.
buildkit=$(buildkit_json)
storage=$(storage_json)
mise=$(mise_json)
fence=$(ok "$FENCE_CHECK")
credential=$(ok "$CREDENTIAL_READ")
units=$(units_json)

doc=$(mktemp)
trap 'rm -f "$doc"' EXIT

jq -n \
  --argjson buildkit "$buildkit" \
  --argjson storage "$storage" \
  --argjson mise "$mise" \
  --argjson fence "$fence" \
  --argjson credential "$credential" \
  --argjson units "$units" \
  --arg g "$(date -Is)" '{
    daedalusExport: 1,
    domain: "builder",
    schemaVersion: 1,
    source: "host",
    revision: null,
    generatedAt: $g,
    data: {
      buildkit: $buildkit,
      storage: $storage,
      mise: $mise,
      fence: { loaded: $fence },
      credential: { wellFormed: $credential },
      units: $units
    }
  }' >"$doc"
write_json_atomic "$OUT_DIR/builder.json" 0644 <"$doc"

# A successful oneshot has no lines of its own, so without this the unit is
# invisible in Loki and could stop with nothing to see.
echo "published builder snapshot:" \
  "buildkit $(jq -r 'if .data.buildkit.reachable then "reachable" else "unreachable" end' "$doc")," \
  "dataset $(jq -r 'if .data.storage.mounted then "mounted" else "NOT mounted" end' "$doc")," \
  "fence $(jq -r 'if .data.fence.loaded then "loaded" else "MISSING" end' "$doc")," \
  "credential $(jq -r 'if .data.credential.wellFormed then "ok" else "REFUSED" end' "$doc")," \
  "$(jq '[.data.units[] | select(.result != null and .result != "success")] | length' "$doc") unit(s) not successful"
