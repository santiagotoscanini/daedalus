# daedalus-lib — the values the control plane's modules share: where the
# bridge lives, which apps the committed registry holds, the GitHub App's
# preconditions, where each snapshot publishes. A plain function, imported by
# path from daedalus.nix, its sibling modules and the two script libraries
# (verbs-lib.nix, snapshots-lib.nix); never a module, never in an import list.
{
  config,
  lib,
  pkgs,
}:

rec {
  # The apps stack is what turns `fleet.apps.daedalus` into the `app-daedalus`
  # container. Whatever this module defines UNDER that container is gated on it.
  appsOn = config.fleet.modules.apps.enable;

  # Where the container drops an apply request and reads back status. A bind
  # mount, deliberately, rather than an API the host calls: the container has
  # no privilege to lose, and the host agent never has to authenticate to the
  # app or reach into Postgres. The app produces the artifact; the host moves
  # it into the flake and rebuilds.
  # Under apps/ — daedalus is an app on its own platform, so its host-side
  # state sits with the other apps' dirs rather than as a root-level stack.
  applyDir = "${config.fleet.stateRoot}/apps/daedalus/apply";

  # Mixed into every bridge agent (daedalus-verbs.nix, daedalus-github.nix,
  # the workspace sync in daedalus-snapshots.nix). One property, one argument, written
  # once — the agents differ in what they do and in how long they may take, but
  # not in this.
  #
  # A path unit turns each request into a START, so a burst of requests is a
  # burst of starts, and systemd's default is 5 in 10 seconds before it REFUSES
  # the next one. A refused start is never retried: the request file is already
  # in its final state, so nothing changes the path again and the verb is
  # silently dropped — visible only as `start-limit-hit` in a mail, and likeliest
  # exactly when the box is busiest. Seen live: three deploy triggers in three
  # seconds, then a refusal.
  #
  # Dropping the limit is safe here in a way it would not be for a daemon.
  # These are oneshots doing bounded work; each script re-reads the request and
  # refuses an id it has already answered; and the one verb that talks to a
  # third party throttles itself (the token minter, one mint a minute). There is
  # no loop for a rate limit to catch.
  bridgeAgent = {
    startLimitIntervalSec = 0;
  };

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
  # runs shellcheck over the whole script when the system is built.
  mkAgent =
    {
      name,
      runtimeInputs,
      vars,
      files,
      excludeShellChecks ? [ ],
    }:
    pkgs.writeShellApplication {
      inherit name runtimeInputs excludeShellChecks;
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

  # The ExecStopPost every rebuilding verb runs (image, engine, version and
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
        STATUS = "${applyDir}/${statusFile}";
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
    OPERATOR_HOME = config.users.users.${config.fleet.operator.user}.home;
    # Absolute, like every binary a setpriv child runs: it does not inherit
    # writeShellApplication's PATH resolution for the command itself.
    ENV_BIN = "${pkgs.coreutils}/bin/env";
  };
  # The identities a commit the box makes may carry (host/lib.sh commit_name).
  commitVars = {
    GIT_EMAIL = config.fleet.mail.sender;
    GIT_OPERATOR_NAME = config.fleet.operator.gitName;
    GIT_OPERATOR_EMAIL = config.fleet.operator.gitEmail;
  };

  # The previous bytes of every site file an Apply (or a secret-set) replaces,
  # which a failed Apply's rollback puts back, commits and pushes. A SIBLING of
  # applyDir and deliberately never mounted: rollback state is trusted for a
  # decision, and in the container-writable apply dir the container could plant
  # the "was absent" marker or swap the bytes between a failed build and the
  # rollback. Operator-owned so the agents' setpriv writes land; 0700 because
  # nothing else on the box has a reason to read it. host/site-lib.sh.
  prevDir = "${config.fleet.stateRoot}/apps/daedalus/prev";

  # The committed registry, read from the same file declarations.nix reads
  # rather than from `config.fleet.apps` (see the note on `self` in daedalus.nix).
  # `fleet.registry.file` is safe to read here: it depends only on
  # `fleet.site.source`, a path set in configuration.nix.
  registryApps = (builtins.fromJSON (builtins.readFile config.fleet.registry.file)).apps;

  # The two allowlists the bridge agents are handed, both from the registry
  # above. Defined once here because a name in either becomes part of a unit
  # name root starts: the deploy trigger (verbs-lib.nix) and the build agent
  # (build-agent.nix) must never disagree about them.

  # Apps the box builds: every registry-mode entry, `deploy.enable` ignored (a
  # frozen app still builds; it is just not deployed) and `declared` included
  # (being in apps.json is exactly what earns an app its first build).
  buildableApps = lib.attrNames (
    lib.filterAttrs (_: a: (a.sourceMode or "registry") == "registry") registryApps
  );

  # Apps that actually have an `app-<name>-deploy.service` to start: the
  # registry-mode entries whose deploy is not frozen (schema v2's
  # `deploy.enable`, absent = on — the same default the platform applies) and
  # that are past `declared` (a declared app has no container, so no deploy
  # unit). A frozen app keeps its page and its env snapshot; what it loses is
  # exactly this — the trigger refuses it, so a freeze holds against the UI's
  # Redeploy button too, not just the timer. A local-source app like daedalus
  # is excluded for free, because it has no deploy unit at all.
  #
  # This list is the security control on the deploy trigger and on the build
  # agent's final step. It MUST stay in lockstep with the deploy units
  # modules/apps/apps.nix generates (`deploy.enable && running`) — an
  # allowlist wider than those units would let root start a unit that does
  # not exist.
  deployableApps = lib.attrNames (
    lib.filterAttrs (
      _: a:
      (a.deploy.enable or true)
      && ((a.sourceMode or "registry") == "registry")
      && ((a.stage or "lab") != "declared")
    ) registryApps
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

  githubAppVault =
    if config.fleet.site.source == null then
      null
    else
      "${config.fleet.site.source}/vault/github-app.sops";
  haveGithubApp = githubAppVault != null && builtins.pathExists githubAppVault;
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
  workspaceRoot = "${config.users.users.${config.fleet.operator.user}.home}/projects";

  # The engine clone — daedalus's own source, and one of those workspaces.
  #
  # A LITERAL, for the same reason source.path in daedalus.nix is one: the control
  # plane's own source must not depend on the workspace feature it manages, so
  # this is deliberately not derived from `fleet.workspaces`. Named once here
  # because two places want it now — the dev server's bind of its app/ and the
  # read-only bind of the repo root the MCP server reads its design docs from.
  engineRoot = "${config.users.users.${config.fleet.operator.user}.home}/projects/daedalus";

  # Where their published snapshot lives — same /run contract as the other
  # snapshot dirs: derived state, republished on every sync, gone on reboot.
  workspacesDir = "/run/daedalus-workspaces";

  # The variables both workspace agents share (mkAgent's `vars`).
  workspaceVars = operatorHomeVars // {
    WORKSPACE_ROOT = workspaceRoot;
    OUT_DIR = workspacesDir;
    GIT = "${pkgs.git}/bin/git";
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
  # Each is a /run directory the container mounts read-only (daedalus.nix)
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

  # Claude Code itself — the Remote Control unit, the sessions connected to
  # it, and the credential clock underneath both. A separate snapshot from
  # the system snapshot rather than another key in it, for the two reasons that
  # normally justify splitting: a different cadence (sessions come and go in
  # minutes; SMART and scrub state move in hours) and a different blast
  # radius — this one shells into a journal and a 0600 credentials file, and
  # a failure in that has no business blanking the disk panels.
  #
  # See host/claude-snapshot.sh for what each piece is and, more importantly,
  # for what is deliberately left out of a world-readable file.
  claudeDir = "/run/daedalus-claude";

  # The two repositories as the host sees them — remote, head, dirty state,
  # drift from origin, the last Apply commit — for Settings › Site repository.
  # The configuration repo is the flake a rebuild reads; the site repo is the
  # JSON one daedalus itself writes (fleet.site.path). See
  # host/repo-snapshot.sh for why both are snapshots and not mounts.
  repoDir = "/run/daedalus-repo";
}
