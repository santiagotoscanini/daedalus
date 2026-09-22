# daedalus-engine-update — the host side of daedalus's `engine-update` bridge
# verb: the engine's own upgrade path.
#
# The engine reaches a box as the configuration's `daedalus` flake input,
# pinned by rev in its flake.lock, and nothing moves that pin on its own: the
# weekly upgrade names the inputs it touches and the engine is not one of
# them (platform/autoupgrade). This is the deliberate move, done the way
# System › Updates moves an image — the app drops `engine-request.json` into
# the apply dir, this unit fast-forwards the engine clone, asks nix to
# re-resolve the input, builds, commits the lock, switches, verifies that the
# control plane answers again, reverts if it does not, and pushes.
# host/engine-update.sh opens with what "latest" means and what it refuses.
#
# Its own module beside daedalus.nix, like build-agent.nix: a verb with a
# script, a unit, a path unit and a reaper is a page of nix, and daedalus.nix
# is long enough. Gated like the control plane itself.
#
# What it reads from elsewhere, and why each is a derivation rather than a copy:
#   FLAKE, SITE_DIR   fleet.config.repo and fleet.site.path — where the lock
#                     and site.json live. The override it refuses on is read
#                     from site.json at run time, never from nix (nix does not
#                     read that key; an Apply that sets it is already governed
#                     by it — host/apply.sh).
#   CONTROL_PLANE_HOST, HEALTH_PATH
#                     fleet.apps.daedalus — the address and health path the
#                     control plane publishes, which is what "came back" is
#                     checked against, through the proxy on fleet.lanIp.
#   applyDir          the same literal daedalus.nix and build-agent.nix
#                     derive from fleet.stateRoot.

{
  config,
  lib,
  pkgs,
  ...
}:

let
  esc = lib.escapeShellArg;

  applyDir = "${config.fleet.stateRoot}/apps/daedalus/apply";

  operatorVars = ''
    OPERATOR_USER=${esc config.fleet.operator.user}
    OPERATOR_GROUP=${esc config.fleet.operator.group}
    OPERATOR_HOME=${esc config.users.users.${config.fleet.operator.user}.home}
    SETPRIV=${pkgs.util-linux}/bin/setpriv
    ENV_BIN=${pkgs.coreutils}/bin/env
    GIT=${pkgs.git}/bin/git
  '';

  updateScript = pkgs.writeShellApplication {
    name = "daedalus-engine-update";
    runtimeInputs = [
      pkgs.jq
      pkgs.git
      pkgs.curl
      pkgs.gnugrep
      pkgs.util-linux # setpriv, flock
      pkgs.coreutils
      pkgs.gawk # lib.sh log_errtail
      pkgs.nixos-rebuild
      pkgs.openssh # git fetch and push over ssh, as the operator
    ];
    text = ''
      APPLY_DIR=${esc applyDir}
      FLAKE=${esc config.fleet.config.repo}
      SITE_DIR=${esc config.fleet.site.path}
      LOCKFILE=${esc config.fleet.rebuildLock}
      HOSTNAME=${esc config.networking.hostName}
      GIT_EMAIL=${esc config.fleet.mail.sender}
      CONTROL_PLANE_HOST=${esc config.fleet.apps.daedalus.hostname}
      HEALTH_PATH=${esc config.fleet.apps.daedalus.auth.healthPath}
      LAN_IP=${esc config.fleet.lanIp}
      ${operatorVars}
      ${builtins.readFile ./host/lib.sh}
      ${builtins.readFile ./host/engine-update.sh}
    '';
  };

  # The status file's undertaker — daedalus.nix's imageUpdateReaper, for this
  # verb. The agent writes its own terminal state; this fires when it could
  # not (killed, out of memory, dead on a line nobody tested), so a crashed
  # run reads `failed` within seconds instead of after the app's staleness
  # clock, during which the flow would refuse every new request as busy.
  updateReaper = pkgs.writeShellApplication {
    name = "daedalus-engine-update-reaper";
    runtimeInputs = [
      pkgs.jq
      pkgs.coreutils
    ];
    text = ''
      STATUS=${esc "${applyDir}/engine-status.json"}
      OPERATOR_USER=${esc config.fleet.operator.user}
      OPERATOR_GROUP=${esc config.fleet.operator.group}
      SETPRIV=${pkgs.util-linux}/bin/setpriv

      ${builtins.readFile ./host/lib.sh}

      # $SERVICE_RESULT is systemd's, set for ExecStopPost. A clean exit is the
      # overwhelmingly common case and has nothing to do here.
      [ "''${SERVICE_RESULT:-success}" = "success" ] && exit 0
      [ -f "$STATUS" ] || exit 0

      # Read once, as the operator and never through a link — the status sits
      # in the container's directory (host/lib.sh) — and rewritten from that
      # copy. Unreadable means there is nothing trustworthy to mark failed.
      status_json="$(read_as_operator "$STATUS")" || exit 0
      [ "$(jq -r '.state // ""' <<<"$status_json")" = "running" ] || exit 0

      jq --arg r "''${SERVICE_RESULT:-unknown}" '
        .state = "failed"
        | .finishedAt = (now | todate)
        | .error = "the host agent died during \"" + (.phase // "?") + "\" (" + $r
            + ") without reporting a result. Nothing was necessarily committed — check"
            + " `journalctl -u daedalus-engine-update` and `git log` in ${config.fleet.config.repo}."
      ' <<<"$status_json" | write_json_atomic "$STATUS"
    '';
  };
in

{
  config = lib.mkIf config.fleet.modules.daedalus.enable {
    # The sibling of daedalus-image-update: it takes the shared rebuild lock,
    # commits to the flake, and switches the system. What is different is the
    # file it moves — flake.lock — and the second tree it touches, the engine
    # clone the control plane runs out of.
    systemd.services.daedalus-engine-update = {
      description = "Move the engine's flake pin and rebuild, on daedalus's behalf";
      after = [
        "network-online.target"
        "linger-users.service"
      ];
      wants = [ "network-online.target" ];

      # The one property every bridge agent shares (daedalus.nix, bridgeAgent):
      # a path unit makes each request a start, and systemd's default start
      # limit would silently drop the next request after a burst.
      startLimitIntervalSec = 0;

      # A unit that runs `nixos-rebuild switch` must not be restarted BY that
      # switch — and this one moves the whole engine input, so its own
      # ExecStart (the script text this file embeds) changes on exactly the
      # commits it applies. Without this, switch-to-configuration restarts it
      # mid-run, and the update loses its verify and push phases with the
      # status stuck on "running". The next request gets the new definition.
      restartIfChanged = false;

      serviceConfig = {
        Type = "oneshot";
        ExecStart = "${updateScript}/bin/daedalus-engine-update";
        ExecStopPost = "${updateReaper}/bin/daedalus-engine-update-reaper";
        # A fetch, a build of the whole system against a new engine, two
        # switch attempts and a verify that may wait ten minutes for a dev
        # server to reinstall. RUNNING_MAX_MS in app/src/host/engine-update.ts
        # is this plus slack; the two move together.
        TimeoutStartSec = "60min";
      };
    };

    systemd.paths.daedalus-engine-update = {
      description = "Watch for a daedalus engine update request";
      wantedBy = [ "multi-user.target" ];
      # Fires on the rename the app publishes the request with.
      pathConfig.PathChanged = "${applyDir}/engine-request.json";
    };

    # A failed update means the box may have been rolled back without anyone
    # watching the page that started it — the page it restarts, no less.
    fleet.monitoredJobs.daedalus-engine-update = { };
  };
}
