#!/bin/sh
# Install or update the daedalus agent on this Mac or Linux machine.
#
#   curl -fsSL https://daedalus.toscanini.me/install.sh | sudo sh
#
# Downloads the newest agent-v* release of the engine repository (the site
# serves this file from agent/install.sh on main, so the line never names a
# version) and registers it with the OS's service manager. From then on the
# agent keeps the machine awake, keeps one connection to the controller
# (the box's agent) — it listens on nothing the LAN can reach — runs
# Claude Code's remote control for the user who ran sudo, and updates itself.
# Re-running on an installed machine replaces the binaries and keeps
# config.toml.
# `sudo daedalus-agent uninstall` removes what `install` registered.
#
#   macOS: the two universal binaries under
#     /Library/Application Support/daedalus-agent/bin; the service as a root
#     LaunchDaemon, the menu bar app as a LaunchAgent in every user's session.
#   Linux (systemd distributions, x86_64 and aarch64): the static service
#     under /opt/daedalus-agent/bin — and on x86_64 the tray, for desktops —
#     then `daedalus-agent install`: a root systemd service, the session as a
#     systemd user unit for the user who ran sudo (lingering on, so Claude
#     remote control runs with nobody logged in), and the tray's XDG
#     autostart entry where there is a tray. The newest release that carries
#     a build for this architecture is the one installed.
#
# Trust at install is HTTPS to GitHub. Every later update is verified by the
# agent itself against the release key it carries.
#
# Environment: DAEDALUS_REPO (owner/name), DAEDALUS_AGENT_VERSION (e.g. 0.5.0
# instead of the newest).
#
# Arguments, both optional — where the controller (the box's agent) is and
# which key to trust, written to config.toml (also on a reinstall):
#
#   curl -fsSL https://daedalus.toscanini.me/install.sh | sudo sh -s -- \
#     --controller box.lan:7788 --pin 3f2a:9c01:…
#
# Without --controller the agent asks DNS for the controller's SRV record;
# without --pin it trusts the first key the controller presents, and says
# so until one is pinned.
set -eu
# Root's umask under `sudo sh` can be 077, which would leave the agent's
# directories unreadable to the user the menu bar app, the tray and the
# session run as.
umask 022

REPO="${DAEDALUS_REPO:-santiagotoscanini/daedalus}"
VERSION="${DAEDALUS_AGENT_VERSION:-}"

# --controller HOST:PORT and --pin FINGERPRINT, passed on to `install`.
LINK_ARGS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --controller | --pin)
      [ $# -ge 2 ] || { echo "install.sh: $1 needs a value" >&2; exit 1; }
      case "$2" in *[!A-Za-z0-9.:_\[\]-]*) echo "install.sh: $1 $2: unexpected characters" >&2; exit 1 ;; esac
      LINK_ARGS="$LINK_ARGS $1 $2"
      shift 2
      ;;
    *) echo "install.sh: unknown argument $1 (known: --controller HOST:PORT, --pin FINGERPRINT)" >&2; exit 1 ;;
  esac
done

die() { echo "install.sh: $*" >&2; exit 1; }

command -v curl >/dev/null || die "curl is needed"

api="https://api.github.com/repos/$REPO/releases?per_page=30"

# Every agent-v* release's version, newest first. GitHub lists newest-first,
# but the sort is by the three numbers so a patch to an older line never wins.
agent_versions() {
  curl -fsSL -H 'Accept: application/vnd.github+json' -H 'User-Agent: daedalus-agent-install' "$api" |
    grep -o '"tag_name": *"agent-v[0-9][0-9.]*"' | sed 's/.*"agent-v\([0-9.]*\)"/\1/' |
    sort -t. -k1,1nr -k2,2nr -k3,3nr
}

# Whether a release asset exists (GitHub answers a download with a redirect).
has_asset() {
  curl -fsIL -o /dev/null "https://github.com/$REPO/releases/download/$1/$2"
}

