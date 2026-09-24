# The `claude` CLI — which nixpkgs it comes from, and how it gets ahead of
# nixpkgs when it has to.
#
# Base: pkgs.claude-code from the pinned nixos-unstable input (stable nixpkgs
# lags ~6 months), locked in flake.lock and moved by `nix flake update` /
# flake-autoupgrade.timer. That is the normal and preferred path, and the
# wrapper at the bottom of this file is what makes it the ONLY path: the
# store binary is sealed with DISABLE_UPDATES, so a flake bump is the one
# thing that moves it. (The packaged expression's DISABLE_AUTOUPDATER is not
# enough on its own — see the comment on the wrapper for what that gap cost.)
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
# It is a ratchet, not a pin: the condition below goes false on its own as
# soon as nixpkgs catches up, and the file becomes dead weight rather than a
# silent freeze. Deleting it then is a cleanup, never a fix. **Dormant is the
# resting state** — as of 2026-09-23 the manifest names 2.1.259 and nixpkgs
# carries 2.1.276, so the override is inert and the packaged expression is
# what builds. Re-arming it, by fetching a manifest newer than nixpkgs has,
# is what daedalus's System › Claude "Update Claude Code" button does.
#
# To move the pin (or to re-pin after nixpkgs has passed it) — in a checkout
# of THIS repo (`<engine>`), where the file lives beside this module:
#
#   V=$(curl -fsSL https://downloads.claude.ai/claude-code-releases/latest)
#   curl -fsSL "https://downloads.claude.ai/claude-code-releases/$V/manifest.json" \
#     -o <engine>/nix/platform/claude-code/manifest.json
#   git -C <engine> add nix/platform/claude-code/manifest.json
#
# then commit + push, `nix flake update daedalus` in the host's configuration,
# and rebuild. Nothing else needs editing — the version is read from the file.
#
# What a rebuild does NOT do is put the new binary in front of anyone already
# running the old one. A switch installs it into the operator's profile (new
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
        chosen =
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
      in
      {
        # Sealed, because `DISABLE_AUTOUPDATER` does not seal it. That
        # variable — which the packaged expression sets — stops the
        # BACKGROUND check and nothing else; upstream's own documentation is
        # explicit that "`claude update` and `claude install` still work",
        # and that `DISABLE_UPDATES` is the one to set "when you distribute
        # Claude Code through your own channels and need users to stay on
        # the version you provide". That is exactly this box.
        #
        # What the gap costs, measured here on 2026-09-23: a single
        # `claude update` reported success, left the store binary untouched,
        # and installed a SECOND, native copy under
        # `~/.local/share/claude/versions/` with a launcher at
        # `~/.local/bin/claude` — 143 MB that no rebuild knows about, no
        # generation reverts, and nothing but `claude doctor` would ever
        # mention. It was inert only because `~/.local/bin` happens not to
        # be on this box's PATH and the unit names its ExecStart by store
        # path. On a host where either is untrue it silently becomes the
        # `claude` everyone runs, frozen against the flake forever.
        #
        # Wrapped rather than set in a settings file: this applies to every
        # invocation of the binary — the operator's shell, the remote-control
        # unit, each `claude-session@`, and the snapshot's `claude agents`
        # — without nix writing into `~/.claude`, which is the CLI's own
        # state directory. `version` is carried across because
        # stacks/daedalus bakes `pkgs.claude-code.version` into the snapshot
        # as "what the flake holds"; `mainProgram` because `lib.getExe` is
        # how claude-rc.nix and the session runner reach it.
        # Built by `unstable`, not by `prev`: the wrapper belongs to the same
        # package set as the thing it wraps, and that is the instance whose
        # config allows this unfree package. Through `prev` the outer
        # derivation inherits the HOST's nixpkgs config instead, and a host
        # that has not set `allowUnfree` — the template one that
        # `nix flake check` evaluates, for instance — fails to evaluate.
        claude-code = unstable.symlinkJoin {
          name = "claude-code-${chosen.version}";
          paths = [ chosen ];
          nativeBuildInputs = [ unstable.makeWrapper ];
          postBuild = ''
            wrapProgram $out/bin/claude --set DISABLE_UPDATES 1
          '';
          inherit (chosen) version;
          meta = chosen.meta // {
            mainProgram = "claude";
          };
        };
      }
    )
  ];
}
