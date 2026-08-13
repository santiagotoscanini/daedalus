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

    # The version a stock RUNTIME image states about itself.
    #
    # Docker's official language images publish no OCI labels at all —
    # python's are empty to the last field — and their tags name a LINE
    # rather than a release: `3.13-alpine` is every 3.13.x that has ever been
    # built. So for those the two sources this file already has both answer
    # "3.13", and a changelog computed from that reports sixteen pending
    # releases when the truth is one.
    #
    # What they do carry is `<LANG>_VERSION` in the image config — the
    # convention across python, node, golang, ruby. Derived from the image's
    # OWN name rather than by scanning for anything matching `*VERSION`,
    # because python alone also exports PYTHON_PIP_VERSION and
    # PYTHON_SETUPTOOLS_VERSION and picking one of those would be worse than
    # having no answer. Absent for every image that does not follow the
    # convention, which is the correct outcome — see the refinement rule in
    # the app's images.ts for why it can only ever sharpen the pin, never
    # contradict it.
    base=$(printf '%s' "$image" | sed -e 's/@sha256:.*//' -e 's/:[^:/]*$//' -e 's#.*/##')
    envvar=$(printf '%s' "$base" | tr '[:lower:]-' '[:upper:]_')_VERSION
    configVersion=$(podman_ image inspect "$image" \
      --format "{{range .Config.Env}}{{println .}}{{end}}" 2>/dev/null |
      sed -n "s/^${envvar}=//p" | head -n 1)

    printf '%s  %s: %s' "$sep" \
      "$(printf '%s' "$name" | "$JQ" -R .)" \
      "$(printf '%s' "$labels" | "$JQ" -c --arg cv "$configVersion" '{
           version:  (."org.opencontainers.image.version"  // null),
           revision: (."org.opencontainers.image.revision" // null),
           source:   (."org.opencontainers.image.source"   // null),
           created:  (."org.opencontainers.image.created"  // null),
           configVersion: (if $cv == "" then null else $cv end)
         }' 2>/dev/null || printf '{"version":null,"revision":null,"source":null,"created":null,"configVersion":null}')"
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

# Say what happened, every run, and not only on failure.
#
# A oneshot that succeeds silently has NO lines under its own unit: systemd's
# "Starting"/"Finished" messages are emitted by PID 1 and journald attributes
# them to init.scope, not here. So the unit was invisible in Loki — which made
# it the one thing on the dashboard that could stop working with no way to see
# that it had, while the pages it feeds quietly went back to reporting
# "unknown".
#
# The counts are the useful part, not the fact that it ran: `labelled` falling
# to zero means every publisher's annotation vanished at once, which is a bug
# here rather than upstream.
total=$("$JQ" 'length' "$OUT_DIR/labels.json")
labelled=$("$JQ" '[.[] | select(.version != null)] | length' "$OUT_DIR/labels.json")
echo "published labels for $total containers, $labelled with a version"
