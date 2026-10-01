# daedalus-verbs — the control plane's host verbs: the root helper's
# (root-helper.nix), each a `fleet.daedalus.rootVerbs` entry naming its
# unit, and whether a failure mails (monitoredJobs) or is shown on the page
# that asked — ARCHITECTURE.md's root-helper table lists them all.
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
    retiredApplyDir
    prevDir
    verbsDir
    deployableApps
    runnableTasks
    longestTaskSec
    actorPattern
    dropRunFile
    mkRootVerb
    rootRunDir
    workspaceRoot
    workspacesDir
    ;
  inherit (import ./verbs-lib.nix { inherit config lib pkgs; })
    secretApps
    secretSetScript
    applyScript
    applyReaper
    powerScript
    workspaceCloneScript
    imageUpdateScript
    imageUpdateReaper
    ;

  # What the run-file verbs share — the run file arrives as a credential
  # (ARCHITECTURE.md "The root helper"): no way back up, and a /tmp of their own.
  verbSandbox = {
    NoNewPrivileges = true;
    PrivateTmp = true;
    PrivateDevices = true;
    ProtectKernelTunables = true;
    ProtectKernelModules = true;
    ProtectControlGroups = true;
    RestrictSUIDSGID = true;
    LockPersonality = true;
  };

  # A run-file verb that runs as the operator, never root.
  operatorVerb = verbSandbox // {
    User = config.fleet.operator.user;
    Group = config.fleet.operator.group;
  };
in

