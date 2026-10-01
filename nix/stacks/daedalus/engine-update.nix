# daedalus-engine-update — the host side of the root helper's `engine-update`
# verb: the engine's own upgrade path.
#
# The engine reaches a box as the configuration's `daedalus` flake input,
# pinned by rev in its flake.lock, and nothing moves that pin on its own: the
# weekly upgrade names the inputs it touches and the engine is not one of
# them (platform/autoupgrade). This is the deliberate move, done the way
# System › Updates moves an image — the app asks the root helper, and this
# unit fast-forwards the engine clone, asks nix to re-resolve the input,
# builds, commits the lock, switches, verifies that the control plane answers
# again, reverts if it does not, and pushes.
# host/engine-update.sh opens with what "latest" means and what it refuses.
#
# Its own module beside daedalus.nix, like build-agent.nix: a verb with a
# script, a unit and a reaper is a page of nix, and daedalus.nix is long
# enough. Gated like the control plane itself.
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

{
  config,
  lib,
  pkgs,
  ...
}:

let
  inherit (import ./daedalus-lib.nix { inherit config lib pkgs; })
    verbsDir
    workspacesDir
    mkUpdateReaper
    mkAgent
    mkRootVerb
    operatorHomeVars
    commitVars
    ;

  # The first half of the `claude-code-update` verb (host/claude-code-update.sh,
  # which opens with what "latest" means, why the signature is checked and
  # what makes it refuse): moving the Claude Code pin this box's CLI is built
  # from, in the ENGINE — `nix/platform/claude-code/manifest.zst.json`, which
  # platform/claude-code/ seals with DISABLE_UPDATES so that nothing else can
  # move it. Run by updateScript as its child; the clone's path is read from
  # the lock at run time, never from nix.
  pinScript = mkAgent {
    name = "daedalus-claude-code-pin";
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

  pinReaper = mkUpdateReaper {
    name = "daedalus-claude-code-pin-reaper";
    statusFile = "claude-code-update-status.json";
    nextSteps = "Check `journalctl -u 'daedalus-engine-update@*'` and `git log` in the engine clone before retrying";
  };
  updateScript = mkAgent {
    name = "daedalus-engine-update";
    runtimeInputs = [
      pkgs.jq
      pkgs.git
      pkgs.curl
      pkgs.gnugrep
      pkgs.util-linux # setpriv, flock
      pkgs.coreutils
      pkgs.gawk # lib.sh log_errtail
      config.system.build.nixos-rebuild # the system's own: ng, named nixos-rebuild
      config.fleet.upgradeGuard.package # fleet-switch-guard (host/lib.sh)
      pkgs.openssh # git fetch and push over ssh, as the operator
    ];
    vars =
      operatorHomeVars
      // commitVars
      // {
        VERBS_DIR = verbsDir;
        FLAKE = config.fleet.config.repo;
        SITE_DIR = config.fleet.site.path;
        LOCKFILE = config.fleet.rebuildLock;
        HOSTNAME = config.networking.hostName;
        CONTROL_PLANE_HOST = config.fleet.apps.daedalus.hostname;
        HEALTH_PATH = config.fleet.apps.daedalus.auth.healthPath;
        LAN_IP = config.fleet.lanIp;
        # The workspace lock the clone is mutated under (host/lib.sh).
        # The pin, for a `claude-code-update` run (host/engine-update.sh).
        CLAUDE_CODE_PIN = lib.getExe pinScript;
        WORKSPACES_DIR = workspacesDir;
      };
    files = [
      ./host/lib.sh
      ./host/engine-update.sh
    ];
  };

  # The status file's undertaker (host/update-reaper.sh), shared by every
  # rebuilding verb.
  updateReaper = mkUpdateReaper {
    name = "daedalus-engine-update-reaper";
    statusFile = "engine-update-status.json";
    nextSteps = "Nothing was necessarily committed — check `journalctl -u 'daedalus-engine-update@*'` and `git log` in ${config.fleet.config.repo}";
  };
in

{
  # The sibling of the image update: it takes the shared rebuild lock, commits
  # to the flake, and switches the system. What is different is the file it
  # moves — flake.lock — and the second tree it touches, the engine clone the
  # control plane runs out of. It moves the whole engine input, so its own
  # ExecStart changes on exactly the commits it applies: mkRootVerb's
  # `restartIfChanged = false` is what keeps that switch from SIGTERMing the
  # run before its verify and push. The `claude-code-update` verb names this
  # unit too (host/engine-update.sh runs the pin first). A failed update means the box may have
  # been rolled back without anyone watching the page that started it — the
  # page it restarts, no less — so it mails.
  config = lib.mkIf config.fleet.modules.daedalus.enable (
    lib.mkMerge [
      (mkRootVerb {
        verb = "engine-update";
        unit = "daedalus-engine-update";
        description = "Move the engine's flake pin and rebuild, on daedalus's behalf";
        verbDescription = "Fast-forward the engine clone, move the configuration's lock onto it and rebuild";
        script = updateScript;
        # A Claude Code pin's fetch, verify and push (ten minutes at most),
        # then a fetch, a build of the whole system against a new engine, two
        # switch attempts and a verify that may wait ten minutes for the
        # control plane.
        timeoutStartSec = 70 * 60;
        # `{actor}`: nothing to choose — one input, one branch.
        payloadMax = 1024;
        execStopPost = [
          "${pinReaper}/bin/daedalus-claude-code-pin-reaper"
          "${updateReaper}/bin/daedalus-engine-update-reaper"
        ];
        unitAttrs = {
          after = [
            "network-online.target"
            "linger-users.service"
          ];
          wants = [ "network-online.target" ];
        };
      })
      {
        # The same unit, asked as the pin: one helper lock and one busy check
        # for both verbs, so neither starts while the other runs.
        fleet.daedalus.rootVerbs.claude-code-update = {
          unit = "daedalus-engine-update@.service";
          description = "Pin upstream's latest Claude Code in the engine, then rebuild onto it";
          payloadMax = 1024;
          timeoutSec = 70 * 60 + 60;
        };
      }
    ]
  );
}
