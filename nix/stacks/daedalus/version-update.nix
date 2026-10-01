# daedalus-version-update — the host side of the root helper's `version-update`
# verb: moving a version a stack pins as a plain string rather than as
# an image digest.
#
# Some stacks run a version their image does not carry: the image downloads
# it on start (a game server's jar, a headless binary), so the string in the
# stack's nix IS the running version, and System › Updates — which moves
# digests — has nothing to offer for it. A stack that wants its page to move
# that string declares it in `fleet.versionPins.<id>`: which `let` bindings
# hold the values, what a value may look like, which container runs it, how
# to prove the new version came up, and optionally the ZFS dataset whose
# contents the new version may convert irreversibly.
#
# The app asks the helper, the request its payload; this unit rewrites
# the bindings, commits, builds, snapshots the dataset, switches, runs the
# stack's verifier, and on any failure after the switch stops the container,
# rolls the dataset back to that snapshot, reverts the commit and switches
# back. host/version-update.sh has the reasoning.
#
# Its own module beside engine-update.nix, for the reason that one gives. The
# registry is declared ungated, like every registry a stack writes to.

{
  config,
  lib,
  pkgs,
  ...
}:

let
  inherit (import ./daedalus-lib.nix { inherit config lib pkgs; })
    verbsDir
    mkUpdateReaper
    mkAgent
    mkRootVerb
    operatorHomeVars
    commitVars
    ;

  # The registry as the agent reads it: the allowlist and the parse at once,
  # like image-update's PINS. Rendered from the running config, so it cannot
  # name a pin this box does not have.
  pins = lib.mapAttrs (_: p: {
    inherit (p) container dataset;
    fields = lib.mapAttrs (_: f: { inherit (f) binding value pattern; }) p.fields;
    verify = if p.verify == null then null else "${p.verify}";
  }) config.fleet.versionPins;

  updateScript = mkAgent {
    name = "daedalus-version-update";
    runtimeInputs = [
      pkgs.jq
      pkgs.git
      pkgs.gnugrep
      pkgs.gnused
      pkgs.util-linux # setpriv, flock
      pkgs.coreutils
      pkgs.gawk # lib.sh log_errtail
      config.system.build.nixos-rebuild # the system's own: ng, named nixos-rebuild
      config.fleet.upgradeGuard.package # fleet-switch-guard (host/lib.sh)
      pkgs.openssh # git push over ssh
      pkgs.systemd # systemctl stop, before a rollback
      config.boot.zfs.package
    ];
    vars =
      operatorHomeVars
      // commitVars
      // {
        VERBS_DIR = verbsDir;
        FLAKE = config.fleet.config.repo;
        SITE_DIR = config.fleet.site.path;
        PINS = pkgs.writeText "daedalus-version-pins.json" (builtins.toJSON pins);
        LOCKFILE = config.fleet.rebuildLock;
        HOSTNAME = config.networking.hostName;
        OPERATOR_RUNTIME_DIR = config.fleet.operator.runtimeDir;
        PODMAN = "${pkgs.podman}/bin/podman";
      };
    files = [
      ./host/lib.sh
      ./host/version-update.sh
    ];
  };

  # The status file's undertaker (host/update-reaper.sh), shared by every
  # rebuilding verb.
  updateReaper = mkUpdateReaper {
    name = "daedalus-version-update-reaper";
    dir = verbsDir;
    statusFile = "version-update-status.json";
    nextSteps = "Check `journalctl -u 'daedalus-version-update@*'`, `git log` in ${config.fleet.config.repo}";
  };
in

{
  options.fleet.versionPins = lib.mkOption {
    type = lib.types.attrsOf (
      lib.types.submodule {
        options = {
          container = lib.mkOption {
            type = lib.types.str;
            description = "The container that runs this version; stopped before a rollback.";
          };
          fields = lib.mkOption {
            type = lib.types.attrsOf (
              lib.types.submodule {
                options = {
                  binding = lib.mkOption {
                    type = lib.types.strMatching "[A-Za-z_][A-Za-z0-9_]*";
                    description = ''
                      The `let` binding holding the value, written in the stack
                      as `<binding> = "<value>";` on a line of its own. The agent
                      finds it by that exact line and refuses one it finds
                      twice or not at all.
                    '';
                  };
                  value = lib.mkOption {
                    type = lib.types.str;
                    description = "The value now — the binding itself, read back.";
                  };
                  pattern = lib.mkOption {
                    type = lib.types.str;
                    description = "An extended regex (anchored by the agent) a new value must match. It reaches a nix string literal.";
                  };
                };
              }
            );
            description = "The strings that are the version, by field name.";
          };
          dataset = lib.mkOption {
            type = lib.types.nullOr lib.types.str;
            default = null;
            description = ''
              A ZFS dataset the new version may convert irreversibly (a game
              world). Snapshotted before the switch, and rolled back to that
              snapshot — with the container stopped — if the update fails after
              it. Null when a failed version leaves nothing behind to undo.
            '';
          };
          verify = lib.mkOption {
            type = lib.types.nullOr lib.types.path;
            default = null;
            description = ''
              An executable run as root after the switch, with `NEW_<FIELD>`
              (upper-cased) in its environment. Exit 0 means the new version is
              up; anything else fails the update and rolls it back. It owns its
              own patience — the agent waits up to 20 minutes. Null checks only
              that the container is running.
            '';
          };
        };
      }
    );
    default = { };
    description = "Versions a stack pins as plain strings, movable from daedalus (host/version-update.sh).";
  };

  # The values it just moved are in PINS, so a switch changes this unit;
  # mkRootVerb keeps that switch from restarting the run (and losing its
  # verify and rollback).
  config = lib.mkIf config.fleet.modules.daedalus.enable (mkRootVerb {
    verb = "version-update";
    unit = "daedalus-version-update";
    description = "Move a stack's pinned version and rebuild, on daedalus's behalf";
    verbDescription = "Move a stack's pinned version strings and rebuild onto them";
    script = updateScript;
    # A build, two switch attempts, a verifier that may wait out a world
    # conversion, and a rollback.
    timeoutStartSec = 60 * 60;
    # `{target, values, actor}`: a few short strings.
    payloadMax = 4096;
    execStopPost = [ "${updateReaper}/bin/daedalus-version-update-reaper" ];
    unitAttrs = {
      after = [
        "network-online.target"
        "linger-users.service"
      ];
      wants = [ "network-online.target" ];
    };
  });
}
