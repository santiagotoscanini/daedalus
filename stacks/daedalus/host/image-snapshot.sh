# Publish each running container's image LABELS for daedalus to read.
#
# The problem this solves: a container pinned by digest to a moving tag —
# `:latest`, `jvm-stable`, a bare major — carries no version in its pin, so the
# dashboard had nothing to report for Shelfmark, Recyclarr, Janitorr or
# SearXNG. Two of those were being read back out of a startup banner in Loki,
# which works only while the container has restarted inside Loki's retention;
# one was reported as genuinely unknowable, which was wrong.
#
# It is not unknowable: the image itself states it. `org.opencontainers.image.
# version` is a standard OCI annotation and most publishers set it, alongside
# `revision` (the source commit) and `source` (the repo). That is a fact about
# the artefact actually on disk, so it needs no network, no API on the service
# and no log retention.
#
# NOT a substitute for the flake tag, and the app treats it as the fallback —
# see `imageVersion`. Some images inherit the annotation from their BASE image
# and report something unrelated: cleanuparr's says `24.04`, which is Ubuntu's,
# while the tag correctly says 2.10.1. The pin is what we asked for and wins;
# this is what can be learned when the pin says nothing.
#
# No secrets here — labels are public metadata baked into a published image —
# so unlike env-snapshot this is world-readable and could live anywhere. It
# stays in /run for the same reason: it is derived state that should not
# survive a reboot or ride the ZFS snapshots.
#
# Runs as root and drops to santiago for podman, because the containers live in
# santiago's rootless store. Same setpriv-not-sudo reasoning as deploy.sh: no
# PAM session per call.

set -euo pipefail

install -d -m 0755 -o santiago -g users "$OUT_DIR"

# Absolute paths, because the privilege-dropped child does NOT inherit
# writeShellApplication's PATH — the same trap deploy.sh and env-snapshot.sh
# both document. Getting it wrong fails silently.
podman_() {
  "$SETPRIV" --reuid=santiago --regid=users --init-groups --inh-caps=-all \
    "$ENV_BIN" HOME=/home/santiago XDG_RUNTIME_DIR=/run/user/1000 \
    "$PODMAN" "$@"
}

# Read the whole list first rather than piping into the loop: a pipeline runs
# its right-hand side in a subshell, and the separator state below would be
# discarded along with it.
list=$(podman_ ps --format '{{.Names}}|{{.Image}}' || true)

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT

{
  printf '{\n'
  sep=""
  while IFS='|' read -r name image; do
    [ -n "$name" ] && [ -n "$image" ] || continue

    # An image that has been pruned out from under a running container is a
    # real state, not an error — report the container with nothing known
    # rather than dropping it, so the app can tell "no labels" from "no such
    # container".
    labels=$(podman_ image inspect "$image" --format '{{json .Labels}}' 2>/dev/null || true)
    case "$labels" in
    "" | null) labels='{}' ;;
    esac

    printf '%s  %s: %s' "$sep" \
      "$(printf '%s' "$name" | "$JQ" -R .)" \
      "$(printf '%s' "$labels" | "$JQ" -c '{
           version:  (."org.opencontainers.image.version"  // null),
           revision: (."org.opencontainers.image.revision" // null),
           source:   (."org.opencontainers.image.source"   // null),
           created:  (."org.opencontainers.image.created"  // null)
         }' 2>/dev/null || printf '{"version":null,"revision":null,"source":null,"created":null}')"
    sep=",
"
  done <<EOF
$list
EOF
  printf '\n}\n'
} >"$tmp"

# Validate before publishing. A half-written or malformed file would make every
# version on the dashboard read "unknown", which is exactly the failure this
# script exists to remove — better to keep the previous snapshot.
if ! "$JQ" -e . "$tmp" >/dev/null 2>&1; then
  echo "image snapshot was not valid JSON; keeping the previous one" >&2
  exit 1
fi

chmod 0644 "$tmp"
chown santiago:users "$tmp"
# A rename rather than writing in place: daedalus reads this on render and
# would otherwise be able to see a partial file.
mv "$tmp" "$OUT_DIR/labels.json"
trap - EXIT
