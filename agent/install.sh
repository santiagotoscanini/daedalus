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
# `sudo daedalus-agent uninstall` removes what `install` registered (on a
# Mac, `uninstall --app` — the menu bar's "Uninstall…" — the app as well).
#
#   macOS 13 or newer: Daedalus Agent.app, the same bundle the disk image
#     carries (the website's "Download for Mac"), unpacked and checked here,
#     then its own `install`, which puts it in its place under
#     /Library/Application Support/daedalus-agent (root's alone) and registers
#     the service as a root LaunchDaemon and the menu bar app as a LaunchAgent
#     in every user's session; it records the user who ran sudo
#     (installer.json), the one user santree's socket and the log-in serve
#     besides root, and refuses to change a recorded one without
#     --replace-operator. For a Mac with nobody at it (over ssh); with a
#     person at it, the disk image is the same install.
#   Linux (systemd distributions, x86_64 and aarch64): the static service
#     under /opt/daedalus-agent/bin — and on x86_64 the tray, for desktops —
#     then `daedalus-agent install`: a root systemd service, the session as a
#     systemd user unit for the user who ran sudo (lingering on, so Claude
#     remote control runs with nobody logged in), and the tray's XDG
#     autostart entry where there is a tray. The newest release that carries
#     a build for this architecture is the one installed.
#
# Trust at install: every file is checked against the release's signed
# manifest (release.json) by SHA-256, and the manifest against the release
# key where this machine's openssl can check ed25519 (else HTTPS to GitHub is
# the trust). Every later update is verified by the
# agent itself against the release key it carries.
#
# Environment: DAEDALUS_REPO (owner/name), DAEDALUS_AGENT_VERSION (e.g. 0.5.0
# instead of the newest).
#
# Logging in (macOS) — a Mac joins the box from its menu bar: "Log in…"
# asks for the app's address, an admin confirms in the browser,
# and the Mac gets a WireGuard tunnel of its own to the box (agent/README.md,
# "Logging in"). No key is typed here, and --pin and --controller are
# refused on a Mac. Nothing older than 0.24.0 is installed on one: the
# Mac's agent is an app from 0.24 on.
#
# Pairing (Linux) — which controller key to trust. The machine trusts none
# it was not told of: installed without --pin it runs unpaired and connects to
# nothing. At the end, with a terminal to ask on (/dev/tty, even under
# `curl | sh`), the script asks for the key from Settings › Machines and
# runs `daedalus-agent pair`; Enter, or no terminal, skips it and prints the
# command for later (the tray's "Pair with the box…" does it too). Never
# waits without a terminal. Settings › Machines also gives a line that pairs
# at once, written to config.toml (also on a reinstall):
#
#   curl -fsSL https://daedalus.toscanini.me/install.sh | sudo sh -s -- \
#     --pin 3f2a:9c01:… --controller box.lan:7788
#
# Without --controller the agent asks DNS for the controller's SRV record.
set -eu
# Root's umask under `sudo sh` can be 077, which would leave the agent's
# directories unreadable to the user the menu bar app, the tray and the
# session run as.
umask 022

REPO="${DAEDALUS_REPO:-santiagotoscanini/daedalus}"
VERSION="${DAEDALUS_AGENT_VERSION:-}"

# --controller HOST:PORT and --pin FINGERPRINT, passed on to `install`; on a
# Mac, --replace-operator.
LINK_ARGS=""
REPLACE_OPERATOR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --controller | --pin)
      [ $# -ge 2 ] || { echo "install.sh: $1 needs a value" >&2; exit 1; }
      case "$2" in *[!A-Za-z0-9.:_\[\]-]*) echo "install.sh: $1 $2: unexpected characters" >&2; exit 1 ;; esac
      LINK_ARGS="$LINK_ARGS $1 $2"
      shift 2
      ;;
    --replace-operator)
      REPLACE_OPERATOR="--replace-operator"
      shift
      ;;
    *) echo "install.sh: unknown argument $1 (known: --controller HOST:PORT, --pin FINGERPRINT, --replace-operator)" >&2; exit 1 ;;
  esac
done
die() { echo "install.sh: $*" >&2; exit 1; }

