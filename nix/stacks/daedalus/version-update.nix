# daedalus-version-update — the host side of daedalus's `version-update`
# bridge verb: moving a version a stack pins as a plain string rather than as
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
# The app drops `version-request.json` into the apply dir; this unit rewrites
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
  esc = lib.escapeShellArg;

  applyDir = "${config.fleet.stateRoot}/apps/daedalus/apply";

  # The registry as the agent reads it: the allowlist and the parse at once,
  # like image-update's PINS. Rendered from the running config, so it cannot
  # name a pin this box does not have.
  pins = lib.mapAttrs (_: p: {
    inherit (p) container dataset;
    fields = lib.mapAttrs (_: f: { inherit (f) binding value pattern; }) p.fields;
    verify = if p.verify == null then null else "${p.verify}";
  }) config.fleet.versionPins;

  updateScript = pkgs.writeShellApplication {
    name = "daedalus-version-update";
    runtimeInputs = [
      pkgs.jq
      pkgs.git
      pkgs.gnugrep
      pkgs.gnused
      pkgs.util-linux # setpriv, flock
      pkgs.coreutils
      pkgs.gawk # lib.sh log_errtail
      pkgs.nixos-rebuild
      pkgs.openssh # git push over ssh
      pkgs.systemd # systemctl stop, before a rollback
      config.boot.zfs.package
    ];
    text = ''
      APPLY_DIR=${esc applyDir}
      FLAKE=${esc config.fleet.config.repo}
      SITE_DIR=${esc config.fleet.site.path}
      PINS=${pkgs.writeText "daedalus-version-pins.json" (builtins.toJSON pins)}
      LOCKFILE=${esc config.fleet.rebuildLock}
      HOSTNAME=${esc config.networking.hostName}
      GIT_EMAIL=${esc config.fleet.mail.sender}
      GIT_OPERATOR_NAME=${esc config.fleet.operator.gitName}
      GIT_OPERATOR_EMAIL=${esc config.fleet.operator.gitEmail}
      OPERATOR_USER=${esc config.fleet.operator.user}
      OPERATOR_GROUP=${esc config.fleet.operator.group}
      OPERATOR_HOME=${esc config.users.users.${config.fleet.operator.user}.home}
      OPERATOR_RUNTIME_DIR=${esc config.fleet.operator.runtimeDir}
      SETPRIV=${pkgs.util-linux}/bin/setpriv
      ENV_BIN=${pkgs.coreutils}/bin/env
      PODMAN=${pkgs.podman}/bin/podman

      ${builtins.readFile ./host/lib.sh}
      ${builtins.readFile ./host/version-update.sh}
    '';
  };

  # The status file's undertaker, as for the other rebuilding verbs.
  updateReaper = pkgs.writeShellApplication {
    name = "daedalus-version-update-reaper";
    runtimeInputs = [
      pkgs.jq
      pkgs.coreutils
    ];
    text = ''
      STATUS=${esc "${applyDir}/version-status.json"}
      OPERATOR_USER=${esc config.fleet.operator.user}
      OPERATOR_GROUP=${esc config.fleet.operator.group}
      SETPRIV=${pkgs.util-linux}/bin/setpriv

      ${builtins.readFile ./host/lib.sh}

      [ "''${SERVICE_RESULT:-success}" = "success" ] && exit 0
      [ -f "$STATUS" ] || exit 0
      status_json="$(read_as_operator "$STATUS")" || exit 0
      [ "$(jq -r '.state // ""' <<<"$status_json")" = "running" ] || exit 0

      jq --arg r "''${SERVICE_RESULT:-unknown}" '
        .state = "failed"
        | .finishedAt = (now | todate)
        | .error = "the host agent died during \"" + (.phase // "?") + "\" (" + $r
            + ") without reporting a result. Check `journalctl -u daedalus-version-update`,"
            + " `git log` in ${config.fleet.config.repo}"
            + (if (.snapshot // "") != "" then ", and whether the container still runs — the pre-update snapshot is " + .snapshot else "" end)
            + "."
      ' <<<"$status_json" | write_json_atomic "$STATUS"
    '';
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

  config = lib.mkIf config.fleet.modules.daedalus.enable {
    systemd.services.daedalus-version-update = {
      description = "Move a stack's pinned version and rebuild, on daedalus's behalf";
      after = [
        "network-online.target"
        "linger-users.service"
      ];
      wants = [ "network-online.target" ];
      # daedalus.nix's bridgeAgent: a path unit makes each request a start.
      startLimitIntervalSec = 0;
      # PINS embeds the values it just moved, so the switch changes this unit;
      # restarted by that switch it would lose its verify and push phases.
      restartIfChanged = false;
      serviceConfig = {
        Type = "oneshot";
        ExecStart = "${updateScript}/bin/daedalus-version-update";
        ExecStopPost = "${updateReaper}/bin/daedalus-version-update-reaper";
        # A build, two switch attempts, a verifier that may wait out a world
        # conversion, and a rollback. RUNNING_MAX_MS in
        # app/src/host/version-update.ts is this plus slack.
        TimeoutStartSec = "60min";
      };
    };

    systemd.paths.daedalus-version-update = {
      description = "Watch for a daedalus version update request";
      wantedBy = [ "multi-user.target" ];
      pathConfig.PathChanged = "${applyDir}/version-request.json";
    };

    fleet.monitoredJobs.daedalus-version-update = { };
  };
}