{
  config = lib.mkIf config.fleet.modules.daedalus.enable (
    lib.mkMerge [
      {
        # The directory the container dropped requests into before the root
        # helper, emptied of its dead files once: as the operator, who owns it
        # and everything in it, never through a link. Delete this unit once
        # the box has run it.
        systemd.services.daedalus-apply-retire = {
          description = "Remove the retired daedalus apply directory";
          wantedBy = [ "multi-user.target" ];
          unitConfig.ConditionPathIsDirectory = retiredApplyDir;
          serviceConfig = {
            Type = "oneshot";
            User = config.fleet.operator.user;
            Group = config.fleet.operator.group;
            ExecStart = "${pkgs.coreutils}/bin/rm -rf --one-file-system -- ${retiredApplyDir}";
          };
        };
        # The root verbs' status files (daedalus-lib.nix verbsDir): root's, read
        # by everyone, mounted read-only into the container.
        systemd.tmpfiles.rules = [ "d ${verbsDir} 0755 root root -" ];
        # Rollback state (see prevDir). statePaths rather than a use-time mkdir
        # alone: it is the fleet's one convention for pre-creating these (tmpfiles
        # skips /home), it exists before the first Apply on a fresh restore, and
        # owner + 0700 are re-enforced at every boot. site-lib's mkdir is only the
        # fallback for a run that beats state-paths.service.
        fleet.statePaths.${prevDir}.mode = "0700";

        # Redeploy: the root helper's `deploy` (root-helper.nix) starts the
        # app's EXISTING `app-<name>-deploy.service` (modules/apps) — the unit
        # that already pulls, compares the digest, restarts only if it moved,
        # health-checks and mails on failure — and relays its lines. No agent of
        # its own: the value is one of deployableApps (daedalus-lib.nix), and the
        # helper's assertions prove each one names a deploy unit this box has.
        #
        # Push, not a replacement for the poll: `app-<name>-deploy.timer` still
        # runs and is what makes deploys self-healing (a push while the box is off
        # is lost; the timer's Persistent=true catches up on boot). A deploy the
        # timer is already running is refused, never joined.
        fleet.daedalus.rootVerbs.deploy = lib.mkIf (deployableApps != [ ]) {
          unit = "app-{app}-deploy.service";
          description = "Redeploy an app: its deploy unit, now";
          selectors.app = deployableApps;
          # deploy.sh's pull, restart and 90 s health check, with room.
          timeoutSec = 600;
        };

        # The workspace clone: the root helper's `workspace-clone` (root-helper.nix). A slug is not a value a list can hold, so it is a pattern
        # selector and travels in the run file; the unit is a template the run id
        # instantiates. It runs as the operator — the clones and the SSH identity
        # are theirs — and gets its run file as a credential (the controller's
        # header, `run file`). Not monitoredJobs: a refusal is shown on the page that asked
        # and exits 0.
        systemd.services."daedalus-workspace-clone@" = {
          description = "Clone a project repo into the workspace root on daedalus's behalf";
          after = [ "network-online.target" ];
          wants = [ "network-online.target" ];
          serviceConfig = operatorVerb // {
            Type = "oneshot";
            ExecStart = "${workspaceCloneScript}/bin/daedalus-workspace-clone";
            LoadCredential = "request:${rootRunDir}/%i.json";
            # The clones and the snapshot directory, and nothing else of the
            # filesystem, are its to write.
            ProtectSystem = "strict";
            ReadWritePaths = [
              "-${workspaceRoot}"
              workspacesDir
            ];
            ExecStopPost = dropRunFile;
            # A large repo on a slow evening plus the 10-minute lock wait; the
            # default 90s would SIGTERM a legitimate first clone.
            TimeoutStartSec = "15min";
          };
        };

        fleet.daedalus.rootVerbs.workspace-clone = {
          unit = "daedalus-workspace-clone@.service";
          description = "Clone (or fast-forward) a project repo into the workspace root";
          # owner/name as GitHub has them: an owner of alphanumerics and hyphens
          # not starting with one, a name that does not start with `.` or `-`
          # (so never `.` or `..`). host/workspace-clone.sh asks the same again.
          patterns.repo = {
            regex = "^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$";
            maxLength = 140;
          };
          patterns.actor = actorPattern;
          # The unit's own 15 minutes, and a minute for the start job.
          timeoutSec = 960;
        };

        # Restart: the root helper's `reboot` (root-helper.nix). The
        # helper starts this unit and relays what it prints; a refusal (host/lib.sh
        # `refuse`) still exits 0, so a refused restart is not a failed unit.
        #
        # No network ordering: it asks systemd three questions and calls
        # `systemctl reboot`. Nothing it does needs a resolver.
        systemd.services.daedalus-power = {
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

        # Set or remove one key in an app's operator-secrets file: the root
        # helper's `secret-set` (root-helper.nix). The key is a pattern
        # selector and the sealed value the payload, so both travel in the run
        # file (never a unit name, never argv); the unit is a template the run id
        # instantiates. The app is one of the applied registry's (verbs-lib
        # `secretApps`), so the verb exists only when some app does.
        #
        # It deliberately does NOT rebuild — the write is a committed file, and
        # making it running state is the Apply's job (which holds the rebuild lock
        # and knows how to roll back). So no rebuild lock is taken here either: the
        # only thing it contends for is the site directory, under the site lock
        # both take (host/site-lib.sh site_lock), and it commits only its file.
        #
        # Root, not the operator: it reads the host's SSH key, which opens every
        # sops secret on the box, and a credential would put a copy of it in a
        # directory the operator can read for the length of the run. Every write
        # into the operator's tree still drops to them (host/secret-set.sh).
        #
        # Not monitoredJobs: a refusal is shown on the page that asked and exits
        # 0; the only mailable event is the agent itself breaking, which
        # `systemctl --failed` and the failed-units alert already carry.
        systemd.services."daedalus-secret-set@" = {
          description = "Set or remove one key in an app's operator-secrets file on daedalus's behalf";
          serviceConfig = verbSandbox // {
            Type = "oneshot";
            ExecStart = "${secretSetScript}/bin/daedalus-secret-set";
            LoadCredential = "request:${rootRunDir}/%i.json";
            # Root only to become the operator (setpriv) and to read the host key,
            # which it owns.
            CapabilityBoundingSet = [
              "CAP_SETUID"
              "CAP_SETGID"
            ];
            RestrictAddressFamilies = [
              "AF_UNIX"
              "AF_INET"
              "AF_INET6"
              "AF_NETLINK"
            ];
            # The configuration checkout (site/ and its git), the rollback copies
            # and the site lock are its to write; nothing else of the filesystem.
            ProtectSystem = "strict";
            ReadWritePaths = [
              config.fleet.config.repo
              prevDir
              "/run/lock"
            ];
            # The repository facts, where the page reads "set <when> by <who>",
            # refreshed once it is done — outside the sandbox (`+`).
            ExecStartPost = "+${config.systemd.package}/bin/systemctl start --no-block daedalus-repo-snapshot.service";
            ExecStopPost = dropRunFile;
            # Two sops runs, a git commit and a push. Two minutes is generous; past it
            # something is wedged and the page should say so rather than hang.
            TimeoutStartSec = "2min";
          };
        };

        fleet.daedalus.rootVerbs.secret-set = lib.mkIf (secretApps != [ ]) {
          unit = "daedalus-secret-set@.service";
          description = "Set or remove one key in an app's operator-secrets file";
          selectors = {
            app = secretApps;
            action = [
              "set"
              "remove"
            ];
          };
          # An environment variable's name; host/secret-set.sh also refuses
          # sops's own `sops_*` rows, which no regex here can say.
          patterns.key = {
            regex = "^[A-Za-z_][A-Za-z0-9_]{0,63}$";
            maxLength = 64;
          };
          patterns.actor = actorPattern;
          # A sops document sealing one value: its recipients and MAC are about
          # 2 KiB, so a value of up to ~45 KiB fits.
          payloadMax = 65536;
          # The unit's own two minutes, and a minute for the start job.
          timeoutSec = 180;
        };

        # "Run now" for an app's scheduled task: the root helper's `task-run`
        # starts the task's EXISTING `app-<app>-task-<id>.service` (modules/apps,
        # the unit its timer starts), so a manual run has the timer's timeout,
        # environment and failure mail. The value is the unit's own name between
        # `app-` and `.service` (daedalus-lib.nix `runnableTasks`): one token, so
        # an app cannot be paired with another app's task. The task's failure
        # mails through its own monitoredJobs entry, as a timed run's does.
        fleet.daedalus.rootVerbs.task-run = lib.mkIf (runnableTasks != [ ]) {
          unit = "app-{task}.service";
          description = "Run an app's scheduled task now";
          selectors.task = runnableTasks;
          # The longest task's own timeout, and a minute for the start job; the
          # task unit's TimeoutStartSec is what stops it.
          timeoutSec = lib.min 86400 (longestTaskSec + 60);
        };
      }

      # The Apply: the root helper's `apply`, the rendered files and what to
      # record its payload (host/apply.sh). Root, because only root can
      # `nixos-rebuild switch`. mkRootVerb's `restartIfChanged = false` is
      # load-bearing: VAULT_APP_SECRETS is derived from apps.json, so an Apply
      # that adds an app moves this unit's ExecStart, and a switch that
      # restarted it would SIGTERM the Apply that caused it. A failed Apply
      # means the box may have been rolled back without anyone watching the UI,
      # so it mails.
      (mkRootVerb {
        verb = "apply";
        unit = "daedalus-apply";
        description = "Apply the daedalus app registry: commit the export and rebuild";
        verbDescription = "Write the rendered site files, commit them and rebuild";
        script = applyScript;
        # A rebuild can take minutes on a cold cache.
        timeoutStartSec = 30 * 60;
        # The rendered site files and what to record: about 40 KiB on the
        # reference box, so the helper's whole cap.
        payloadMax = 262144;
        # Marks a killed run failed instead of leaving it "running"
        # (host/update-reaper.sh).
        execStopPost = [ "${applyReaper}/bin/daedalus-apply-reaper" ];
        # linger-users gates /run/user/1000; the rebuild restarts rootless units.
        unitAttrs = {
          after = [
            "network-online.target"
            "linger-users.service"
          ];
          wants = [ "network-online.target" ];
        };
      })

      # Image updates: the root helper's `image-update`, the request its
      # payload. The sibling of the Apply: it takes the shared rebuild lock,
      # commits to the flake, and switches the system. What is different is
      # that it EDITS nix source to get there; host/image-update.sh opens with
      # why the digest is the only anchor that makes that safe to do
      # unattended.
      #
      # mkRootVerb's `restartIfChanged = false` is load-bearing here twice
      # over: this unit changes its own definition every time it succeeds —
      # `PINS` embeds the pin registry, so the digest it just rewrote lands in
      # its own ExecStart — and a switch that restarted it would SIGTERM the
      # run mid-switch, losing its verify and push phases. Observed on the
      # first real update this ever performed. The next run still gets the new
      # definition, which is exactly when fresh pins are wanted.
      #
      # A failed update means the box may have been rolled back without anyone
      # watching the page that started it: monitored, like the Apply.
      (mkRootVerb {
        verb = "image-update";
        unit = "daedalus-image-update";
        description = "Move a container's image pin and rebuild, on daedalus's behalf";
        verbDescription = "Move image pins (one commit, one rebuild) and verify the containers";
        script = imageUpdateScript;
        # A pull plus a build plus two switch attempts, on a cold cache — and
        # since one request may carry a queue of containers, the pulls scale
        # with it while the build and switch do not. Doubled from apply's
        # 30 min for that reason.
        timeoutStartSec = 60 * 60;
        # `{targets: [{container, toTag}], actor}`: a queue of pins is a few
        # hundred bytes.
        payloadMax = 16384;
        # Marks a crashed run failed instead of leaving it "running" — see the
        # script's own header.
        execStopPost = [ "${imageUpdateReaper}/bin/daedalus-image-update-reaper" ];
        unitAttrs = {
          after = [
            "network-online.target"
            "podman-rootless-ready.service"
            "linger-users.service"
          ];
          wants = [
            "network-online.target"
            "podman-rootless-ready.service"
          ];
        };
      })
    ]
  );
}
