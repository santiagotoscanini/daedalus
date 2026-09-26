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

  # The previous bytes of every site file an Apply (or a site write) replaces,
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

  # The env both workspace agents share. The git binary is passed absolute
  # like PODMAN/SETPRIV in the siblings: the setpriv child does not inherit
  # writeShellApplication's PATH resolution for the command itself.
  workspaceEnv = ''
    WORKSPACE_ROOT=${lib.escapeShellArg workspaceRoot}
    OUT_DIR=${lib.escapeShellArg workspacesDir}
    OPERATOR_USER=${lib.escapeShellArg config.fleet.operator.user}
    OPERATOR_GROUP=${lib.escapeShellArg config.fleet.operator.group}
    OPERATOR_HOME=${lib.escapeShellArg config.users.users.${config.fleet.operator.user}.home}
    SETPRIV=${pkgs.util-linux}/bin/setpriv
    ENV_BIN=${pkgs.coreutils}/bin/env
    GIT=${pkgs.git}/bin/git
  '';

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
