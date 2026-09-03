# The `claude` CLI — which nixpkgs it comes from, and how it gets ahead of
# nixpkgs when it has to.
#
# Base: pkgs.claude-code from the pinned nixos-unstable input (stable nixpkgs
# lags ~6 months), locked in flake.lock and moved by `nix flake update` /
# flake-autoupgrade.timer. That is the normal and preferred path — the store
# binary cannot self-update (the package sets DISABLE_AUTOUPDATER), so a flake
# bump is the only thing that moves it.
#
# The override below exists because that path has a second, invisible
# bottleneck: nixos-unstable is a Hydra-gated channel, so `nix flake update`
# can land on the newest possible rev and STILL carry a stale claude-code.
# It did exactly that in 2026-09 — nixpkgs sat on 2.1.245 for eight days
# while nine releases shipped, because claude-code's distribution moved to a
# zstd-compressed artifact and the reworked package had not left master yet.
# From the outside this is indistinguishable from a failed upgrade: the timer
# is green, the lock is current, the version does not move.
#
# ./manifest.json is upstream's own release manifest — the exact file
# nixpkgs' update.sh vendors, carrying the version and the per-platform
# checksums. Pointing the packaged expression at a newer copy of it is the
# supported override (the `manifest ? lib.importJSON ./manifest.json`
# argument exists for this), and it stays reproducible: the checksums are
# committed, so this pin builds the same binary on any checkout.
#
# It is a ratchet, not a pin: `usePinned` below goes false on its own as soon
# as nixpkgs catches up, and the file becomes dead weight rather than a
# silent freeze. Deleting it then is a cleanup, never a fix.
#
# To move the pin (or to re-pin after nixpkgs has passed it):
#
#   V=$(curl -fsSL https://downloads.claude.ai/claude-code-releases/latest)
#   curl -fsSL "https://downloads.claude.ai/claude-code-releases/$V/manifest.json" \
#     -o /etc/nixos/platform/claude-code/manifest.json
#   git -C /etc/nixos add platform/claude-code/manifest.json
#
# then rebuild. Nothing else needs editing — the version is read from the file.
#
# What a rebuild does NOT do is put the new binary in front of anyone already
# running the old one. A switch installs it into santiago's profile (new
# shells get it) and stops there: `claude-remote-control` deliberately carries
# `restartIfChanged = false` (see ../claude-rc.nix for the murder-suicide that
# bought that line), so remote sessions keep the version they started on until
# the next reboot or an explicit restart of that unit — which kills every live
# session, including the one that typed it. daedalus's Updates page has the
# button, and is the right place to press it from.
{
  lib,
  nixpkgs-unstable,
  ...
}:
{
  nixpkgs.overlays = [
    (
      _final: prev:
      let
        unstable = import nixpkgs-unstable {
          inherit (prev.stdenv.hostPlatform) system;
          config.allowUnfree = true;
        };
        packaged = unstable.claude-code;
        pinned = lib.importJSON ./manifest.json;
      in
      {
        claude-code =
          if
            # Only ever move forward...
            lib.versionOlder packaged.version pinned.version
            # ...and only while the packaged expression still fetches the
            # plain binary this manifest names. When nixpkgs adopts the
            # zstd artifact it will want a manifest whose `binary` is
            # `claude.zst`; feeding it this one would fetch an
            # uncompressed file and fail in `unzstd`. Falling back to a
            # slightly older nixpkgs is the safe side of that trade.
            && !lib.hasSuffix ".zst" (builtins.head packaged.src.urls)
          then
            packaged.override { manifest = pinned; }
          else
            packaged;
      }
    )
  ];
}
