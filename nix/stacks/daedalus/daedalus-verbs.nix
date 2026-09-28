# daedalus-verbs — the file-drop bridge's agents, one verb at a time: each
# verb's service, the path unit that starts it on `<verb>-request.json`, and
# whether a failure mails (monitoredJobs) or is shown on the page that asked.
# `daedalus-power` is the exception: the root helper starts it (controller.nix,
# `root`), and it has no path unit.
# The scripts are verbs-lib.nix; the shared values daedalus-lib.nix. Part of the
# daedalus stack (daedalus.nix holds the switch); never imports its siblings.
{
  config,
  lib,
  pkgs,
  ...
}:

let
  inherit (import ./daedalus-lib.nix { inherit config lib pkgs; })
    applyDir
    prevDir
    bridgeAgent
    ;
  inherit (import ./verbs-lib.nix { inherit config lib pkgs; })
    secretSetScript
    applyScript
    deployTriggerScript
    taskRunScript
    powerScript
    workspaceCloneScript
    imageUpdateScript
    imageUpdateReaper
    ;
in

{
  config = lib.mkIf config.fleet.modules.daedalus.enable {
    fleet.statePaths.${applyDir} = { };
    # Rollback state (see prevDir). statePaths rather than a use-time mkdir
    # alone: it is the fleet's one convention for pre-creating these (tmpfiles
    # skips /home), it exists before the first Apply on a fresh restore, and
    # owner + 0700 are re-enforced at every boot. site-lib's mkdir is only the
    # fallback for a run that beats state-paths.service.
    fleet.statePaths.${prevDir}.mode = "0700";

    # The apply agent. Root, because only root can `nixos-rebuild switch`.
    #
    # Triggered by a path unit rather than a socket or an API: the container
    # writes apply-request.json into the apply dir (bound in daedalus.nix),
    # systemd notices, and this runs. The container therefore holds no host privilege at all — the trust
    # boundary is "can write into that directory". The container itself can
    # (its root is the operator's uid), which is why every agent reads and
    # writes files there only as the operator and never through a link — the
    # rule and its reasons are in host/lib.sh.
    #
    # NOT a timer: an apply should start when one is requested, not up to N
    # seconds later, and a rebuild is far too expensive to poll for.
    systemd.services.daedalus-apply = bridgeAgent // {
      description = "Apply the daedalus app registry: commit the export and rebuild";
      # linger-users gates /run/user/1000; the rebuild restarts rootless units.
      after = [
        "network-online.target"
        "linger-users.service"
      ];
      wants = [ "network-online.target" ];

      # Load-bearing, for the reason spelled out on daedalus-image-update below:
      # a unit that runs `nixos-rebuild switch` must not be restarted by that
      # switch. VAULT_APP_SECRETS is derived from apps.json, so an Apply that
      # adds an app moves this unit's ExecStart; this line is what keeps that
      # from SIGTERMing the apply that caused it.
      restartIfChanged = false;

      serviceConfig = {
        Type = "oneshot";
        ExecStart = "${applyScript}/bin/daedalus-apply";
        # A rebuild can take minutes on a cold cache; the default 90s would
        # SIGTERM it mid-switch.
        TimeoutStartSec = "30min";
      };
    };

    systemd.paths.daedalus-apply = {
      description = "Watch for a daedalus apply request";
      wantedBy = [ "multi-user.target" ];
      pathConfig = {
        # PathChanged fires on close-after-write and on rename-into-place, which
        # is how the app publishes the file — it writes a temp and renames, so a
        # half-written request is never observable.
        PathChanged = "${applyDir}/apply-request.json";
      };
    };

    # A failed apply means the box may have been rolled back without anyone
    # watching the UI. Mail it.
    fleet.monitoredJobs.daedalus-apply = { };

    # Image updates. Same file-drop bridge — and the sibling of
    # apply rather than of the trigger below: it takes the shared rebuild lock,
    # commits to the flake, and switches the system. What is different is that
    # it EDITS nix source to get there; host/image-update.sh opens with why the
    # digest is the only anchor that makes that safe to do unattended.
    systemd.services.daedalus-image-update = bridgeAgent // {
      description = "Move a container's image pin and rebuild, on daedalus's behalf";
      after = [
        "network-online.target"
        "podman-rootless-ready.service"
        "linger-users.service"
      ];
      wants = [
        "network-online.target"
        "podman-rootless-ready.service"
      ];

      # A unit that runs `nixos-rebuild switch` must not be restarted BY that
      # switch, and this one changes its own definition every time it succeeds:
      # `PINS` embeds the pin registry, so the digest it just rewrote lands in
      # its own ExecStart. switch-to-configuration then dutifully restarts it,
      # SIGTERMs the script mid-run, and the update loses its verify and push
      # phases while leaving a status file stuck on "running" forever. Observed
      # on the first real update this ever performed.
      #
      # The next invocation still gets the new definition — the path unit starts
      # a fresh process, which is exactly when fresh pins are wanted. What this
      # buys is that the run holding the rebuild lock survives its own rebuild.
      restartIfChanged = false;

      serviceConfig = {
        Type = "oneshot";
        ExecStart = "${imageUpdateScript}/bin/daedalus-image-update";
        # Marks a crashed run failed instead of leaving it "running" until the
        # app's staleness clock expires — see the script's own header.
        ExecStopPost = "${imageUpdateReaper}/bin/daedalus-image-update-reaper";
        # A pull plus a build plus two switch attempts, on a cold cache — and
        # since one request may carry a queue of containers, the pulls scale with
        # it while the build and switch do not. Doubled from apply's 30min for
        # that reason. The default 90s would SIGTERM it mid-switch.
        #
        # RUNNING_MAX_MS in app/src/host/image-update.ts is this plus slack: past
        # it the app declares a silent run dead, so the two must move together.
        TimeoutStartSec = "60min";
      };
    };

    systemd.paths.daedalus-image-update = {
      description = "Watch for a daedalus image update request";
      wantedBy = [ "multi-user.target" ];
      pathConfig.PathChanged = "${applyDir}/image-request.json";
    };

    # A failed update means the box may have been rolled back without anyone
    # watching the page that started it — the same argument as daedalus-apply.
    fleet.monitoredJobs.daedalus-image-update = { };

    # Redeploy trigger. Same file-drop bridge as apply, different verb: this one
    # starts an app's EXISTING deploy unit rather than rebuilding the system.
    #
    # Push, not a replacement for the poll. `app-<name>-deploy.timer` still runs
    # (see modules/apps) and is what makes deploys self-healing: a notification
    # that arrives while the box is off is simply lost, whereas the timer's
    # Persistent=true catches up on boot. This only removes latency.
    systemd.services.daedalus-deploy-trigger = bridgeAgent // {
      description = "Start an app's deploy unit on daedalus's behalf";
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];
      serviceConfig = {
        Type = "oneshot";
        ExecStart = "${deployTriggerScript}/bin/daedalus-deploy-trigger";
        # deploy.sh health-checks with a 90s timeout after the restart; give the
        # whole pull-restart-verify cycle room without hanging forever.
        TimeoutStartSec = "10min";
      };
    };

    systemd.paths.daedalus-deploy-trigger = {
      description = "Watch for a daedalus redeploy request";
      wantedBy = [ "multi-user.target" ];
      pathConfig.PathChanged = "${applyDir}/deploy-request.json";
    };

    fleet.monitoredJobs.daedalus-deploy-trigger = { };

    # The workspace clone agent — same file-drop bridge. Root
    # because a path unit can only start a system unit; every git call inside
    # drops to the operator (the clones and the SSH identity are theirs).
    systemd.services.daedalus-workspace-clone = bridgeAgent // {
      description = "Clone a project repo into the workspace root on daedalus's behalf";
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];
      serviceConfig = {
        Type = "oneshot";
        ExecStart = "${workspaceCloneScript}/bin/daedalus-workspace-clone";
        # A large repo on a slow evening plus the 10-minute lock wait; the
        # default 90s would SIGTERM a legitimate first clone.
        TimeoutStartSec = "15min";
      };
    };

    systemd.paths.daedalus-workspace-clone = {
      description = "Watch for a daedalus workspace clone request";
      wantedBy = [ "multi-user.target" ];
      pathConfig.PathChanged = "${applyDir}/workspace-request.json";
    };

    # Not monitoredJobs, like the secret-set and task-run agents: both
    # outcomes land in the status file the page that asked is polling, and a
    # genuine refusal exits 0.

    # Restart: the root helper's `reboot` (controller.nix, `root`) — the first
    # verb off the file-drop bridge, so no path unit and no request file. The
    # helper starts this unit and relays what it prints; a last line
    # `refused: …` is a refusal and the unit still exits 0, so a refused
    # restart is not a failed unit.
    #
    # No network ordering: it asks systemd three questions and calls
    # `systemctl reboot`. Nothing it does needs a resolver.
    systemd.services.daedalus-power = bridgeAgent // {
      description = "Restart the box on daedalus's behalf";
      serviceConfig = {
        Type = "oneshot";
        ExecStart = "${powerScript}/bin/daedalus-power";
        # Three cheap checks and a queued reboot; a minute is already generous,
        # and a hung agent here should surface rather than sit on the rebuild
        # lock it holds until it exits.
        TimeoutStartSec = "1min";
      };
    };

    fleet.daedalus.rootVerbs.reboot = {
      unit = "daedalus-power.service";
      description = "Restart the box (never power it off)";
      # The unit's own minute, and slack for the start job's queueing.
      timeoutSec = 90;
    };

    # Not monitoredJobs: this only ever runs because somebody pressed a button
    # and is watching the page, a refusal is shown there, and a SUCCESS takes
    # the mail relay down with the rest of the box before anything could be
    # sent. The only email this unit could ever deliver is a failure to reboot.

    # The secret-set bridge's agent. It outlives its action, so `done` and
    # `failed` are both real and the ordinary status poll covers the flow end to
    # end.
    #
    # It deliberately does NOT rebuild — the write is a committed file, and
    # making it running state is the Apply's job (which holds the rebuild lock
    # and knows how to roll back). So no rebuild lock is taken here either: the
    # only thing it contends for is the site directory's git index, and
    # site_commit already scopes its commit to site/.
    systemd.services.daedalus-secret-set = bridgeAgent // {
      description = "Set or remove one key in an app's operator-secrets file on daedalus's behalf";
      serviceConfig = {
        Type = "oneshot";
        ExecStart = "${secretSetScript}/bin/daedalus-secret-set";
        # Two sops runs, a git commit and a push. Two minutes is generous; past it
        # something is wedged and the page should say so rather than hang.
        TimeoutStartSec = "2min";
      };
    };

    systemd.paths.daedalus-secret-set = {
      description = "Watch for a daedalus app-secret write request";
      wantedBy = [ "multi-user.target" ];
      pathConfig.PathChanged = "${applyDir}/secret-set-request.json";
    };

    # Not monitoredJobs: both outcomes land in the
    # status file the page that asked is polling, and a genuine refusal exits 0.
    # The only mailable event is the agent itself breaking, which `systemctl
    # --failed` and the failed-units alert already carry.

    # "Run now" for an app's scheduled task. Same file-drop bridge, and the same
    # relationship to the thing it starts as daedalus-deploy-trigger has to
    # `app-<name>-deploy.service`: the timer is still what makes the task happen,
    # this only removes the wait.
    #
    # No network ordering: it reads a local file and starts a sibling unit. What
    # that unit then does may need the network, but its own ordering carries
    # that, not this one's.
    systemd.services.daedalus-task-run = bridgeAgent // {
      description = "Run an app's scheduled task on daedalus's behalf";
      serviceConfig = {
        Type = "oneshot";
        ExecStart = "${taskRunScript}/bin/daedalus-task-run";
        # The task unit carries its own TimeoutStartSec (the registry's
        # timeoutSec, 900s by default, and nothing stops an app asking for more).
        # `systemctl start --wait` blocks for all of it, so a ceiling here would
        # SIGTERM this agent while the task it is waiting on was still legitimately
        # running — and publish a failure for a run that then succeeded. The task
        # unit's own timeout is the one that fires.
        TimeoutStartSec = "infinity";
      };
    };

    systemd.paths.daedalus-task-run = {
      description = "Watch for a daedalus task-run request";
      wantedBy = [ "multi-user.target" ];
      pathConfig.PathChanged = "${applyDir}/task-run-request.json";
    };

    # Not monitoredJobs, like power and the workspace clone: both
    # outcomes land in the status file the page that asked is polling, a genuine
    # refusal exits 0, and the task's OWN failure already mails through
    # fleet.monitoredJobs.app-<app>-task-<id> — mailing here as well would send
    # two emails for one failed run.
  };
}
