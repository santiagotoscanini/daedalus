# daedalus-claude-code-update — the host side of the root helper's
# `claude-code-update` verb: moving the Claude Code pin this box's CLI is
# built from.
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
# with a script, a unit and a reaper is a page of nix.
#
# What it reads from elsewhere:
#   FLAKE       fleet.config.repo — the lock that names the engine clone. The
#               clone's path is read from the lock at run time, never from
#               nix, because nix has no opinion about where the operator put
#               it and the lock is what actually decides.
#   GIT_EMAIL,
#   HOSTNAME    the identity of the commit it makes in the engine.
#   applyDir    where the engine update's request goes (the handoff).

{
  config,
  lib,
  pkgs,
  ...
}:

let
  inherit (import ./daedalus-lib.nix { inherit config lib pkgs; })
    applyDir
    workspacesDir
    mkUpdateReaper
    mkAgent
    mkRootVerb
    verbsDir
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
      pkgs.util-linux # setpriv, flock
      pkgs.coreutils
      pkgs.gawk # lib.sh log_errtail
      pkgs.openssh # git push, as the operator
    ];
    vars =
      operatorHomeVars
      // commitVars
      // {
        # The engine update it hands to is still a bridge verb.
        APPLY_DIR = applyDir;
        VERBS_DIR = verbsDir;
        FLAKE = config.fleet.config.repo;
        SITE_DIR = config.fleet.site.path;
        HOSTNAME = config.networking.hostName;
        # The workspace lock the clone is mutated under (host/lib.sh).
        WORKSPACES_DIR = workspacesDir;
      };
    files = [
      ./host/lib.sh
      ./host/claude-code-update.sh
    ];
  };

  # The status file's undertaker (host/update-reaper.sh), shared by every
  # rebuilding verb.
  updateReaper = mkUpdateReaper {
    name = "daedalus-claude-code-update-reaper";
    dir = verbsDir;
    statusFile = "claude-code-update-status.json";
    nextSteps = "Check `journalctl -u 'daedalus-claude-code-update@*'` and `git log` in the engine clone before retrying";
  };
in

{
  # This one does NOT rebuild — it hands that to the engine update — so it
  # never runs inside the switch it caused. mkRootVerb's `restartIfChanged =
  # false` still matters: it lives in the engine, and a bump it makes is
  # exactly the kind of commit that changes its own ExecStart; restarted
  # between the push and the handoff it would leave a pinned engine with
  # nothing asking for the rebuild. A failure here can leave a pushed engine
  # commit that nothing asked to be built — worth an email rather than a
  # status nobody reloads.
  config = lib.mkIf config.fleet.modules.daedalus.enable (mkRootVerb {
    verb = "claude-code-update";
    unit = "daedalus-claude-code-update";
    description = "Pin a newer Claude Code release in the engine, on daedalus's behalf";
    verbDescription = "Pin upstream's latest Claude Code in the engine and hand the rebuild to the engine update";
    script = updateScript;
    # Three small fetches, a signature check and a push. Nothing here
    # builds; the long budget belongs to the engine verb this hands to.
    timeoutStartSec = 10 * 60;
    # `{actor}`: nothing to choose.
    payloadMax = 1024;
    execStopPost = [ "${updateReaper}/bin/daedalus-claude-code-update-reaper" ];
    unitAttrs = {
      after = [
        "network-online.target"
        "linger-users.service"
      ];
      wants = [ "network-online.target" ];
    };
  });
}
