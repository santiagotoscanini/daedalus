# daedalus-lib — the values the control plane's modules share: where the
# root verbs and their status live, which apps the committed registry holds,
# the GitHub App's preconditions, where each snapshot publishes. A plain
# function, imported by path from daedalus.nix, its sibling modules and the
# two script libraries (verbs-lib.nix, snapshots-lib.nix); never a module,
# never in an import list.
{
  config,
  lib,
  pkgs,
}:

rec {
  # The two directories the container writes, each for a reader that is the
  # operator, never root: the workspace icons the session host serves
  # (session-host.nix) and the vendor pages the box's browser job answers (a
  # host's own stack, through `fleet.daedalus.boardsDir`). Everything root
  # does for the container goes through the root helper instead. Under apps/
  # — daedalus is an app on its own platform, so its host-side state sits with
  # the other apps' dirs rather than as a root-level stack.
  workspaceIconsDir = "${config.fleet.stateRoot}/apps/daedalus/workspace-icons";
  boardsDir = "${config.fleet.stateRoot}/apps/daedalus/boards";

  # Where the container dropped requests for root before the root helper:
  # emptied once, as the operator (daedalus-verbs.nix).
  retiredApplyDir = "${config.fleet.stateRoot}/apps/daedalus/apply";

  # ── the agents' scripts ─────────────────────────────────────────────────
  #
  # Every host agent is ONE shell script: the variables nix hands it, then
  # shell files under host/, in the order `files` names them (host/lib.sh
  # first, almost always). `vars` is an attrset, written one `NAME=value` line
  # each, in name order — the scripts only ever read them:
  #   string, number, derivation   shell-quoted (a store path needs no quotes)
  #   path                         copied into the store, then its store path
  #   list                         a bash array, each element quoted
  # `excludeShellChecks` passes through to writeShellApplication, which also
  # runs shellcheck over the whole script when the system is built. Every
  # agent gets `daedalus-agent` and `journalctl` on its PATH besides its own
  # inputs: host/lib.sh `outcome` runs the one and waits through the other.
  mkAgent =
    {
      name,
      runtimeInputs,
      vars,
      files,
      excludeShellChecks ? [ ],
    }:
    pkgs.writeShellApplication {
      inherit name excludeShellChecks;
      runtimeInputs = runtimeInputs ++ [
        (pkgs.callPackage ../../pkgs/daedalus-agent.nix { })
        config.systemd.package
      ];
      text =
        lib.concatStrings (lib.mapAttrsToList (n: v: "${n}=${shellValue v}\n") vars)
        + lib.concatMapStrings (f: "\n" + builtins.readFile f) files;
    };

  shellValue =
    v:
    if lib.isList v then
      "(${lib.concatMapStringsSep " " shellValue v})"
    else if builtins.isPath v then
      "${v}"
    else
      lib.escapeShellArg (toString v);

  # The ExecStopPost every rebuilding verb runs (apply, image, engine, version and
  # claude-code updates): marks a run that died without a terminal status as
  # failed, so the verb's button is not wedged until the app's staleness
  # clock runs out. `nextSteps` ends the message: what to check, no full stop.
  mkUpdateReaper =
    {
      name,
      statusFile,
      nextSteps,
    }:
    mkAgent {
      inherit name;
      runtimeInputs = [
        pkgs.jq
        pkgs.coreutils
      ];
      # NEXT_STEPS quotes commands in backticks, as Markdown for the page:
      # literal text in single quotes, which is what SC2016 warns about.
      excludeShellChecks = [ "SC2016" ];
      vars = operatorVars // {
        STATUS = "${verbsDir}/${statusFile}";
        NEXT_STEPS = nextSteps;
      };
      files = [
        ./host/lib.sh
        ./host/update-reaper.sh
      ];
    };

  # The variable groups the agents share. host/lib.sh reads and publishes
  # every file in a container-writable directory as the operator, so nearly
  # every agent needs `operatorVars`; those that run git, ssh or podman in the
  # operator's own home add the rest of `operatorHomeVars`.
  operatorVars = {
    OPERATOR_USER = config.fleet.operator.user;
    OPERATOR_GROUP = config.fleet.operator.group;
    SETPRIV = "${pkgs.util-linux}/bin/setpriv";
  };
  operatorHomeVars = operatorVars // {
    OPERATOR_HOME = config.fleet.operator.home;
    # Absolute, like every binary a setpriv child runs: it does not inherit
    # writeShellApplication's PATH resolution for the command itself.
    ENV_BIN = "${pkgs.coreutils}/bin/env";
    GIT = "${pkgs.git}/bin/git";
  };
  # The identities a commit the box makes may carry (host/lib.sh commit_name).
  commitVars = {
    GIT_EMAIL = config.fleet.mail.sender;
    GIT_OPERATOR_NAME = config.fleet.operator.gitName;
    GIT_OPERATOR_EMAIL = config.fleet.operator.gitEmail;
  };

  # The previous bytes of every site file an Apply (or a secret-set) replaces,
  # which a failed Apply's rollback puts back, commits and pushes. Deliberately
  # never mounted: rollback state is trusted for a decision, and in a
  # container-writable directory the container could plant the "was absent"
  # marker or swap the bytes between a failed build and the rollback. Operator-owned so the agents' setpriv writes land; 0700 because
  # nothing else on the box has a reason to read it. host/site-lib.sh.
  prevDir = "${config.fleet.stateRoot}/apps/daedalus/prev";

  # The one-writer lock of the site directory, taken by both agents that
  # write into it (apply, secret-set; host/site-lib.sh site_lock). Under
  # /run/lock, which only root can write — both run as root.
  siteLock = "/run/lock/daedalus-site.lock";

  # The committed registry, read from the same file declarations.nix reads
  # rather than from `config.fleet.apps` (see the note on `self` in daedalus.nix).
  # `fleet.registry.file` is safe to read here: it depends only on
  # `fleet.site.source`, a path set in configuration.nix. Without the entries
  # still waiting for their first image, exactly as declarations.nix filters
  # them: nothing exists for such an app yet, so no list below may name it.
  # (What the builder may build is not baked at all: host/build.sh reads the
  # committed registry at run time.)
  registryApps =
    lib.filterAttrs (_: a: (a.awaitingImage or false) != true)
      (builtins.fromJSON (builtins.readFile config.fleet.registry.file)).apps;

  # Apps that actually have an `app-<name>-deploy.service` to start: the
  # registry-mode entries whose deploy is not frozen (schema v2's
  # `deploy.enable`, absent = on — the same default the platform applies) and
  # that are past `declared` (a declared app has no container, so no deploy
  # unit). Defined once here because a name in it becomes part of a unit name
  # root starts: the root helper's `deploy` verb (daedalus-verbs.nix) and the
  # build agent (build-agent.nix) must never disagree about it.
  #
  # A frozen app keeps its page and its env snapshot; what it loses is
  # exactly this — the verb has no such value, so a freeze holds against the UI's
  # Redeploy button too, not just the timer. A local-source app like daedalus
  # is excluded for free, because it has no deploy unit at all.
  #
  # This list is the security control on the `deploy` verb and on the build
  # agent's final step. It MUST stay in lockstep with the deploy units
  # modules/apps/apps.nix generates (`deploy.enable && running`) — an
  # allowlist wider than those units would let root start a unit that does
  # not exist, and the root helper's assertions (root-helper.nix) refuse one.
  deployableApps = lib.attrNames (
    lib.filterAttrs (
      _: a:
      (a.deploy.enable or true)
      && ((a.sourceMode or "registry") == "registry")
      && ((a.stage or "lab") != "declared")
    ) registryApps
  );

  # The scheduled tasks that have an `app-<app>-task-<id>.service` to run
  # now, as that unit's name between `app-` and `.service`: the root helper's
  # `task-run` values (daedalus-verbs.nix). One token per unit, so an app's
  # name cannot be paired with another app's task id. Same gate the platform
  # applies (modules/apps generates a task's units only past `declared`); a
  # local-source app is absent for free, like it is from deployableApps.
  runnableTasks = lib.concatLists (
    lib.mapAttrsToList (
      appName: a:
      lib.optionals ((a.stage or "lab") != "declared") (
        map (t: "${appName}-task-${t.id}") (a.tasks or [ ])
      )
    ) registryApps
  );
  # The longest of those tasks' own timeouts (the registry's `timeoutSec`,
  # 900 unless it says otherwise).
  longestTaskSec = lib.foldl' lib.max 900 (
    lib.concatMap (a: map (t: t.timeoutSec or 900) (a.tasks or [ ])) (lib.attrValues registryApps)
  );

  at = label: "${label}.${config.fleet.baseDomain}";

  # ── the GitHub App ─────────────────────────────────────────────────────
  #
  # Two halves with different preconditions. The public webhook host is
  # unconditional: its router answers nothing but a POST to one path, and the
  # engine refuses those until a webhook secret exists. Everything that needs
  # the App's credentials waits for site/vault/github-app.sops to be in the
  # flake (the platform/git and modules/cloudflared precedent — a flake sees
  # only tracked files, so "exists" means "committed by an Apply").
  hooksHost = at "hooks";

  githubAppVault = "${config.fleet.site.source}/vault/github-app.sops";
  haveGithubApp = builtins.pathExists githubAppVault;
  # "" rather than a throw while site.json lacks the App, so the assertion
  # in daedalus.nix is what reports it instead of an eval error inside a unit.
  githubAppField =
    f: if config.fleet.github.app == null then "" else toString config.fleet.github.app.${f};

  # The webhook secret's render dir, and the token minter's output dir. Named
  # after no container: /run/<container> is a unit's RuntimeDirectory, wiped
  # whenever that container stops.
  githubRenderDir = "/run/daedalus-github";
  githubTokenDir = "/run/daedalus-github-token";

  # Project workspaces: working clones of the projects' repos, in the
  # operator's home so a Claude Code session on this box can work in them
  # directly (and push — the GitHub SSH identity is the operator's too, from
  # platform/git). NOT under fleet.stateRoot: these are development trees,
  # not container state, and no container mounts them.
  #
  # On the reference host the home directory is snapshotted and mirrored, so
  # uncommitted work in these trees survives a disk.
  workspaceRoot = "${config.fleet.operator.home}/projects";

  # The engine clone — daedalus's own source, and one of those workspaces.
  #
  # A LITERAL, for the same reason source.path in daedalus.nix is one: the control
  # plane's own source must not depend on the workspace feature it manages, so
  # this is deliberately not derived from `fleet.workspaces`. Named once here
  # because two places want it now — the dev server's bind of its app/ and the
  # read-only bind of the repo root the MCP server reads its design docs from.
  engineRoot = "${config.fleet.operator.home}/projects/daedalus";

  # Where their published snapshot lives — same /run contract as the other
  # snapshot dirs: derived state, republished on every sync, gone on reboot.
  workspacesDir = "/run/daedalus-workspaces";

  # The variables both workspace agents share (mkAgent's `vars`).
  workspaceVars = operatorHomeVars // {
    WORKSPACE_ROOT = workspaceRoot;
    OUT_DIR = workspacesDir;
  };

  workspaceRuntimeInputs = [
    pkgs.jq
    pkgs.git
    pkgs.openssh # git clone/fetch over ssh
    pkgs.util-linux # setpriv, flock
    pkgs.coreutils
  ];

  # ── where each snapshot publishes ────────────────────────────────────────
  #
  # Each is a /run directory the container mounts read-only (container.nix)
  # and a snapshot service writes (daedalus-snapshots.nix).

  # Where the merged per-container environment is published. /run, so these
  # secrets live on tmpfs and never enter a ZFS snapshot or the syncoid mirror.
  envDir = "/run/daedalus-env";

  # Where each running container's image labels are published. Public metadata
  # rather than secrets — see the header of image-snapshot.sh — but /run for
  # the same reason: derived state that should not outlive a reboot.
  imageDir = "/run/daedalus-images";

  # What only the host can answer about this machine — SMART, self-test
  # history, scrub state, snapshot usage, replication lag, boot generations.
  # See host/system-snapshot.sh for why each of those has no other route in.
  systemDir = "/run/daedalus-system";

  # The two repositories as the host sees them — remote, head, dirty state,
  # drift from origin, the last Apply commit — for Settings › Site repository.
  # The configuration repo is the flake a rebuild reads; the site repo is the
  # JSON one daedalus itself writes (fleet.site.path). See
  # host/repo-snapshot.sh for why both are snapshots and not mounts.
  repoDir = "/run/daedalus-repo";

  # The builder's machinery as the host sees it — BuildKit's cache, the scratch
  # dataset, the per-app mise caches, whether the egress fence and the push
  # credential are in place, the builder units' states — for Apps › Builder.
  # Exit codes, sizes, versions and unit states only; see
  # host/builder-snapshot.sh for what it runs and what it never keeps.
  builderDir = "/run/daedalus-builder";

  # ── the controller ───────────────────────────────────────────────────────
  #
  # The directory the controller's local API socket lives in (controller.nix),
  # mounted into the container as it is (container.nix). It holds the socket
  # alone. Written by the controller rather than by a snapshot, but made by
  # tmpfiles at boot and at every switch, so the bind source exists before the
  # container starts whether or not the controller is up.
  controllerDir = "/run/daedalus-controller";

  # The controller's own state (controller.nix): the
  # one place it writes besides that socket's directory — which is why the
  # session host's allow-list, which the controller writes, lives here
  # (session-host.nix).
  controllerDataDir = "${config.fleet.stateRoot}/apps/daedalus/controller";

  # Its logs, Claude remote control's among them (claude-logs.nix ships them).
  controllerLogDir = "${controllerDataDir}/logs";

  # Claude remote control's transient user unit, which the controller starts.
  claudeUnit = "daedalus-claude-rc";

  # The root helper's socket (root-helper.nix). NOT under controllerDir: that
  # one is bind-mounted into the app's container, and this socket is the
  # controller's alone.
  rootSocket = "/run/daedalus-root/root.sock";

  # Where the root helper writes a verb's run file (ARCHITECTURE.md "The root
  # helper") and the verb's unit reads it: root's, 0700, never
  # mounted anywhere. The unit gets its file as a systemd credential
  # (`LoadCredential=request:`); host/lib.sh `take_request` is its side.
  rootRunDir = "/run/daedalus-root-runs";

  # What an actor label is held to on its way to a root verb that records it
  # (a commit's body, a journal line): the app maps anything else to `_`.
  actorPattern = {
    regex = "^[A-Za-z0-9 ._@+-]{1,128}$";
    maxLength = 128;
  };

  # The ExecStopPost every run-file verb's template carries, as root (`+`:
  # the unit itself is the operator's, and the directory root's): its run file
  # goes whatever the script did with it.
  dropRunFile = "+${pkgs.coreutils}/bin/rm -f -- ${rootRunDir}/%i.json";

  # What the root verbs that report as they run (build, …) publish: each its
  # `<verb>-status.json` (and a log), written by root into a directory only
  # root can write and mounted read-only into the container at /verbs
  # (container.nix). The request reaches root through the root helper's run
  # file, so root reads nothing the container wrote. Not /run: a status
  # outlives a reboot, like the run it reports. Made by tmpfiles
  # (daedalus-verbs.nix).
  verbsDir = "/var/lib/daedalus-verbs";

  # One root verb that takes its request as a payload (ARCHITECTURE.md "The root
  # helper"): the template `<unit>@.service` the helper starts
  # once per run, running `script` with the run file as its `request`
  # credential (host/lib.sh take_request), the `fleet.daedalus.rootVerbs`
  # entry that names it, and — unless `monitored` is false — its
  # monitoredJobs registration. The helper waits `timeoutStartSec` and a
  # minute. `unit` and `serviceConfig` merge over what every such verb has:
  # `restartIfChanged = false`, because a switch must never restart a run (a
  # rebuilding verb would SIGTERM itself mid-switch, and a build its own push);
  # the next run gets the new definition. A plain function returning module
  # config, for the verb's own module to merge.
  mkRootVerb =
    {
      verb,
      unit,
      description,
      script,
      timeoutStartSec,
      payloadMax,
      verbDescription ? description,
      selectors ? { },
      patterns ? { },
      monitored ? true,
      serviceConfig ? { },
      execStopPost ? [ ],
      unitAttrs ? { },
    }:
    {
      systemd.services."${unit}@" = unitAttrs // {
        inherit description;
        restartIfChanged = false;
        serviceConfig = {
          Type = "oneshot";
          ExecStart = lib.getExe script;
          LoadCredential = "request:${rootRunDir}/%i.json";
          ExecStopPost = execStopPost ++ [ dropRunFile ];
          TimeoutStartSec = timeoutStartSec;
        }
        // serviceConfig;
      };
      fleet.daedalus.rootVerbs.${verb} = {
        unit = "${unit}@.service";
        description = verbDescription;
        inherit selectors patterns payloadMax;
        timeoutSec = timeoutStartSec + 60;
      };
      fleet.monitoredJobs = lib.optionalAttrs monitored { "${unit}@" = { }; };
    };
}
