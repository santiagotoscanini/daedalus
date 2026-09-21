# Keep every workspace current, and publish what they look like.
#
# One script, two wrappers (stacks/daedalus/daedalus.nix):
#
#   DO_SYNC=1  daedalus-workspace-sync — fetch + fast-forward every clone,
#              then publish. Runs from a 30-minute timer (the off-box
#              projects' cadence) and from a path unit watching the deploy
#              state files, so a hosted app's workspace pulls right after the
#              deploy that shipped its push.
#   DO_SYNC=0  daedalus-workspace-publish — publish only, ordered before the
#              container so the mount source exists and the page has facts on
#              a cold boot. No network: a GitHub outage must never gate the
#              app's start (the image-freshness rule).
#
# What "sync" refuses to do is in sync_workspace (workspace-lib.sh): a dirty
# tree or a diverged branch is fetched and left alone, and says so in the
# snapshot. A repo that fails to fetch is recorded per-repo rather than
# failing the unit — one archived repo must not stop the other nine pulling.

set -euo pipefail

ensure_dirs
lock_workspaces

if [ "$DO_SYNC" = "1" ]; then
  for d in "$WORKSPACE_ROOT"/*/; do
    [ -d "${d}.git" ] || continue
    sync_workspace "$d"
  done
fi

publish_workspaces