# offer_pairing AGENT: on an unpaired machine, ask for the controller key on
# the terminal when there is one and pair with it; otherwise, or on Enter,
# say how to pair later. `pair --check` exits 0 when the machine is paired.
offer_pairing() {
  "$1" pair --check >/dev/null 2>&1 && return 0
  echo
  key=""
  # Opening /dev/tty fails without a controlling terminal: no question then.
  # (In a subshell: a failed redirection on a special builtin ends dash.)
  if (true </dev/tty) 2>/dev/null; then
    printf 'Paste the controller key from Settings › Machines (Enter to skip): ' >/dev/tty
    IFS= read -r key </dev/tty || key=""
    key="$(printf '%s' "$key" | tr -d ' \t\r')"
  fi
  case "$key" in
    "") ;;
    *[!A-Fa-f0-9:-]*) echo "install.sh: that is not a controller key" >&2 ;;
    *) "$1" pair --pin "$key" && return 0 ;;
  esac
  echo "pair it with the controller key from Settings › Machines on the box:"
  echo "  sudo daedalus-agent pair --pin <key>"
  echo "or with \"Pair with the box…\" in the tray, where there is one"
}

command -v curl >/dev/null || die "curl is needed"

api="https://api.github.com/repos/$REPO/releases?per_page=30"

# The oldest release this script installs: the first whose machines trust
# only a controller key they were given (a pin, or `pair` as root), never
# the first that answers, and whose tray pairs only through an elevated
# `pair` — and on a Mac the first that logs in from the menu bar (set
# below). Nothing older is installed, by name or as the newest.
MIN_VERSION="0.21.0"

# at_least V: V is MIN_VERSION or newer, by the three numbers.
at_least() {
  [ "$(printf '%s\n%s\n' "$MIN_VERSION" "$1" | sort -t. -k1,1n -k2,2n -k3,3n | head -n 1)" = "$MIN_VERSION" ]
}

# Every agent-v* release's version from MIN_VERSION on, newest first. GitHub
# lists newest-first, but the sort is by the three numbers so a patch to an
# older line never wins.
agent_versions() {
  curl -fsSL -H 'Accept: application/vnd.github+json' -H 'User-Agent: daedalus-agent-install' "$api" |
    grep -o '"tag_name": *"agent-v[0-9][0-9.]*"' | sed 's/.*"agent-v\([0-9.]*\)"/\1/' |
    sort -t. -k1,1nr -k2,2nr -k3,3nr |
    while IFS= read -r v; do if at_least "$v"; then echo "$v"; fi; done
}

# Whether a release asset exists (GitHub answers a download with a redirect).
has_asset() {
  curl -fsIL -o /dev/null "https://github.com/$REPO/releases/download/$1/$2"
}

# The release's signed manifest (agent/src/update/feed.rs): release.json
# names every asset's SHA-256, and its signature is checked against the
# release key the agent carries (agent/src/update/mod.rs, the first of
# RELEASE_PUBLIC_KEYS) where this machine's openssl can check ed25519 —
# OpenSSL 3 can, macOS's LibreSSL cannot, and there the hashes alone are
# checked and trust is HTTPS to GitHub, as it always was at install.
RELEASE_KEY="27dc531d10284f3de682907886cbef2f1c380b7cd8fecd91f93691ce6f1aa62f"

# hex2bin HEX: the bytes, with nothing but printf (no xxd on a minimal system).
hex2bin() {
  for h in $(printf '%s' "$1" | sed 's/../& /g'); do
    # shellcheck disable=SC2059 # the format is the byte, by design
    printf "\\$(printf '%03o' "0x$h")"
  done
}

# fetch_manifest TAG DIR: release.json and its signature into DIR, the
# signature checked where it can be, the version its tag's.
fetch_manifest() {
  base="https://github.com/$REPO/releases/download/$1"
  curl -fsSL -o "$2/release.json" "$base/release.json" ||
    die "$1 has no signed manifest (release.json); it predates this installer"
  curl -fsSL -o "$2/release.json.sig" "$base/release.json.sig" ||
    die "$1 has no signature for its manifest"
  compact="$(tr -d ' \n\t\r' < "$2/release.json")"
  case "$compact" in
    *"\"product\":\"daedalus-agent\",\"version\":\"${1#agent-v}\",\"tag\":\"$1\""*) ;;
    *) die "$1's manifest is not daedalus-agent ${1#agent-v}'s" ;;
  esac
  if command -v openssl >/dev/null 2>&1 &&
    hex2bin "302a300506032b6570032100$RELEASE_KEY" > "$2/key.der" &&
    openssl pkey -pubin -inform DER -in "$2/key.der" -noout 2>/dev/null; then
    { printf 'daedalus-agent release manifest v1\000'; cat "$2/release.json"; } > "$2/signed.bin"
    openssl pkeyutl -verify -pubin -inkey "$2/key.der" -keyform DER -rawin \
      -in "$2/signed.bin" -sigfile "$2/release.json.sig" >/dev/null 2>&1 ||
      die "$1's manifest does not verify against the release key"
    echo "  release.json: signature verified"
  else
    echo "  release.json: this openssl cannot check ed25519; checking the hashes only"
  fi
}

