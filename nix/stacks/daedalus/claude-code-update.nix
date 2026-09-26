# daedalus-claude-code-update — the host side of the `claude-code-update`
# bridge verb: moving the Claude Code pin this box's CLI is built from.
#
# platform/claude-code/ seals the store binary with DISABLE_UPDATES, so
# `claude update` is not a path here and a flake bump is the only one. That
# bump starts in the ENGINE — `nix/platform/claude-code/manifest.zst.json`, which
# the packaged expression takes as its `manifest` argument — and only then
# reaches the configuration's lock. So this verb does the first half and hands
# the second to `daedalus-engine-update` by publishing the very request file
# System › Updates writes. host/claude-code-update.sh opens with what "latest"
# means, why the signature is checked, and what makes it refuse.
#
# Its own module beside engine-update.nix, and for the same reason: a verb
# with a script, a unit, a path unit and a reaper is a page of nix.
#
# What it reads from elsewhere:
#   FLAKE       fleet.config.repo — the lock that names the engine clone. The
#               clone's path is read from the lock at run time, never from
#               nix, because nix has no opinion about where the operator put
#               it and the lock is what actually decides.
#   GIT_EMAIL,
#   HOSTNAME    the identity of the commit it makes in the engine.
#   applyDir    daedalus-lib.nix's, like every other bridge agent's.

{
  config,
  lib,
  pkgs,
  ...
}:

let
  esc = lib.escapeShellArg;

  inherit (import ./daedalus-lib.nix { inherit config lib pkgs; })
    applyDir
    mkAgent
    operatorHomeVars
    commitVars
    ;

  updateScript = mkAgent {
    name = "daedalus-claude-code-update";
    runtimeInputs = [
      pkgs.jq
      pkgs.git
      pkgs.curl
      pkgs.gnupg # the release manifest's detached signature
      pkgs.gnugrep
      pkgs.util-linux # setpriv
      pkgs.coreutils
      pkgs.gawk # lib.sh log_errtail
      pkgs.openssh # git push, as the operator
    ];
    vars =
      operatorHomeVars
      // commitVars
      // {
        APPLY_DIR = applyDir;
        FLAKE = config.fleet.config.repo;
        SITE_DIR = config.fleet.site.path;
        HOSTNAME = config.networking.hostName;
        GIT = "${pkgs.git}/bin/git";
      };
    files = [
      ./host/lib.sh
      ./host/claude-code-update.sh
    ];
  };

  # engine-update.nix's reaper, for this verb's status file. The agent writes
  # its own terminal state; this fires when it could not, so a crashed run
  # reads `failed` within seconds rather than after the app's staleness clock.
  updateReaper = pkgs.writeShellApplication {
    name = "daedalus-claude-code-update-reaper";
    runtimeInputs = [
      pkgs.jq
      pkgs.coreutils
    ];
    text = ''
      STATUS=${esc "${applyDir}/claude-code-status.json"}
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
            + ") without reporting a result. Check `journalctl -u"
            + " daedalus-claude-code-update` and `git log` in the engine clone"
            + " before retrying."
      ' <<<"$status_json" | write_json_atomic "$STATUS"
    '';
  };
in

{
  config = lib.mkIf config.fleet.modules.daedalus.enable {
    systemd.services.daedalus-claude-code-update = {
      description = "Pin a newer Claude Code release in the engine, on daedalus's behalf";
      after = [
        "network-online.target"
        "linger-users.service"
      ];
      wants = [ "network-online.target" ];

      # Every bridge agent's one property (daedalus-lib.nix, bridgeAgent): a path
      # unit makes each request a start, and systemd's default start limit
      # would silently drop the next request after a burst.
      startLimitIntervalSec = 0;

      # This one does NOT rebuild — it hands that to daedalus-engine-update —
      # so it never runs inside the switch it caused. It still carries the
      # flag, because it lives in the engine and a bump it makes is exactly
      # the kind of commit that changes its own ExecStart; being restarted
      # between the push and the handoff would leave a pinned engine with
      # nothing asking for the rebuild.
      restartIfChanged = false;

      serviceConfig = {
        Type = "oneshot";
        ExecStart = "${updateScript}/bin/daedalus-claude-code-update";
        ExecStopPost = "${updateReaper}/bin/daedalus-claude-code-update-reaper";
        # Three small fetches, a signature check and a push. Nothing here
        # builds; the long budget belongs to the engine verb this hands to.
        TimeoutStartSec = "10min";
      };
    };

    systemd.paths.daedalus-claude-code-update = {
      description = "Watch for a Claude Code pin request";
      wantedBy = [ "multi-user.target" ];
      pathConfig.PathChanged = "${applyDir}/claude-code-request.json";
    };

    # A failure here can leave a pushed engine commit that nothing asked to
    # be built — worth an email rather than a status nobody reloads.
    fleet.monitoredJobs.daedalus-claude-code-update = { };
  };
}
