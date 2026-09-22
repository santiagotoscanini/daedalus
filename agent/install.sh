#!/bin/sh
# Install or update the daedalus agent on this Mac.
#
#   curl -fsSL https://daedalus.toscanini.me/install.sh | sudo sh
#
# Downloads the newest agent-v* release of the engine repository (the site
# serves this file from agent/install.sh on main, so the line never names a
# version), puts the two universal binaries under
# /Library/Application Support/daedalus-agent/bin, and registers them with
# launchd: the service as root at boot, the menu bar app in every user's
# session. From then on the agent keeps this Mac awake, answers a status page
# on TCP 7787 for the LAN, announces itself to the box, and updates itself.
# Re-running on an installed Mac replaces the binaries and keeps config.toml.
# `sudo daedalus-agent uninstall` removes both launchd jobs.
#
# Trust at install is HTTPS to GitHub. Every later update is verified by the
# agent itself against the release key it carries.
#
# Environment: DAEDALUS_REPO (owner/name), DAEDALUS_AGENT_VERSION (e.g. 0.5.0
# instead of the newest), DAEDALUS_AGENT_PORT (the status page's port, on
# first install only).
set -eu
# Root's umask under `sudo sh` can be 077, which would leave the agent's
# directories unreadable to the user the menu bar app runs as.
umask 022

REPO="${DAEDALUS_REPO:-santiagotoscanini/daedalus}"
VERSION="${DAEDALUS_AGENT_VERSION:-}"
PORT="${DAEDALUS_AGENT_PORT:-7787}"
ROOT="/Library/Application Support/daedalus-agent"
BIN="$ROOT/bin"

die() { echo "install.sh: $*" >&2; exit 1; }

[ "$(uname -s)" = Darwin ] || die "this installer is for macOS; Windows uses install.ps1"
[ "$(id -u)" = 0 ] || die "run it with sudo: the service and the launchd jobs need root"
command -v curl >/dev/null || die "curl is needed"

api="https://api.github.com/repos/$REPO/releases?per_page=30"
echo "looking up releases of $REPO"
if [ -n "$VERSION" ]; then
  tag="agent-v$VERSION"
else
  # Newest agent-v* release by version. GitHub lists newest-first, but the
  # sort is by the three numbers so a patch to an older line never wins.
  tag="$(curl -fsSL -H 'Accept: application/vnd.github+json' -H 'User-Agent: daedalus-agent-install' "$api" |
    grep -o '"tag_name": *"agent-v[0-9][0-9.]*"' | sed 's/.*"agent-v\([0-9.]*\)"/\1/' |
    sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1)"
  [ -n "$tag" ] || die "no agent-v* release found in $REPO"
  tag="agent-v$tag"
fi
base="https://github.com/$REPO/releases/download/$tag"
echo "installing $tag"

mkdir -p "$BIN" "$ROOT/logs"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
for pair in "daedalus-agent-universal-apple-darwin:daedalus-agent" \
            "daedalus-agent-tray-universal-apple-darwin:daedalus-agent-tray"; do
  asset="${pair%%:*}"; name="${pair##*:}"
  echo "  $asset"
  curl -fsSL -o "$tmp/$name" "$base/$asset"
  chmod 755 "$tmp/$name"
done

# Stop what runs before the files move, so the daemon's rename-in-place
# updater and this installer never race.
launchctl bootout system/me.toscanini.daedalus-agent 2>/dev/null || true
uid="$(stat -f %u /dev/console 2>/dev/null || echo 0)"
[ "$uid" = 0 ] || launchctl bootout "gui/$uid/me.toscanini.daedalus-agent-tray" 2>/dev/null || true

mv -f "$tmp/daedalus-agent" "$BIN/daedalus-agent"
mv -f "$tmp/daedalus-agent-tray" "$BIN/daedalus-agent-tray"
# A `daedalus-agent status` from any terminal.
ln -sf "$BIN/daedalus-agent" /usr/local/bin/daedalus-agent 2>/dev/null || true
chmod 755 "$ROOT" "$BIN" "$ROOT/logs"

"$BIN/daedalus-agent" install --port "$PORT"
echo
echo "installed $tag. Status page: http://$(hostname):$PORT/status"
echo "logs: $ROOT/logs (the service), ~/Library/Logs/daedalus-agent (the menu bar app)"
echo "the status page answers the LAN without a login with machine facts and a Claude summary; sessions and paths are only for the box (node token) and this machine"