# check_asset DIR FILE NAME: FILE is the manifest's NAME, by SHA-256.
check_asset() {
  want="$(tr -d ' \n\t\r' < "$1/release.json" |
    grep -o "\"name\":\"$3\",\"sha256\":\"[0-9a-f]\{64\}\"" |
    sed 's/.*"sha256":"\([0-9a-f]*\)"/\1/')"
  [ -n "$want" ] || die "the manifest names no $3"
  if command -v sha256sum >/dev/null 2>&1; then
    got="$(sha256sum "$2" | cut -d' ' -f1)"
  else
    got="$(shasum -a 256 "$2" | cut -d' ' -f1)"
  fi
  [ "$got" = "$want" ] || die "$3 does not match the release's manifest"
}

install_macos() {
  asset="daedalus-agent-universal-apple-darwin.app.zip"
  [ -z "$LINK_ARGS" ] || die "a Mac logs in from its menu bar (\"Log in…\"): --pin and --controller are for Linux"
  macos="$(sw_vers -productVersion)"
  [ "${macos%%.*}" -ge 13 ] || die "Daedalus Agent needs macOS 13 or newer; this Mac runs $macos"

  echo "looking up releases of $REPO"
  if [ -n "$VERSION" ]; then
    tag="agent-v$VERSION"
  else
    tag="$(agent_versions | head -n 1)"
    [ -n "$tag" ] || die "no agent-v* release of $REPO at $MIN_VERSION or newer yet"
    tag="agent-v$tag"
  fi
  base="https://github.com/$REPO/releases/download/$tag"
  echo "installing $tag"

  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  fetch_manifest "$tag" "$tmp"
  echo "  $asset"
  curl -fsSL -o "$tmp/app.zip" "$base/$asset"
  check_asset "$tmp" "$tmp/app.zip" "$asset"
  ditto -x -k "$tmp/app.zip" "$tmp/unpacked"
  app="$tmp/unpacked/Daedalus Agent.app"
  [ -d "$app" ] || die "$asset holds no Daedalus Agent.app"
  codesign --verify --deep --strict "$app" || die "the app's signature does not verify"

  # The app's own `install`: it copies this bundle into its place as root,
  # checks it, swaps it in, and starts both jobs (and moves an older
  # install's files out of the way). SUDO_USER names the user it serves.
  # shellcheck disable=SC2086 # empty, or the one flag
  "$app/Contents/MacOS/daedalus-agent" install $REPLACE_OPERATOR
  echo
  echo "installed $tag. Status: daedalus-agent status"
  echo "logs: /Library/Application Support/daedalus-agent/logs (the service), ~/Library/Logs/daedalus-agent (the menu bar app)"
  echo "nothing listens on the LAN; the box hears from this Mac through its own tunnel, once it logs in"
  echo
  echo "Log in from the menu bar: the daedalus mark › \"Log in…\"."
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
    [ -n "$versions" ] || die "no agent-v* release of $REPO at $MIN_VERSION or newer yet"
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
  fetch_manifest "$tag" "$tmp"
  echo "  $asset"
  curl -fsSL -o "$tmp/daedalus-agent" "$base/$asset"
  check_asset "$tmp" "$tmp/daedalus-agent" "$asset"
  chmod 755 "$tmp/daedalus-agent"
  if [ -n "$tray_asset" ] && curl -fsSL -o "$tmp/daedalus-agent-tray" "$base/$tray_asset" 2>/dev/null; then
    echo "  $tray_asset"
    check_asset "$tmp" "$tmp/daedalus-agent-tray" "$tray_asset"
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
  offer_pairing "$BIN/daedalus-agent"
}

case "$(uname -s)" in
  Darwin) os=macos ;;
  Linux) os=linux ;;
  *) die "this installer is for macOS and Linux; Windows uses install.ps1" ;;
esac
[ -z "$REPLACE_OPERATOR" ] || [ "$os" = macos ] || die "--replace-operator is for a Mac"
if [ "$(id -u)" != 0 ]; then
  [ "$os" = macos ] && die "run it with sudo: the service and the launchd jobs need root"
  die "run it with sudo: the service and its systemd units need root"
fi
# A Mac's agent is an app from 0.24.0 on: nothing older there.
[ "$os" = macos ] && MIN_VERSION="0.24.0"
if [ -n "$VERSION" ] && ! at_least "$VERSION"; then
  die "agent $VERSION is older than $MIN_VERSION, the oldest this installer puts on a $os machine"
fi

if [ "$os" = macos ]; then install_macos; else install_linux; fi