install_macos() {
  ROOT="/Library/Application Support/daedalus-agent"
  BIN="$ROOT/bin"

  echo "looking up releases of $REPO"
  if [ -n "$VERSION" ]; then
    tag="agent-v$VERSION"
  else
    tag="$(agent_versions | head -n 1)"
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

  # shellcheck disable=SC2086 # LINK_ARGS is flag/value pairs checked above
  "$BIN/daedalus-agent" install $LINK_ARGS
  echo
  echo "installed $tag. Status: daedalus-agent status"
  echo "logs: $ROOT/logs (the service), ~/Library/Logs/daedalus-agent (the menu bar app)"
  echo "nothing listens on the LAN; the box hears from this machine over its link to the controller"
}

install_linux() {
  ROOT="/opt/daedalus-agent"
  BIN="$ROOT/bin"

  [ -e /etc/NIXOS ] && die "this is NixOS: its configuration is nix's, so the agent is not installed by this script"
  [ -d /run/systemd/system ] || die "this installer needs systemd as the init system, and this machine does not run it"
  case "$(uname -m)" in
    x86_64 | amd64) arch=x86_64 ;;
    aarch64 | arm64) arch=aarch64 ;;
    *) die "no Linux build for $(uname -m); the agent is built for x86_64 and aarch64" ;;
  esac
  asset="daedalus-agent-${arch}-unknown-linux-musl"
  # The tray links GTK against glibc and is built for x86_64 only; aarch64
  # machines run without one.
  tray_asset=""
  [ "$arch" = x86_64 ] && tray_asset="daedalus-agent-tray-x86_64-unknown-linux-gnu"

  echo "looking up releases of $REPO for $arch"
  if [ -n "$VERSION" ]; then
    tag="agent-v$VERSION"
    has_asset "$tag" "$asset" || die "$tag has no Linux build for $arch ($asset)"
  else
    versions="$(agent_versions)"
    [ -n "$versions" ] || die "no agent-v* release found in $REPO"
    tag=""
    for v in $versions; do
      if has_asset "agent-v$v" "$asset"; then tag="agent-v$v"; break; fi
    done
    [ -n "$tag" ] || die "no Linux release yet: no agent-v* release of $REPO carries $asset"
  fi
  base="https://github.com/$REPO/releases/download/$tag"
  echo "installing $tag"

  mkdir -p "$BIN"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  echo "  $asset"
  curl -fsSL -o "$tmp/daedalus-agent" "$base/$asset"
  chmod 755 "$tmp/daedalus-agent"
  if [ -n "$tray_asset" ] && curl -fsSL -o "$tmp/daedalus-agent-tray" "$base/$tray_asset" 2>/dev/null; then
    echo "  $tray_asset"
    chmod 755 "$tmp/daedalus-agent-tray"
  else
    rm -f "$tmp/daedalus-agent-tray"
  fi

  # Stop the service before the files move, so its rename-in-place updater
  # and this installer never race. `install` starts everything again.
  systemctl stop daedalus-agent.service 2>/dev/null || true

  mv -f "$tmp/daedalus-agent" "$BIN/daedalus-agent"
  if [ -f "$tmp/daedalus-agent-tray" ]; then
    mv -f "$tmp/daedalus-agent-tray" "$BIN/daedalus-agent-tray"
  fi
  # A `daedalus-agent status` from any terminal.
  mkdir -p /usr/local/bin
  ln -sf "$BIN/daedalus-agent" /usr/local/bin/daedalus-agent
  chmod 755 "$ROOT" "$BIN"

  # shellcheck disable=SC2086 # LINK_ARGS is flag/value pairs checked above
  "$BIN/daedalus-agent" install $LINK_ARGS
  echo
  echo "installed $tag. Status: daedalus-agent status"
  echo "logs: /var/lib/daedalus-agent/logs (the service), ~/.local/state/daedalus-agent (the session and the tray)"
  echo "nothing listens on the LAN; the box hears from this machine over its link to the controller"
}

case "$(uname -s)" in
  Darwin) os=macos ;;
  Linux) os=linux ;;
  *) die "this installer is for macOS and Linux; Windows uses install.ps1" ;;
esac
if [ "$(id -u)" != 0 ]; then
  [ "$os" = macos ] && die "run it with sudo: the service and the launchd jobs need root"
  die "run it with sudo: the service and its systemd units need root"
fi

if [ "$os" = macos ]; then install_macos; else install_linux; fi
