# daedalus — the box's own control plane, and the only app on the apps
# platform the box does not build.
#
# Everything else on the platform rides the registry loop: push to main, the
# GitHub App webhook reaches daedalus, `daedalus-build.service` builds the
# image and pushes it to the box's registry, and the deploy that build starts
# runs it. daedalus is the engine itself — this repository — and comes as ONE
# image built from the Dockerfile at the repository root (Dockerfile,
# docker-entrypoint.sh), run one of two ways:
#
#   the published image (default)   `fleet.daedalus.image`, the engine's own
#                                   ghcr image at the version this rev ships.
#                                   Pinning the engine pins the control plane.
#   dev mode (`fleet.daedalus.dev`)  the image's `runtime` stage, built on the
#                                   box; the engine checkout's app/ mounted at
#                                   /app; Vite serving it. Saving a file IS the
#                                   deploy: no commit, no build, no pull, no
#                                   rebuild. For the host that develops the
#                                   engine.
#
# What dev mode buys and what it costs:
#   + Edit-to-browser in under a second, from anywhere with a shell on the box.
#   + The checkout lives under /home, which the reference host snapshots and
#     mirrors — unlike its configuration repo. The engine's remote is still the
#     copy that survives a disk.
#   - No production build. Dev-server performance, on purpose: this is a
#     single-operator admin UI, not something that serves load.
#   - `pnpm install --frozen-lockfile` runs at every container start, so the
#     npm registry (the box's mirror when it publishes one, npmjs otherwise) is
#     a hard startup dependency. First boot after a fresh restore takes minutes;
#     the unit is Type=oneshot so it goes green immediately while Vite is still
#     starting, and the probe is red until it listens. Expected, not a fault.
#   - A fresh restore needs the checkout before the container will start.
#
# Which rebuilds matter, in dev mode:
#   <clone>/app/**           → nothing. Vite is watching it.
#   <clone>/app/package.json → `systemctl restart podman-app-daedalus` (re-installs).
#   Dockerfile, docker-entrypoint.sh
#                            → nixos-rebuild (runtime context hash → new image
#                              tag → restart). Nothing else in the repository
#                              reaches that context.
#   this file                → nixos-rebuild.

{
  config,
  lib,
  pkgs,
  mkDotenvSecret,
  mkLocalImage,
  mkSecretRender,
  ...
}:

let
  # What the stacks show the control plane — `fleet.dashboard` (platform/
  # export.nix), read whole and never indexed by a fixed key. Each stack
  # contributes inside its own `mkIf`: a version under the name the engine
  # reads (`N8N_VERSION`), an endpoint (`PIHOLE_URL`), a rendered secret
  # (`LITELLM_API_KEY`), a mount (/shotter). Switch the stack off and its
  # entry is simply absent — the page renders "unknown" or nothing — where
  # this module used to reach into `containers.n8n.image`, `webApps.pihole`
  # and `sops.secrets."litellm-env"` and fail eval the moment one was gone.
  dashboard = lib.attrValues config.fleet.dashboard;

  # The apps stack is what turns `fleet.apps.daedalus` into the `app-daedalus`
  # container. Whatever this module defines UNDER that container is gated on it.
  appsOn = config.fleet.modules.apps.enable;

  # Which containers ride each VPN tunnel, derived rather than declared: a
  # netns tenant says so in its own `--network=container:<owner>` flag, and
  # that flag is the thing that actually puts it behind the tunnel. A
  # hand-kept list beside it could only ever be the same fact, less reliably.
  netnsTenantsOf =
    owner:
    lib.sort (a: b: a < b) (
      lib.attrNames (
        lib.filterAttrs (
          _: c: lib.any (o: o == "--network=container:${owner}") (c.extraOptions or [ ])
        ) config.virtualisation.oci-containers.containers
      )
    );

  # The VPN egress registry, as the dashboard consumes it. Nix knows things
  # about these tunnels that no API can answer — when the key expires, what
  # the tunnel is for, where the renewal runbook lives — and this is the one
  # place those cross the boundary.
  vpnEgress = lib.mapAttrsToList (
    _: v: v // { tenants = netnsTenantsOf v.container; }
  ) config.fleet.vpnEgress;

  # Where the container drops an apply request and reads back status. A bind
  # mount, deliberately, rather than an API the host calls: the container has
  # no privilege to lose, and the host agent never has to authenticate to the
  # app or reach into Postgres. The app produces the artifact; the host moves
  # it into the flake and rebuilds.
  # Under apps/ — daedalus is an app on its own platform, so its host-side
  # state sits with the other apps' dirs rather than as a root-level stack.
  applyDir = "${config.fleet.stateRoot}/apps/daedalus/apply";

  # Mixed into every bridge agent below. One property, one argument, written
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

  # The site-vault paths an Apply is allowed to write an operator secret to:
  # one per app in the committed registry. This is apply.sh's MANAGED list for
  # `vault/apps/`, and it is a LIST rather than a pattern on purpose — the
  # names an Apply may write are fixed host-side, because a name that came
  # across the bridge is a path traversal with extra steps. Nix spells them out
  # from the same apps.json declarations.nix reads, so an app that does not
  # exist has no writable path at all.
  #
  # Every app, not just the registry-mode ones: `<name>-env.sops` is the
  # operator's environment for the app, and nothing about that depends on where
  # the image comes from (buildableApps is a different question and has its own
  # filter). Baking this in does make apps.json part of daedalus-apply's
  # ExecStart, which the unit's `restartIfChanged = false` already covers —
  # see the note there, which called the previous absence of such a dependency
  # "luck rather than design".
  vaultAppSecrets = map (n: "vault/apps/${n}-env.sops") (lib.attrNames registryApps);

  # The apps whose operator-secrets file the secret-set bridge may write: the
  # same committed registry `vaultAppSecrets` above is built from, as bare
  # NAMES. One list, two shapes, because the two agents want different things
  # from it — apply.sh matches a payload key against a path, secret-set.sh
  # builds the path itself from a name it has matched.
  #
  # This is the security control on that verb (host/secret-set.sh), exactly as
  # `runnableTasks` is on task-run: an app the box has not applied has no
  # writable file at all, and nothing from the request ever becomes a path.
  secretApps = lib.attrNames registryApps;

  # Set or remove ONE key in an app's operator-secrets file. The host half of
  # the write-only secrets editor: daedalus can seal a value (sopsStatic, the
  # public recipients) and can never open one, so every step that needs the
  # decryption identity is here. See host/secret-set.sh.
  secretSetScript = pkgs.writeShellApplication {
    name = "daedalus-secret-set";
    runtimeInputs = [
      pkgs.coreutils
      pkgs.git
      pkgs.gnugrep
      pkgs.jq
      pkgs.openssh # git push over ssh, as the operator
      pkgs.systemd # refresh the repo snapshot when it is done
      pkgs.util-linux # setpriv
    ];
    text = ''
      APPLY_DIR=${lib.escapeShellArg applyDir}
      PREV_DIR=${lib.escapeShellArg prevDir}
      SITE_DIR=${lib.escapeShellArg config.fleet.site.path}
      SECRET_APPS=${lib.escapeShellArg (lib.concatStringsSep " " secretApps)}
      SYSTEMCTL=${pkgs.systemd}/bin/systemctl
      GIT_EMAIL=${lib.escapeShellArg config.fleet.mail.sender}
      OPERATOR_USER=${lib.escapeShellArg config.fleet.operator.user}
      OPERATOR_GROUP=${lib.escapeShellArg config.fleet.operator.group}
      OPERATOR_HOME=${lib.escapeShellArg config.users.users.${config.fleet.operator.user}.home}
      SETPRIV=${pkgs.util-linux}/bin/setpriv
      ENV_BIN=${pkgs.coreutils}/bin/env
      GIT=${pkgs.git}/bin/git
      # sopsStatic, the same binary the container bind-mounts. Nothing here
      # runs in a container, but `pkgs.sops` would be a SECOND 49 MB sops in
      # the system closure for no difference in behaviour.
      SOPS=${sopsStatic}/bin/sops
      # The same derivation sops-nix uses at activation, which is why the
      # identity it produces matches the `age13…` recipient in site/.sops.yaml.
      SSH_TO_AGE=${pkgs.ssh-to-age}/bin/ssh-to-age
      HOST_SSH_KEY=${lib.escapeShellArg (lib.head config.sops.age.sshKeyPaths)}

      ${builtins.readFile ./host/lib.sh}
      ${builtins.readFile ./host/site-lib.sh}
      ${builtins.readFile ./host/secret-set.sh}
    '';
  };

  applyScript = pkgs.writeShellApplication {
    name = "daedalus-apply";
    runtimeInputs = [
      pkgs.jq
      pkgs.git
      pkgs.util-linux # setpriv
      pkgs.coreutils
      pkgs.gnugrep
      pkgs.gawk # lib.sh log_errtail
      pkgs.nixos-rebuild
      pkgs.openssh # git push over ssh
    ];
    text = ''
      APPLY_DIR=${lib.escapeShellArg applyDir}
      PREV_DIR=${lib.escapeShellArg prevDir}
      FLAKE=${lib.escapeShellArg config.fleet.config.repo}
      SITE_DIR=${lib.escapeShellArg config.fleet.site.path}
      VAULT_APP_SECRETS=(${lib.concatMapStringsSep " " lib.escapeShellArg vaultAppSecrets})
      SETPRIV=${pkgs.util-linux}/bin/setpriv
      ENV_BIN=${pkgs.coreutils}/bin/env
      GIT=${pkgs.git}/bin/git
      OPERATOR_HOME=${lib.escapeShellArg config.users.users.${config.fleet.operator.user}.home}
      LOCKFILE=${lib.escapeShellArg config.fleet.rebuildLock}
      HOSTNAME=${lib.escapeShellArg config.networking.hostName}
      GIT_EMAIL=${lib.escapeShellArg config.fleet.mail.sender}
      OPERATOR_USER=${lib.escapeShellArg config.fleet.operator.user}
      OPERATOR_GROUP=${lib.escapeShellArg config.fleet.operator.group}

      ${builtins.readFile ./host/lib.sh}
      ${builtins.readFile ./host/site-lib.sh}
      ${builtins.readFile ./host/apply.sh}
    '';
  };

  # The committed registry, read from the same file declarations.nix reads
  # rather than from `config.fleet.apps` (see the note on `self` below).
  # `fleet.registry.file` is safe to read here: it depends only on
  # `fleet.site.source`, a path set in configuration.nix.
  registryApps = (builtins.fromJSON (builtins.readFile config.fleet.registry.file)).apps;

  # Apps that actually have an `app-<name>-deploy.service` to start: the
  # registry-mode entries whose deploy is not frozen (schema v2's
  # `deploy.enable`, absent = on — the same default the platform applies). A
  # frozen app keeps its page and its env snapshot; what it loses is exactly
  # this — the trigger refuses it, so a freeze holds against the UI's
  # Redeploy button too, not just the timer. A local-source app like daedalus
  # is excluded for free, because it has no deploy unit at all.
  #
  # This list is the security control on the trigger: its contents become part
  # of a unit name that root starts. It MUST stay in lockstep with the
  # entries registry-lib.nix maps `deploy.enable` for — an allowlist wider
  # than the generated units would let root start a unit that does not exist.
  deployableApps = lib.attrNames (
    lib.filterAttrs (
      _: a:
      (a.deploy.enable or true)
      && ((a.sourceMode or "registry") == "registry")
      && ((a.stage or "lab") != "declared")
    ) registryApps
  );

  # The `<app>:<taskId>` pairs that actually have an
  # `app-<app>-task-<taskId>.service` to start. Same gate the platform applies
  # (stacks/apps/apps.nix generates a task's units only while the app is past
  # `stage = "declared"`, because a podman exec into a container that does not
  # exist fails every tick) — and the same registry, read from the committed
  # file rather than `config.fleet.apps`, for the reason on `registryApps`.
  #
  # This list is the security control on the Run-now bridge: its contents
  # become part of a unit name that root starts. It MUST stay in lockstep with
  # the units apps.nix actually generates — an allowlist wider than those units
  # would let root start a unit that does not exist, and a pair assembled from
  # two different entries is exactly what the colon-joined token prevents.
  #
  # A local-source app (daedalus itself, declared from ./self.json rather than
  # the registry) is absent for free, like it is from deployableApps.
  runnableTasks = lib.concatLists (
    lib.mapAttrsToList (
      appName: a:
      lib.optionals ((a.stage or "lab") != "declared") (map (t: "${appName}:${t.id}") (a.tasks or [ ]))
    ) registryApps
  );

  deployTriggerScript = pkgs.writeShellApplication {
    name = "daedalus-deploy-trigger";
    runtimeInputs = [
      pkgs.jq
      pkgs.systemd
      pkgs.coreutils
    ];
    text = ''
      APPLY_DIR=${lib.escapeShellArg applyDir}
      DEPLOYABLE=${lib.escapeShellArg (lib.concatStringsSep " " deployableApps)}
      OPERATOR_USER=${lib.escapeShellArg config.fleet.operator.user}
      OPERATOR_GROUP=${lib.escapeShellArg config.fleet.operator.group}
      SETPRIV=${pkgs.util-linux}/bin/setpriv

      ${builtins.readFile ./host/lib.sh}
      ${builtins.readFile ./host/deploy-trigger.sh}
    '';
  };

  # Run one of an app's scheduled tasks now. A sibling of the deploy trigger,
  # and the same shape: the unit already exists (stacks/apps generates it from
  # the registry's `tasks`), this only starts it out of band and reports the
  # outcome to the page that asked. See host/task-run.sh.
  taskRunScript = pkgs.writeShellApplication {
    name = "daedalus-task-run";
    runtimeInputs = [
      pkgs.jq
      pkgs.systemd
      pkgs.coreutils
    ];
    text = ''
      APPLY_DIR=${lib.escapeShellArg applyDir}
      RUNNABLE=${lib.escapeShellArg (lib.concatStringsSep " " runnableTasks)}
      OPERATOR_USER=${lib.escapeShellArg config.fleet.operator.user}
      OPERATOR_GROUP=${lib.escapeShellArg config.fleet.operator.group}
      SETPRIV=${pkgs.util-linux}/bin/setpriv

      ${builtins.readFile ./host/lib.sh}
      ${builtins.readFile ./host/task-run.sh}
    '';
  };

  # Write the site files — the JSON description of this box — into the site
  # directory inside the configuration repository, staging (and, on the
  # operator's switch, committing) as the operator. The sixth file-drop verb.
  siteWriteScript = pkgs.writeShellApplication {
    name = "daedalus-site-write";
    runtimeInputs = [
      pkgs.coreutils
      pkgs.git
      pkgs.gnugrep
      pkgs.jq
      pkgs.openssh # git push over ssh, as the operator
      pkgs.systemd # refresh the repo snapshot when it is done
      pkgs.util-linux # setpriv
    ];
    text = ''
      APPLY_DIR=${lib.escapeShellArg applyDir}
      PREV_DIR=${lib.escapeShellArg prevDir}
      SITE_DIR=${lib.escapeShellArg config.fleet.site.path}
      SYSTEMCTL=${pkgs.systemd}/bin/systemctl
      GIT_EMAIL=${lib.escapeShellArg config.fleet.mail.sender}
      OPERATOR_USER=${lib.escapeShellArg config.fleet.operator.user}
      OPERATOR_GROUP=${lib.escapeShellArg config.fleet.operator.group}
      OPERATOR_HOME=${lib.escapeShellArg config.users.users.${config.fleet.operator.user}.home}
      SETPRIV=${pkgs.util-linux}/bin/setpriv
      ENV_BIN=${pkgs.coreutils}/bin/env
      GIT=${pkgs.git}/bin/git

      ${builtins.readFile ./host/lib.sh}
      ${builtins.readFile ./host/site-lib.sh}
      ${builtins.readFile ./host/site-write.sh}
    '';
  };
  # Restart the box. The fourth bridge, and the one with a single verb: see
  # host/power.sh for why poweroff has no branch there at all, and why the
  # replay guard matters more here than in any of its siblings.
  #
  # No allowlist to carry and no argument from the request reaches a command —
  # the request body is read for exactly one string, which is compared against
  # one literal.
  powerScript = pkgs.writeShellApplication {
    name = "daedalus-power";
    runtimeInputs = [
      pkgs.jq
      pkgs.systemd
      pkgs.procps # pgrep
      pkgs.util-linux # flock
      pkgs.coreutils
    ];
    text = ''
      APPLY_DIR=${lib.escapeShellArg applyDir}
      LOCKFILE=${lib.escapeShellArg config.fleet.rebuildLock}
      OPERATOR_USER=${lib.escapeShellArg config.fleet.operator.user}
      OPERATOR_GROUP=${lib.escapeShellArg config.fleet.operator.group}
      SETPRIV=${pkgs.util-linux}/bin/setpriv

      ${builtins.readFile ./host/lib.sh}
      ${builtins.readFile ./host/power.sh}
    '';
  };

  # Restart the Remote Control server. The fifth bridge, and the one that
  # exists because the fourth is oversized for its commonest customer: a
  # wedged or version-stale claude-remote-control is a single unit, and a
  # remote session cannot restart it without killing itself (the session
  # lives in that unit's cgroup — see platform/claude-rc.nix, whose
  # restartIfChanged = false is also why rebuilds no longer land updates
  # onto it). See host/claude-rc.sh for the verb and its guards.
  claudeRcScript = pkgs.writeShellApplication {
    name = "daedalus-claude-rc";
    runtimeInputs = [
      pkgs.jq
      pkgs.systemd
      pkgs.coreutils
    ];
    text = ''
      APPLY_DIR=${lib.escapeShellArg applyDir}
      OPERATOR_USER=${lib.escapeShellArg config.fleet.operator.user}
      OPERATOR_GROUP=${lib.escapeShellArg config.fleet.operator.group}
      SETPRIV=${pkgs.util-linux}/bin/setpriv

      ${builtins.readFile ./host/lib.sh}
      ${builtins.readFile ./host/claude-rc.sh}
    '';
  };

  # ── resuming and ending ONE session ───────────────────────────────────────
  #
  # The bridge above restarts the whole Remote Control server; this one acts on
  # a single row of the session roster. It is the most powerful verb on this
  # box — it causes root to start a process as the OPERATOR, in a trusted
  # directory, with passwordless sudo on PATH and an outbound channel to
  # claude.ai — so the security model is spelled out at the top of
  # host/claude-session.sh and the three values below are the whole of what nix
  # contributes to it.

  # The directories a resumed session may run in.
  #
  # Not a convenience list: an interactive `claude` in a directory whose
  # workspace trust has never been accepted stops on "Is this a project you
  # created or one you trust?" and starts nothing at all (measured here,
  # 2026-09-19). From a systemd unit that is a hang with nobody able to answer
  # the prompt, so the agent refuses such a session up front instead.
  #
  # ONE entry today, and the template unit below fixes it as its
  # WorkingDirectory — %i is the session uuid, so there is nowhere else for a
  # second directory to go. Adding one means an instance name that carries both
  # (or a second template), which is why this throws rather than silently
  # resuming everything in the first directory.
  claudeSessionCwds = [ config.fleet.config.repo ];

  # `~/.claude/projects/<slug>/<uuid>.jsonl` — the CLI slugs the working
  # directory by replacing every separator with a dash. Only ever applied to
  # the list above, whose members have no other character the CLI rewrites, and
  # the agent still confirms the transcript is really in that directory before
  # trusting the mapping.
  claudeSessionSlug = lib.replaceStrings [ "/" ] [ "-" ];

  # The Remote Control label a resumed session announces itself under, which is
  # what the operator's own `tmux … claude --resume <uuid> --remote-control
  # <hostname>` recipe passes. Read from the hostname rather than restated.
  claudeSessionLabel = config.networking.hostName;

  # The argv, fixed here and nowhere else. NOTHING in a request reaches it —
  # not a flag, not a directory, not a model. A `--permission-mode` the
  # container could choose would be the whole ballgame.
  #
  # Two things it does beyond exec'ing the CLI:
  #
  #   - A PTY, and it is NOT optional. `--remote-control` starts an
  #     INTERACTIVE session; with stdin and stdout as pipes the CLI silently
  #     falls back to --print mode and dies in about a second with "Input must
  #     be provided either through stdin or as a prompt argument when using
  #     --print" (measured here, CLI 2.1.260). A bare `ExecStart=claude
  #     --resume %i --remote-control …` is therefore the box's signature
  #     failure: a unit that starts, exits, and says nothing useful. Under
  #     `script -qfec …` the same argv reaches the full TUI, prints
  #     "/remote-control is active" and registers a claude.ai session URL.
  #     `script` also stays in the foreground as the child's parent, so the
  #     unit's main process lives exactly as long as the session does and
  #     KillMode=control-group reaches everything.
  #
  #     This is also, retrospectively, what the operator's `tmux new-session
  #     -d … claude --resume <uuid> --remote-control <hostname>` was buying:
  #     the pty, not the detachment. **Do not "simplify" this back to tmux.**
  #     Two reasons, both fatal: daedalus could only drive tmux through its
  #     control socket, and a socket that runs arbitrary commands as the
  #     operator is strictly worse than this bridge, whose whole value is that
  #     it constrains what may be started; and a tmux-owned process is
  #     re-parented to the tmux server, which escapes this unit's cgroup and
  #     turns `systemctl stop` back into the pid-matching guess the unit
  #     exists to avoid.
  #   - The journal filter from platform/claude-rc.nix, for the same measured
  #     reason: the CLI repaints its status box about once a second even when
  #     idle (~400k lines/day). ANSI is stripped, the box frames dropped, the
  #     timestamped events and anything unexpected kept.
  #
  # The uuid is re-validated here, a fourth time, because this is also the
  # entry point for a hand-typed `systemctl start claude-session@<anything>`.
  claudeSessionRunner = pkgs.writeShellApplication {
    name = "claude-session-run";
    runtimeInputs = [
      pkgs.claude-code
      pkgs.util-linux
      pkgs.gnused
      pkgs.gnugrep
    ];
    text = ''
      id="''${1-}"
      if [[ ! "$id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
        echo "refusing to resume '$id': not a canonical lowercase session uuid" >&2
        exit 64
      fi
      script -qfec "claude --resume $id --remote-control ${claudeSessionLabel}" /dev/null \
        | sed -u -E 's/\x1b\[[0-9;]*[A-Za-z]//g; s/\x1b\]8;;[^\x07]*\x07//g' \
        | { grep --line-buffered -Ev '^·|^[[:space:]]|^$' || true; }
    '';
  };

  # The bridge agent. See host/claude-session.sh for the three layers; the two
  # lists below are rendered from ONE source, index for index, so the slug the
  # agent composes a path from and the directory it names in a refusal can
  # never disagree.
  claudeSessionScript = pkgs.writeShellApplication {
    name = "daedalus-claude-session";
    runtimeInputs = [
      pkgs.coreutils
      pkgs.gawk
      pkgs.gnused
      pkgs.jq
      pkgs.systemd
      pkgs.util-linux # setpriv
    ];
    text = ''
      APPLY_DIR=${lib.escapeShellArg applyDir}
      OPERATOR_USER=${lib.escapeShellArg config.fleet.operator.user}
      OPERATOR_GROUP=${lib.escapeShellArg config.fleet.operator.group}
      OPERATOR_HOME=${lib.escapeShellArg config.users.users.${config.fleet.operator.user}.home}
      CLAUDE_HOME=${lib.escapeShellArg "${config.users.users.${config.fleet.operator.user}.home}/.claude"}
      CLI_STORE=${lib.escapeShellArg (toString pkgs.claude-code)}
      TRUSTED_CWDS=${lib.escapeShellArg (lib.concatStringsSep " " claudeSessionCwds)}
      TRUSTED_SLUGS=${lib.escapeShellArg (lib.concatStringsSep " " (map claudeSessionSlug claudeSessionCwds))}
      SETPRIV=${pkgs.util-linux}/bin/setpriv

      ${builtins.readFile ./host/lib.sh}
      ${builtins.readFile ./host/claude-session.sh}
    '';
  };

  # Project workspaces: working clones of the projects' repos, in the
  # operator's home so a Claude Code session on this box can work in them
  # directly (and push — the GitHub SSH identity is the operator's too, from
  # platform/git). NOT under fleet.stateRoot: these are development trees,
  # not container state, and no container mounts them.
  #
  # ~/projects rides the `home` dataset, so unlike /etc/nixos these trees ARE
  # snapshotted and syncoid-mirrored — uncommitted vibecode survives a disk.
  workspaceRoot = "${config.users.users.${config.fleet.operator.user}.home}/projects";

  # The engine clone — daedalus's own source, and one of those workspaces.
  #
  # A LITERAL, for the same reason source.path below is one: the control
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

  # The clone agent — the sixth file-drop verb. See host/workspace-clone.sh
  # for why the ssh key never enters the container and what shape the slug
  # is held to.
  workspaceCloneScript = pkgs.writeShellApplication {
    name = "daedalus-workspace-clone";
    runtimeInputs = workspaceRuntimeInputs;
    text = ''
      APPLY_DIR=${lib.escapeShellArg applyDir}
      ${workspaceEnv}
      ${builtins.readFile ./host/lib.sh}
      ${builtins.readFile ./host/workspace-lib.sh}
      ${builtins.readFile ./host/workspace-clone.sh}
    '';
  };

  # One body, two cadences: sync (fetch + fast-forward, network) and publish
  # (local facts only, safe to gate the container's start on). See
  # host/workspace-sync.sh for the split.
  mkWorkspaceSyncScript =
    doSync:
    pkgs.writeShellApplication {
      name = "daedalus-workspace-${if doSync then "sync" else "publish"}";
      runtimeInputs = workspaceRuntimeInputs;
      text = ''
        DO_SYNC=${if doSync then "1" else "0"}
        ${workspaceEnv}
        ${builtins.readFile ./host/lib.sh}
        ${builtins.readFile ./host/workspace-lib.sh}
        ${builtins.readFile ./host/workspace-sync.sh}
      '';
    };

  # Where the merged per-container environment is published. /run, so these
  # secrets live on tmpfs and never enter a ZFS snapshot or the syncoid mirror.
  envDir = "/run/daedalus-env";

  envSnapshotScript = pkgs.writeShellApplication {
    name = "daedalus-env-snapshot";
    runtimeInputs = [
      pkgs.podman
      pkgs.util-linux # setpriv
      pkgs.coreutils
      pkgs.gnugrep
      pkgs.jq # write_json_atomic validates before publishing
    ];
    text = ''
      OUT_DIR=${lib.escapeShellArg envDir}
      # host/lib.sh publishes into the operator-owned $OUT_DIR as the operator.
      OPERATOR_USER=${lib.escapeShellArg config.fleet.operator.user}
      OPERATOR_GROUP=${lib.escapeShellArg config.fleet.operator.group}
      OPERATOR_HOME=${lib.escapeShellArg config.users.users.${config.fleet.operator.user}.home}
      OPERATOR_RUNTIME_DIR=${lib.escapeShellArg config.fleet.operator.runtimeDir}
      # The registry's apps plus daedalus itself — exactly the set with a page
      # in the UI. Derived from apps.json, so an Apply keeps it current. ALL
      # registry apps, not just the deployable ones: a frozen app still has a
      # page, and that page still shows its environment.
      APPS=${lib.escapeShellArg (lib.concatStringsSep " " (lib.attrNames registryApps ++ [ "daedalus" ]))}
      SETPRIV=${pkgs.util-linux}/bin/setpriv
      ENV_BIN=${pkgs.coreutils}/bin/env
      PODMAN=${pkgs.podman}/bin/podman

      ${builtins.readFile ./host/lib.sh}
      ${builtins.readFile ./host/env-snapshot.sh}
    '';
  };

  # Where each running container's image labels are published. Public metadata
  # rather than secrets — see the header of image-snapshot.sh — but /run for
  # the same reason: derived state that should not outlive a reboot.
  imageDir = "/run/daedalus-images";

  imageSnapshotScript = pkgs.writeShellApplication {
    name = "daedalus-image-snapshot";
    runtimeInputs = [
      pkgs.podman
      pkgs.util-linux # setpriv
      pkgs.coreutils
      pkgs.gnused
      pkgs.jq
    ];
    # Same exclusion and the same reason as the system snapshot below: the jq
    # programs here bind their own variables with --arg, and `$cv` in single
    # quotes is jq's variable, not the shell's. Letting the shell near it is
    # the bug SC2016 is warning about, in reverse.
    excludeShellChecks = [ "SC2016" ];
    text = ''
      OUT_DIR=${lib.escapeShellArg imageDir}
      # host/lib.sh publishes into the operator-owned $OUT_DIR as the operator.
      OPERATOR_USER=${lib.escapeShellArg config.fleet.operator.user}
      OPERATOR_GROUP=${lib.escapeShellArg config.fleet.operator.group}
      OPERATOR_HOME=${lib.escapeShellArg config.users.users.${config.fleet.operator.user}.home}
      OPERATOR_RUNTIME_DIR=${lib.escapeShellArg config.fleet.operator.runtimeDir}
      SETPRIV=${pkgs.util-linux}/bin/setpriv
      ENV_BIN=${pkgs.coreutils}/bin/env
      PODMAN=${pkgs.podman}/bin/podman
      JQ=${pkgs.jq}/bin/jq

      ${builtins.readFile ./host/lib.sh}
      ${builtins.readFile ./host/image-snapshot.sh}
    '';
  };

  # Every image pinned as `:tag@sha256:…`, rendered at eval so the freshness
  # script stays dumb: container → the tag ref to ask about and the digest the
  # flake holds.
  #
  # Parsed in platform/export.nix rather than here, because the update agent
  # below needs the same parse and two regexes over the same strings is how
  # the probe and the thing that rewrites a pin come to disagree about what a
  # pin is. The shape is `{ image, repo, tag, digest }`; this renames `digest`
  # to the `pinnedDigest` the probe already speaks.
  pinnedImages = lib.mapAttrs (_: p: {
    inherit (p) image repo tag;
    pinnedDigest = p.digest;
  }) config.fleet.imagePins;

  # Whether each of those tags has moved on from its pin — the one version
  # question only the registry can answer. A snapshot file beside labels.json
  # rather than a fleet.export domain, deliberately: export domains carry
  # nix-eval facts and re-publish when the CONFIG changes, whereas this is a
  # runtime probe whose answer changes while the config sits still. The
  # snapshot contract (timer, envelope, staleness aged by the reader) is
  # exactly the shape of that.
  imageFreshnessScript = pkgs.writeShellApplication {
    name = "daedalus-image-freshness";
    runtimeInputs = [
      pkgs.skopeo
      pkgs.jq
      pkgs.gnugrep
      pkgs.gnused
      pkgs.coreutils
    ];
    text = ''
      OUT_DIR=${lib.escapeShellArg imageDir}
      PINNED=${pkgs.writeText "daedalus-pinned-images.json" (builtins.toJSON pinnedImages)}
      # host/lib.sh publishes into the operator-owned $OUT_DIR as the operator.
      OPERATOR_USER=${lib.escapeShellArg config.fleet.operator.user}
      OPERATOR_GROUP=${lib.escapeShellArg config.fleet.operator.group}
      SETPRIV=${pkgs.util-linux}/bin/setpriv

      ${builtins.readFile ./host/lib.sh}
      ${builtins.readFile ./host/image-freshness.sh}
    '';
  };

  # Move a pin and rebuild onto it — the fifth bridge, and the only one that
  # edits nix source rather than copying bytes the app rendered.
  #
  # `PINS` is the same registry the freshness probe reads, plus the update
  # policy: it is simultaneously the parse (what ref is this container on),
  # the allowlist (a container absent from it reaches no command) and the
  # lockstep table. Rendered by nix from the running config, so it cannot
  # describe a container the box does not have.
  imageUpdateScript = pkgs.writeShellApplication {
    name = "daedalus-image-update";
    runtimeInputs = [
      pkgs.jq
      pkgs.git
      pkgs.skopeo
      pkgs.gnugrep
      pkgs.gnused
      pkgs.util-linux # setpriv, flock
      pkgs.coreutils
      pkgs.gawk # lib.sh log_errtail
      pkgs.nixos-rebuild
      pkgs.openssh # git push over ssh
    ];
    text = ''
      APPLY_DIR=${lib.escapeShellArg applyDir}
      FLAKE=${lib.escapeShellArg config.fleet.config.repo}
      # For lib.sh's site_engine_override: the agent refuses while one is set.
      SITE_DIR=${lib.escapeShellArg config.fleet.site.path}
      PINS=${pkgs.writeText "daedalus-image-pins.json" (builtins.toJSON config.fleet.export.domains.images.data.pins)}
      LOCKFILE=${lib.escapeShellArg config.fleet.rebuildLock}
      HOSTNAME=${lib.escapeShellArg config.networking.hostName}
      GIT_EMAIL=${lib.escapeShellArg config.fleet.mail.sender}
      OPERATOR_USER=${lib.escapeShellArg config.fleet.operator.user}
      OPERATOR_GROUP=${lib.escapeShellArg config.fleet.operator.group}
      OPERATOR_HOME=${lib.escapeShellArg config.users.users.${config.fleet.operator.user}.home}
      OPERATOR_RUNTIME_DIR=${lib.escapeShellArg config.fleet.operator.runtimeDir}
      SETPRIV=${pkgs.util-linux}/bin/setpriv
      ENV_BIN=${pkgs.coreutils}/bin/env
      PODMAN=${pkgs.podman}/bin/podman

      ${builtins.readFile ./host/lib.sh}
      ${builtins.readFile ./host/image-update.sh}
    '';
  };

  # The status file's undertaker.
  #
  # The agent writes its own terminal state, so this only ever fires when it
  # did not get to: killed, out of memory, or dead on a line nobody tested.
  # Without it that run stays `running` in the status file until the app's
  # staleness clock expires — and because the flow refuses to start while one
  # is running, a single crash disables every Update button on the box for the
  # whole of that window. Observed: a `command not found` in the resolve loop.
  #
  # It matters more since queueing arrived. A batch is a longer run, so the
  # unit's timeout and the app's clock both had to grow with it, and the wedge
  # they leave behind on a crash grew in step. This bounds it to seconds.
  #
  # Reads the file rather than synthesising one: the id, the phase it died in
  # and the targets are the only things that make the failure readable, and
  # they are all already there.
  imageUpdateReaper = pkgs.writeShellApplication {
    name = "daedalus-image-update-reaper";
    runtimeInputs = [
      pkgs.jq
      pkgs.coreutils
    ];
    text = ''
      OPERATOR_USER=${lib.escapeShellArg config.fleet.operator.user}
      OPERATOR_GROUP=${lib.escapeShellArg config.fleet.operator.group}
      SETPRIV=${pkgs.util-linux}/bin/setpriv
      STATUS=${lib.escapeShellArg "${applyDir}/image-status.json"}

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
            + " `journalctl -u daedalus-image-update` and `git log` in ${config.fleet.config.repo}."
      ' <<<"$status_json" | write_json_atomic "$STATUS"
    '';
  };

  # What only the host can answer about this machine — SMART, self-test
  # history, scrub state, snapshot usage, replication lag, boot generations.
  # See host/system-snapshot.sh for why each of those has no other route in.
  systemDir = "/run/daedalus-system";

  systemSnapshotScript = pkgs.writeShellApplication {
    name = "daedalus-system-snapshot";
    # SC2016 is "expressions don't expand in single quotes", which is exactly
    # what every jq program in this script relies on: `$dev`, `$status` and
    # friends are jq's own variables, bound with --arg, and letting the shell
    # near them is the bug the check is warning about in reverse. Same for the
    # one awk program's `$1`/`$2`.
    excludeShellChecks = [ "SC2016" ];
    runtimeInputs = [
      pkgs.smartmontools
      pkgs.zfs
      pkgs.coreutils
      pkgs.dmidecode
      pkgs.gnused
      pkgs.gnugrep
      pkgs.gawk
      pkgs.nix
      pkgs.jq
      pkgs.systemd
    ];
    text = ''
      OUT_DIR=${lib.escapeShellArg systemDir}
      # host/lib.sh publishes into the operator-owned $OUT_DIR as the operator.
      OPERATOR_USER=${lib.escapeShellArg config.fleet.operator.user}
      OPERATOR_GROUP=${lib.escapeShellArg config.fleet.operator.group}
      SETPRIV=${pkgs.util-linux}/bin/setpriv
      # The replications the host declares (fleet.backup), one "source<TAB>target"
      # per line, so the panel watches exactly what the backup does.
      REPLICATION_PAIRS=${
        lib.escapeShellArg (
          lib.concatStringsSep "\n" (
            lib.mapAttrsToList (source: r: "${source}\t${r.target}") config.fleet.backup.replications
          )
        )
      }
      SMARTCTL=${pkgs.smartmontools}/bin/smartctl
      DMIDECODE=${pkgs.dmidecode}/bin/dmidecode
      ZPOOL=${pkgs.zfs}/bin/zpool
      ZFS=${pkgs.zfs}/bin/zfs
      LSBLK=${pkgs.util-linux}/bin/lsblk
      NIX_ENV=${pkgs.nix}/bin/nix-env
      UNAME=${pkgs.coreutils}/bin/uname
      SED=${pkgs.gnused}/bin/sed
      GREP=${pkgs.gnugrep}/bin/grep
      AWK=${pkgs.gawk}/bin/awk
      JQ=${pkgs.jq}/bin/jq
      SYSTEMCTL=${pkgs.systemd}/bin/systemctl

      ${builtins.readFile ./host/lib.sh}
      ${builtins.readFile ./host/system-snapshot.sh}
    '';
  };

  # Claude Code itself — the Remote Control unit, the sessions connected to
  # it, and the credential clock underneath both. A separate snapshot from
  # the one above rather than another key in it, for the two reasons that
  # normally justify splitting: a different cadence (sessions come and go in
  # minutes; SMART and scrub state move in hours) and a different blast
  # radius — this one shells into a journal and a 0600 credentials file, and
  # a failure in that has no business blanking the disk panels.
  #
  # See host/claude-snapshot.sh for what each piece is and, more importantly,
  # for what is deliberately left out of a world-readable file.
  claudeDir = "/run/daedalus-claude";

  claudeSnapshotScript = pkgs.writeShellApplication {
    name = "daedalus-claude-snapshot";
    # Same reason as the system snapshot: every `$name` inside the jq
    # programs is jq's own variable, bound with --arg. Letting the shell near
    # them is the bug this check warns about, in reverse.
    excludeShellChecks = [ "SC2016" ];
    runtimeInputs = [
      pkgs.coreutils
      pkgs.gnused
      pkgs.gnugrep
      pkgs.gawk
      pkgs.jq
      pkgs.systemd
    ];
    text = ''
      OUT_DIR=${lib.escapeShellArg claudeDir}
      OPERATOR_USER=${lib.escapeShellArg config.fleet.operator.user}
      OPERATOR_GROUP=${lib.escapeShellArg config.fleet.operator.group}
      SETPRIV=${pkgs.util-linux}/bin/setpriv
      # The CLI's own state directory, and the /tmp dir the Remote Control
      # bridge writes a per-session debug log into — both keyed off the
      # operator this unit reads on behalf of, so neither is a literal that
      # can drift from platform/claude-rc.nix's User=.
      CLAUDE_HOME=${lib.escapeShellArg "${config.users.users.${config.fleet.operator.user}.home}/.claude"}
      BRIDGE_LOG_DIR=${lib.escapeShellArg "/tmp/claude-${toString config.fleet.operator.uid}"}
      # What the flake built. Read from the package rather than by running
      # `claude --version`, which is a node start-up to learn a string nix
      # already knows — and which would report the same number either way,
      # hiding exactly the drift this is here to show.
      CLI_VERSION=${lib.escapeShellArg pkgs.claude-code.version}
      CLI_STORE=${lib.escapeShellArg (toString pkgs.claude-code)}
      SED=${pkgs.gnused}/bin/sed
      GREP=${pkgs.gnugrep}/bin/grep
      AWK=${pkgs.gawk}/bin/awk
      JQ=${pkgs.jq}/bin/jq
      SYSTEMCTL=${pkgs.systemd}/bin/systemctl
      JOURNALCTL=${pkgs.systemd}/bin/journalctl

      ${builtins.readFile ./host/lib.sh}
      ${builtins.readFile ./host/claude-snapshot.sh}
    '';
  };

  # The two repositories as the host sees them — remote, head, dirty state,
  # drift from origin, the last Apply commit — for Settings › Site repository.
  # The configuration repo is the flake a rebuild reads; the site repo is the
  # JSON one daedalus itself writes (fleet.site.path). See
  # host/repo-snapshot.sh for why both are snapshots and not mounts.
  repoDir = "/run/daedalus-repo";

  repoSnapshotScript = pkgs.writeShellApplication {
    name = "daedalus-repo-snapshot";
    # The jq program binds its own variables with --arg; `$path` in single
    # quotes is jq's, not the shell's — the same exclusion as image-snapshot.
    excludeShellChecks = [ "SC2016" ];
    runtimeInputs = [
      pkgs.coreutils
      pkgs.gawk # app_secret_history parses one git log
      pkgs.git
      pkgs.jq
      pkgs.util-linux # setpriv
    ];
    text = ''
      OUT_DIR=${lib.escapeShellArg repoDir}
      REPO_DIR=${lib.escapeShellArg config.fleet.config.repo}
      SITE_DIR=${lib.escapeShellArg config.fleet.site.path}
      OPERATOR_USER=${lib.escapeShellArg config.fleet.operator.user}
      OPERATOR_GROUP=${lib.escapeShellArg config.fleet.operator.group}
      OPERATOR_HOME=${lib.escapeShellArg config.users.users.${config.fleet.operator.user}.home}
      SETPRIV=${pkgs.util-linux}/bin/setpriv
      ENV_BIN=${pkgs.coreutils}/bin/env
      GIT=${pkgs.git}/bin/git
      JQ=${pkgs.jq}/bin/jq
      AWK=${pkgs.gawk}/bin/awk
      DATE=${pkgs.coreutils}/bin/date

      ${builtins.readFile ./host/lib.sh}
      ${builtins.readFile ./host/repo-snapshot.sh}
    '';
  };

  # What Nix currently believes, handed to the container as one read-only
  # store file. Two parts, because they have different provenance:
  #
  #   registry   — site/apps.json, the committed export of daedalus's
  #                own `apps` table. Comparing the DB against THIS is how the
  #                UI reports drift: it is not "what the DB says", it is what
  #                the running system was actually built from.
  #   nixManaged — apps declared by hand in Nix and therefore not editable
  #                here. Only daedalus itself, from the `self` binding below.
  #
  # A store path, not a bind mount of the committed file: the
  # path itself changes when the content does, so the container's ExecStart
  # changes and it restarts with the new manifest. Binding the live file
  # instead would pin its inode and survive an Apply that rewrote it.
  # ONLY the hand-written entries. The committed registry deliberately does NOT
  # ride in here.
  #
  # It used to, and that made every Apply restart daedalus: this is a store
  # path bound into the container, so changing apps.json changed the path,
  # changed the volume argument, changed the unit, and systemd restarted it —
  # right at the "switching" phase, killing the very page that was showing the
  # progress bar. The registry now arrives through a stable path instead (see
  # registrySnapshot below), so applying a change no longer takes the app down.
  # Every hostname already published on this box, apps and non-apps alike
  # (pihole, grafana, chat, …). Handed to the container so a hostname edit can
  # be rejected while it is being typed.
  #
  # (takenHostnames, webAppHosts, lanHosts and monitoredJobs all ride the
  # /export domains now — publishing.json, network.json, jobs.json — see
  # platform/export.nix and the stacks that contribute them.)

  # Apps with a tracked site/vault/apps/<name>-env.sops. A FACT, read from the
  # same directory listing declarations.nix reads, not a setting: this is the
  # only thing that decides whether an app gets operator secrets, so the page
  # shows it and offers no switch. The registry (apps.json) carries settings;
  # the manifest carries what Nix knows — and this belongs on that side.
  #
  # The site directory is handed in rather than derived from the library's
  # location — same argument as the other consumer, spelled out in the library.
  operatorSecretApps = lib.attrNames (
    import ../../platform/lib/operator-secrets-lib.nix {
      inherit lib;
      site = config.fleet.site.source;
    }
  );

  nixManifest = pkgs.writeText "daedalus-nix-manifest.json" (
    builtins.toJSON {
      schemaVersion = 1;
      nixManaged.daedalus = self;
      inherit operatorSecretApps;
    }
  );

  # Copies the committed registry to a FIXED path inside the bind mount, so the
  # container can read what Nix last built without that content being part of
  # its unit.
  #
  # The store-path dependency moves here, which is the point: this tiny oneshot
  # re-runs whenever apps.json changes (its ExecStart embeds the file's store
  # path, so the unit definition changes and systemd restarts it), while the
  # container's definition stays put. Nothing else about the app moves.
  # Into /run/daedalus-export — the READ-ONLY mount — not the rw apply dir:
  # applied.json is the drift-comparison target, the one file the app must
  # not be able to overwrite. It used to sit in /apply purely because that
  # was the convenient stable path; the export dir is the same trick without
  # handing the app write access to its own baseline.
  registrySnapshot = pkgs.writeShellApplication {
    name = "daedalus-registry-snapshot";
    runtimeInputs = [ pkgs.coreutils ];
    text = ''
      install -d -m 0755 /run/daedalus-export
      install -m 0644 ${config.fleet.registry.file} /run/daedalus-export/applied.json
    '';
  };

  # daedalus's own registry entry — ./self.json, the same entry schema as one
  # apps.json value, mapped through the same platform/lib/registry-lib.nix the
  # committed registry goes through. One schema, one mapper: when the registry
  # grows a field, this entry cannot be the reader that silently drops it.
  #
  # Defined ONCE and consumed twice: by `fleet.apps.daedalus` below, and by the
  # manifest the container reads. As two literals these drift within the hour —
  # the app list rendering one description while the detail page reports
  # another. Restating this is exactly the class of bug daedalus exists to
  # catch, so it does not get to have it.
  #
  # NOT read back out of `config.fleet.apps.daedalus`, which would be the other
  # way to deduplicate: this value feeds a volume on the container that
  # apps.nix generates from `fleet.apps`, and threading the read through that
  # is the loop the apps module's header warns about. A JSON file preserves the
  # no-config-read property — which is also what registry-lib requires of its
  # input.
  # (The one config read below is `fleet.baseDomain`, for the hostname: site.json
  # defines it and nothing under `fleet.apps` feeds it, so it is not that loop —
  # `fleet.apps.daedalus.hostname` already reads it for the Settings label.)
  #
  # On its values: `stage = "lab"` keeps it LAN-only — a control plane for
  # this box has no business answering on a public CNAME, wildcard cert or
  # not. `postgres` puts role + database `daedalus` on the shared cluster
  # (stacks/app-db), REVOKE'd from PUBLIC like every other tenant, with
  # DATABASE_URL arriving via the bootstrap-generated env file; joining
  # app-db-net for it is also how the container reaches `litellm:4000` on the
  # same bridge. `litellm` sets LITELLM_BASE_URL against the shared gateway —
  # not a second instance, so daedalus sees every model Lemonade serves with
  # no duplicated model list. `resources` is uncapped on purpose: this is a
  # Vite dev server that typechecks and bundles on demand, so its working set
  # is spiky and unlike a built app's — a cap sized from steady state would
  # OOM it on the first cold compile.
  #
  # One key differs from the registry schema: self.json carries `hostLabel`
  # where an apps.json entry carries a full `hostname`, because this file ships
  # with the engine and a domain is the host's fact (site.json), not the
  # engine's. It is joined here, BEFORE the mapper and the manifest, so both
  # still see the registry's `hostname` and neither learns a second schema.
  self =
    let
      raw = builtins.fromJSON (builtins.readFile ./self.json);
    in
    builtins.removeAttrs raw [
      "_hand"
      "hostLabel"
    ]
    // {
      hostname = at raw.hostLabel;
    };

  registryLib = import ../../platform/lib/registry-lib.nix { inherit lib; };
  selfApp = registryLib.mkApp self;

  # The address, as Settings › General edits it (platform/site.nix). self.json's
  # hostname is the fallback for a site.json that does not carry one yet.
  cp = config.fleet.controlPlane;

  # sops for the host-side secrets editor (host/secret-set.sh): a value the
  # operator typed is sealed before it is committed. Static, so the script
  # carries one binary and no libc. The container has its own — the image
  # ships one (Dockerfile, the sops stage) for Settings › Integrations ›
  # Cloudflare › Replace token.
  sopsStatic = pkgs.sops.overrideAttrs (old: {
    env = (old.env or { }) // {
      CGO_ENABLED = "0";
    };
  });
  at = label: "${label}.${config.fleet.baseDomain}";

  # ── the control plane's image ──────────────────────────────────────────
  #
  # One Dockerfile at the engine's root builds the one image (its header says
  # how); the app runs from the bundle inside it. A host that develops the
  # engine runs it in DEV MODE instead (fleet.daedalus.dev): the image's
  # `runtime` stage alone — node, sops, the entrypoint, no bundle — built on
  # the box from a context of exactly the two files that stage reads, so the
  # tag moves when the runtime changes and never when a route is edited; the
  # checkout's app/ is mounted at /app and the entrypoint runs Vite over it.
  # Saving a file is the deploy.
  daedalusDev = config.fleet.daedalus.dev;

  devRuntime = mkLocalImage {
    name = "app-daedalus-dev";
    tagPrefix = "runtime";
    contextDir = lib.fileset.toSource {
      root = ../../..;
      fileset = lib.fileset.unions [
        ../../../Dockerfile
        ../../../docker-entrypoint.sh
      ];
    };
    file = "Dockerfile";
    target = "runtime";
    gates = [ "podman-app-daedalus.service" ];
  };

  # The app's version, as the engine at this rev ships it: the published image
  # is tagged with it, so pinning the engine pins the control plane's image.
  appVersion = (builtins.fromJSON (builtins.readFile ../../../app/package.json)).version;

  # ── the GitHub App ─────────────────────────────────────────────────────
  #
  # Two halves with different preconditions. The public webhook host is
  # unconditional: its router answers nothing but a POST to one path, and the
  # engine refuses those until a webhook secret exists. Everything that needs
  # the App's credentials waits for site/vault/github-app.sops to be in the
  # flake (the platform/git and stacks/cloudflared precedent — a flake sees
  # only tracked files, so "exists" means "committed by an Apply").
  hooksHost = at "hooks";

  # Labels under baseDomain that no app may publish. Mirrors RESERVED_LABELS in
  # the engine's app/src/lib/hostname.ts — the reasons are argued at the
  # assertion that reads this.
  reservedLabels = {
    hooks = "the GitHub App's webhook (stacks/daedalus, hooks-github.yml)";
    daedalus = "the project's GitHub Pages landing page, a record this box does not own";
  };
  githubAppVault =
    if config.fleet.site.source == null then
      null
    else
      "${config.fleet.site.source}/vault/github-app.sops";
  haveGithubApp = githubAppVault != null && builtins.pathExists githubAppVault;
  # "" rather than a throw while site.json lacks the App, so the assertion
  # below is what reports it instead of an eval error inside a unit.
  githubAppField =
    f: if config.fleet.github.app == null then "" else toString config.fleet.github.app.${f};

  # The webhook secret's render dir, and the token minter's output dir. Named
  # after no container: /run/<container> is a unit's RuntimeDirectory, wiped
  # whenever that container stops.
  githubRenderDir = "/run/daedalus-github";
  githubTokenDir = "/run/daedalus-github-token";

  # The token minter. host/github-token.sh opens with why the key stays here.
  githubTokenScript = pkgs.writeShellApplication {
    name = "daedalus-github-token";
    runtimeInputs = [
      pkgs.openssl
      pkgs.curl
      pkgs.jq
      pkgs.coreutils
      pkgs.gnused # gh_redact
      pkgs.util-linux # setpriv, for lib.sh's operator-side status publish
    ];
    text = ''
      PEM=${lib.escapeShellArg config.sops.secrets."github-app-pem".path}
      CLIENT_ID=${lib.escapeShellArg (githubAppField "clientId")}
      OWNER=${lib.escapeShellArg (githubAppField "owner")}
      # The trusted constant, never site.json's copy (platform/site.nix
      # asserts the two agree).
      OWNER_ID=${lib.escapeShellArg (toString config.fleet.github.expectedOwnerId)}
      OUT_DIR=${lib.escapeShellArg githubTokenDir}
      APPLY_DIR=${lib.escapeShellArg applyDir}
      OPERATOR_USER=${lib.escapeShellArg config.fleet.operator.user}
      OPERATOR_GROUP=${lib.escapeShellArg config.fleet.operator.group}
      SETPRIV=${pkgs.util-linux}/bin/setpriv

      ${builtins.readFile ./host/lib.sh}
      ${builtins.readFile ./host/github-lib.sh}
      ${builtins.readFile ./host/github-token.sh}
    '';
  };
in

{
  options.fleet.modules.daedalus.enable = lib.mkOption {
    type = lib.types.bool;
    default = true;
    description = "The box's own control plane, and the builder that turns a push into an image.";
  };

  options.fleet.daedalus.dev = lib.mkOption {
    type = lib.types.bool;
    default = false;
    description = ''
      Run the control plane in DEV MODE: the image's `runtime` stage, built
      on this box from the engine checkout, with that checkout's `app/`
      mounted at /app and Vite serving it. Saving a file is the deploy. For
      the host that develops the engine; every other host runs the published
      image (`fleet.daedalus.image`).
    '';
  };

  options.fleet.daedalus.image = lib.mkOption {
    type = lib.types.str;
    default = "ghcr.io/santiagotoscanini/daedalus:${appVersion}";
    defaultText = lib.literalExpression ''"ghcr.io/santiagotoscanini/daedalus:<app/package.json version>"'';
    description = ''
      The control plane's image, for a host not in dev mode. The default is
      the engine's own published image at the version this engine rev ships
      (app/package.json): pinning the engine pins it, and the engine's update
      path (System › Updates › Engine) is the image's. Override to a digest
      pin or a mirror of it.
    '';
  };

  options.fleet.daedalus.routerProduct = lib.mkOption {
    type = lib.types.str;
    default = "";
    example = "Example AX3000";
    description = ''
      The product name printed on the LAN router, for the Network page. The one
      router fact the page cannot read off the device itself: its login page's
      build stamp carries model, hardware revision, firmware and build date,
      but not the retail name. Empty shows none.
    '';
  };

  options.fleet.daedalus.serviceKeysSopsFile = lib.mkOption {
    type = lib.types.path;
    example = lib.literalExpression "./sops/service-keys.sops";
    description = ''
      The sops-encrypted dotenv of per-service read-only API keys the control
      plane reads other services' numbers with (rendered as `DASH_<n>`). The
      host's file, handed in: every key in it was minted by a service on that
      box. A key missing from it renders empty and its panel shows no data.
    '';
  };

  config = lib.mkIf config.fleet.modules.daedalus.enable {
    # Reach the monitoring stack: prometheus for liveness/traffic/DB size, loki
    # for the log panels. Both live on `monitoring`. This list MERGES with the
    # one stacks/apps/apps.nix contributes for this container (app-db, plus the
    # iso bridge from webApps.isolated) — bridgeMemberships is the single source
    # of membership and its lists concatenate across modules.
    #
    # It does cost some of what `auth.isolated` buys: daedalus can now dial
    # prometheus and loki. That is a deliberate trade for real status instead of
    # invented status — the isolation that matters (nothing on traefik-net can
    # reach daedalus) is unaffected, since this only adds outbound reach.
    #
    # Gated on the apps stack's switch, like every definition under another
    # stack's declaration: `fleet.apps.daedalus` is only a declaration, and the
    # `app-daedalus` container exists when the apps stack materializes it. With
    # that stack off (or not on this host yet) a membership for a container
    # nobody creates would fail evaluation on its missing image.
    fleet.bridgeMemberships."app-daedalus" = lib.mkIf appsOn [ "monitoring" ];

    # Two labels under baseDomain are not an app's to take, and they fail in
    # opposite ways.
    #
    # `hooks` is the GitHub App's public webhook name (the cfweb router and
    # tunnel route below). Anything else claiming it would either collide with
    # that router or put a whole app behind a public CNAME the operator never
    # chose.
    #
    # `daedalus` is the project's public landing page: a hand-managed CNAME to
    # GitHub Pages (CLAUDE.md). It is deliberately NOT a fleet hostname, which is
    # exactly why it needs saying here — it never appears in the "taken" list a
    # collision check reads, so nothing else on this box would notice a claim on
    # it, and cloudflared-route-sync would reconcile the Pages record away. The
    # control-plane assertion below covers only fleet.controlPlane; an app's
    # `hostname` override reaches the same name by another door.
    #
    # The engine refuses both labels at the edit (app/src/lib/hostname.ts,
    # RESERVED_LABELS); this is the build refusing them, because the edit is not
    # the only door either.
    assertions =
      let
        claims =
          lib.mapAttrsToList (n: w: {
            what = "fleet.webApps.${n}";
            hosts = [ w.hostname ] ++ w.aliases;
          }) config.fleet.webApps
          ++ lib.mapAttrsToList (n: a: {
            what = "fleet.apps.${n}";
            hosts = lib.optional (a.hostname != null) a.hostname ++ a.hostnameAliases;
          }) config.fleet.apps
          ++ lib.mapAttrsToList (n: r: {
            what = "fleet.traefikRoutes.${n}";
            hosts = [ r.host ] ++ r.extraHosts;
          }) config.fleet.traefikRoutes
          ++ lib.mapAttrsToList (n: r: {
            what = "fleet.cloudflareRoutes.${n}";
            hosts = [ r.hostname ];
          }) (builtins.removeAttrs config.fleet.cloudflareRoutes [ "daedalus-hooks" ]);

        # One assertion per reserved label, naming whoever claimed it.
        reservedAssertions = lib.mapAttrsToList (
          label: purpose:
          let
            host = at label;
            offenders = map (c: c.what) (lib.filter (c: lib.elem host c.hosts) claims);
          in
          {
            assertion = offenders == [ ];
            message = "${host} is reserved for ${purpose}: ${lib.concatStringsSep ", " offenders} cannot use it.";
          }
        ) reservedLabels;
      in
      [
        {
          assertion = cp.label != "daedalus" && cp.previousLabel != "daedalus";
          message = "fleet.controlPlane: the control plane cannot answer at daedalus.${config.fleet.baseDomain} — that name is the project's GitHub Pages landing page.";
        }
      ]
      ++ reservedAssertions
      ++ [
        {
          assertion = haveGithubApp -> config.fleet.github.app != null;
          message = "site/vault/github-app.sops is in the flake, but site.json has no github.app. The token minter signs as the App's clientId and finds its installation by ownerId, so the two land together: retry the Apply from Settings › Integrations › GitHub, which writes both in one commit.";
        }
      ];

    # selfApp carries everything self.json declares (stage, the feature flags,
    # presentation, resources) through the shared mapper; layered on here is
    # only what this module alone can know — the local source, the rendered env
    # files, and the auth details that name nix-side machinery.
    fleet.apps.daedalus = selfApp // {
      hostname = if cp.label != null then at cp.label else selfApp.hostname;
      # Serve-both-until-confirmed: after a rename the old address keeps
      # answering, so the operator can never be locked out by a label that does
      # not work. Confirming from the new address clears it (Settings › General).
      hostnameAliases = lib.optional (
        cp.label != null && cp.previousLabel != null && cp.previousLabel != cp.label
      ) (at cp.previousLabel);

      # Dev mode or the published image — the option decides; the entry says
      # where the checkout is either way (a plain string, not a nix path: a
      # path literal would be copied into /nix/store and the container would
      # watch a frozen snapshot). `engineRoot` is a literal rather than derived
      # from `fleet.workspaces` on purpose: the control plane's own source must
      # not depend on the workspace feature it manages.
      source = {
        dev = daedalusDev;
        path = lib.mkIf daedalusDev "${engineRoot}/app";
      };
      image = if daedalusDev then devRuntime.image else config.fleet.daedalus.image;

      # The dashboard keys this module renders from its own store, then the
      # env file each stack renders for it (fleet.dashboard.<id>.envFiles:
      # LITELLM_API_KEY, DASH_POCKETID_KEY, DEPLOY_HOOK_TOKEN — every one a
      # copy the owning stack makes of its own secret).
      environmentFiles = [
        "/run/daedalus-dashboard/env"
      ]
      ++ lib.concatMap (d: d.envFiles) dashboard;

      # mode/isolated/healthPath arrive from self.json via the mapper.
      # Forward-auth, because daedalus has no user model of its own and only
      # ever serves one operator — the Pocket ID gate belongs in front of it
      # rather than inside it, zero app-side auth code. `isolated` puts it on a
      # private iso-daedalus-net bridge with traefik as the only other member,
      # so nothing on traefik-net can dial the dev server directly and skip the
      # gate. `healthPath` is the one unauthenticated path — it backs the gatus
      # probe and the forward-auth bypass.
      auth = selfApp.auth // {
        # Who applied. An Apply writes a git commit, so the commit should name a
        # person rather than "daedalus". Trusting a header requires that nothing
        # else can dial the app and forge one — which is exactly what `isolated`
        # above guarantees, and why the platform asserts the two go together.
        headers = {
          "X-Forwarded-Email" = "{{ .claims.email }}";
          # Pocket ID's user id. The Profile page finds the signed-in account
          # by it, because unlike the email it survives the person editing it.
          "X-Forwarded-User" = "{{ .claims.sub }}";
          # Which Pocket ID groups the session carries, as a JSON array —
          # `mapToJsonArray` is the plugin's own helper, because Go renders a
          # bare []interface{} as `[admins family]`, which is neither JSON nor
          # comma-separated. The app parses it into the Actor and refuses a
          # mutation from someone outside `admins`.
          #
          # This is defence in depth, not the gate. The gate is one layer
          # earlier: the derived Pocket ID client allows `authGroups`, which
          # defaults to [ "admins" ], so a non-admin never gets a session and
          # the app never sees the request. What the header adds is a second
          # check at the thing that actually writes, and an audit trail —
          # `isolated` above is what makes it trustworthy, since only traefik
          # can reach the app and the strip middleware blanks it inbound.
          #
          # NOTE: the plugin only sets headers on gated paths, so every path in
          # authBypassRule below arrives with this blanked. /api/deploy carries
          # its own X-Deploy-Token and /mcp its own bearer token; neither must
          # ever be behind the group check, and neither reads this header — the
          # MCP writes are authorised by the token and recorded under its label
          # (core/authz.ts assertMachineActor).
          "X-Forwarded-Groups" = "{{ .claims.groups | mapToJsonArray }}";
        };
        # Five paths skip the Pocket ID gate, for the same reason healthPath
        # does — whatever fetches them cannot hold a passkey:
        #
        #   /api/deploy — zot's push events (stacks/registry). Carries its own
        #                 auth instead: X-Deploy-Token, checked in the route
        #                 against DEPLOY_HOOK_TOKEN below, and it can do exactly
        #                 one thing — start an existing app's deploy unit.
        #
        #   /mcp        — the engine's MCP server, for Claude Code sessions ON
        #                 THIS BOX. Same posture as /api/deploy and for the same
        #                 reason: an agent cannot complete a passkey redirect.
        #                 The token IS the authentication on this path — a scoped
        #                 credential minted in Settings › Developer, stored only
        #                 as a SHA-256 digest, compared in constant time BEFORE
        #                 any work, and fail-closed (no token minted means every
        #                 request is refused; there is no "unconfigured is open"
        #                 state). Read tokens reach the loaders; a write token
        #                 also reaches build / cancel / deploy / image-pin /
        #                 Apply, through the same host flows the buttons use.
        #
        #                 Why the bypass is acceptable for a WRITE-capable path:
        #                 it is LAN-only — daedalus is `stage = "lab"`, so there
        #                 is no Cloudflare tunnel route and no public name — and
        #                 `isolated = true` means traefik is the only thing that
        #                 can dial this container at all. Deliberately NOT
        #                 registered in `fleet.mcpServers`: fronting it with the
        #                 LiteLLM gateway would hand a control plane that can
        #                 rebuild this box to Open WebUI, to every virtual key,
        #                 and — through `fleet.litellmKeys.claude.mcpServers` —
        #                 potentially to an off-box Claude key. That is a wider
        #                 blast radius than the control plane's own UI has.
        #
        #   /api/nodes/hello — the agent on another machine announcing itself
        #                 (agent/, app/src/routes/api.nodes.hello.ts). A service has
        #                 no passkey, so the path carries its own credential:
        #                 every hello is signed by the ed25519 key the agent made
        #                 at install, the box verifies the bytes, and a stranger
        #                 on the LAN can at most create a pending row an admin
        #                 will look at. No command rides the answer; nothing on
        #                 this path writes anything but that row.
        #
        #   the icons   — iOS fetches the apple-touch-icon when a page is added
        #                 to the home screen, and that fetch does not carry the
        #                 forward-auth session cookie. Gated, it is answered with
        #                 a 302 to the IdP, iOS reads HTML where it wanted a PNG,
        #                 and the home screen gets a generic letter tile instead.
        #                 The other two are here so a favicon behaves the same way
        #                 in any client that requests it outside a page load.
        #
        # A bypassed path is effectively public on the LAN, so each is written to
        # deserve it: three of these are the app's own artwork and the other two
        # authenticate themselves. Everything else on this app still needs a
        # passkey.
        authBypassRule = "Path(`/api/deploy`) || PathPrefix(`/mcp`) || Path(`/api/nodes/hello`) || Path(`/icon.svg`) || Path(`/icon.png`) || Path(`/apple-icon.png`)";
      };

      # The build log mount (volumes below) exists only once the App does, like
      # /github; BUILD_LOGS_PATH rides the same condition. mkMerge, not `//`,
      # for the stacks' contributions: a name two of them both set (or one of
      # them and this block) is a conflicting definition, never a silent
      # override.
      env = lib.mkMerge (
        map (d: d.env) dashboard
        ++ [
          (lib.optionalAttrs haveGithubApp { BUILD_LOGS_PATH = "/builds"; })
          # The model server on the first node that offers one (platform/
          # nodes.nix) — off-box, so it cannot come from webAppHosts, and absent
          # on a host with no such node: the AI → Lemonade tab reads the
          # variable's absence as "no server".
          (lib.optionalAttrs (config.fleet.lemonadeNodes != [ ]) (
            let
              node = lib.head config.fleet.lemonadeNodes;
            in
            {
              LEMONADE_URL = "http://${config.fleet.nodeHost node}:${toString node.providers.lemonade.port}";
            }
          ))
          {
            # Reached over the `monitoring` bridge added above.
            PROMETHEUS_URL = "http://prometheus:9090";
            LOKI_URL = "http://loki:3100";
            # What Nix last built. Two files, because they change at different rates:
            # the manifest is a store path (hand-written entries, rarely moves), the
            # snapshot is a stable path refreshed by daedalus-registry-snapshot on
            # every rebuild — so an Apply updates it WITHOUT restarting this app.
            NIX_MANIFEST_PATH = "/registry/manifest.json";
            NIX_REGISTRY_PATH = "/export/applied.json";
            # The fleet.export domains (platform/export.nix) — the successor to the
            # manifest and the env blobs; readers flip domain by domain.
            EXPORT_DIR = "/export";
            # The box's identity, read at RUN time (engine: src/host/site.ts) and
            # handed to the browser by the root loader. Not VITE_-prefixed any
            # more: Vite inlined those into the bundle, which made a built image
            # right for exactly one box. This is what lets the app carry no
            # hostname literals.
            # The per-service ones (REGISTRY_HOST, GRAFANA_URL,
            # REGISTRY_URL, PIHOLE_URL) arrive through fleet.dashboard from the
            # stack that owns each hostname, so a stack that is off leaves no
            # dangling address here.
            BASE_DOMAIN = config.fleet.baseDomain;
            GITHUB_OWNER = config.fleet.github.owner;
            # Where apply requests are dropped for the host agent.
            APPLY_DIR = "/apply";

            # The GitHub App. hooks.<baseDomain> is the webhook's public name: Vite
            # 403s any Host it was not told about (vite.config.ts allowedHosts,
            # comma-separated), so the cfweb router below would reach a server that
            # refuses it.
            APP_EXTRA_HOSTS = hooksHost;
            # This box's apply agent accepts vault/github-app.sops and nix consumes
            # it, so the engine may offer to create the App.
            GITHUB_APP_ENABLED = "1";
            # The token minter's installation.json and the webhook secret's dir.
            # Both mounts exist only once the App does (volumes below); until then
            # the engine reads their absence as "no App yet".
            GITHUB_TOKEN_PATH = "/github-token/installation.json";
            GITHUB_APP_DIR = "/github";

            # Dashboard: the non-secret half of what the DNS panel needs. The token
            # rides the rendered env file below; this is an identifier that appears
            # in the public dashboard URLs anyway. The box's zone (site.json); the
            # account and tunnel ids beside it are the tunnel's business and arrive
            # from stacks/cloudflared through fleet.dashboard while it runs.
            CF_ZONE_ID = config.fleet.cloudflare.zoneId;
            # The default route, which is the router. Bound from the site's gateway
            # (site.nix, from site.json) — the one place that says where this box
            # sends everything it cannot deliver itself, so no second copy can drift.
            GATEWAY_IP = config.fleet.gateway;
            # The product name, and ONLY that. The router serves no API, but its
            # login page carries a build stamp — model, hardware revision, firmware,
            # build date — so all four of those are read off the device and a
            # firmware bump reaches the tab with nothing edited here. What the stamp
            # does not carry is the name printed on the box, which is this.
            ROUTER_PRODUCT = config.fleet.daedalus.routerProduct;
            # Two URLs for one device, and the split is the point rather than an
            # oversight. The read is a machine fetching an unauthenticated login
            # page: the router's TLS is a self-signed certificate, so HTTPS there
            # would have to be verification-disabled, which buys nothing over plain
            # HTTP for a page that carries no secret. The LINK is a person about to
            # type an admin password, where TLS is the whole point. Both interpolate
            # the same gateway option, so neither can drift from the other.
            ROUTER_URL = "http://${config.fleet.gateway}";
            ROUTER_ADMIN_URL = "https://${config.fleet.gateway}/webpages/index.html#/login";
            # What nearly every pi-hole hosts entry points at. Bound from the option
            # that GENERATES those entries, so "this one points somewhere else" stays
            # a real distinction instead of a comparison against a stale literal.
            LAN_IP = config.fleet.lanIp;
            # The one address the game servers are reached by — the same string from
            # the sofa and from a hotel, because pi-hole answers it with the LAN
            # address and Cloudflare with the WAN one. Bound rather than typed so
            # the page cannot print a hostname this box no longer maintains.
            WAN_HOST = config.fleet.wanHost;
            # The per-service versions the pages read by name (N8N_VERSION,
            # POCKET_ID_VERSION, FACTORIO_VERSION, MINECRAFT_*, the AI sidecars'
            # …) are each stack's own contribution to fleet.dashboard now: the
            # stack that pins a version says what it is, and a stack that is off
            # says nothing. The full tag map rides /export/images.json (platform/
            # export.nix), and each named variable is deleted the day the engine
            # reads it from there instead. Traefik gets no variable either way — it
            # serves /api/version on the internal entrypoint, which reports what
            # the process is actually running rather than what the flake asked
            # for. The labels baked into the images on disk — the other half of the
            # version answer, for services whose pin is a moving tag — still arrive
            # as a snapshot:
            IMAGE_LABELS_PATH = "/images/labels.json";
            # The project workspaces snapshot (clones under ~/projects), published
            # by daedalus-workspace-{publish,sync}. The ROOT is bound too, display
            # only — the page says where a clone landed without restating the path.
            WORKSPACES_PATH = "/workspaces/workspaces.json";
            WORKSPACE_ROOT = workspaceRoot;
            # Where the MCP server finds ARCHITECTURE.md and BUILDS.md — the engine
            # repo root, read-only (volumes below). Named rather than hard-coded in
            # the app so the mount point is one fact, stated here.
            ENGINE_DOCS_DIR = "/engine";
            # Digest-vs-tag freshness, published daily by daedalus-image-freshness
            # into the same read-only mount.
            IMAGE_FRESHNESS_PATH = "/images/freshness.json";
            HOST_FACTS_PATH = "/system/system.json";
            CLAUDE_FACTS_PATH = "/claude/claude.json";
            REPO_FACTS_PATH = "/repo/repo.json";
            # The committed site.json, for the diff preview and for editing: the
            # directory itself, read-only, never the repository root.
            SITE_PATH = "/site";

            # The VPN tunnels, the DNS upstreams, the DHCP scope and direct ingress
            # all moved to /export domains (publishing.json, network.json) — fleet
            # facts pages render, which is exactly what env is NOT for. What stays
            # here is config: how the ddns job is set up, read from the service
            # definition so a change to the poll interval cannot leave a stale
            # number on a page.
            DDNS_HOST = lib.head (config.services.ddclient.domains ++ [ "" ]);
            DDNS_INTERVAL = config.services.ddclient.interval;
            DDCLIENT_VERSION = config.services.ddclient.package.version;
          }
        ]
      );
    };

    # The tunnel registry rides the publishing domain (platform/export.nix); the
    # derivation stays HERE because the tenant list comes from each container's
    # own --network=container: flag, which this module already reads.
    fleet.export.domains.publishing.data.vpnEgress = vpnEgress;

    # Same list-merge idiom stacks/litellm uses to add its token mount to
    # prometheus: the stack that OWNS the file contributes the mount, rather
    # than the apps platform learning about daedalus.
    # Gated on the apps switch for the reason on bridgeMemberships above — and at
    # the `containers` level: a `mkIf false` one level down would still create
    # an `app-daedalus` entry with no image.
    virtualisation.oci-containers.containers = lib.mkIf appsOn {
      app-daedalus.volumes = [
        "${nixManifest}:/registry/manifest.json:ro"
        # The fleet.export domains (platform/export.nix): versioned, stamped JSON
        # per domain at a STABLE path — the publisher re-runs on change, the
        # container just reads new bytes. This is the successor to both the
        # manifest above and the per-fact env blobs; readers flip domain by
        # domain, then the old channels are deleted.
        "/run/daedalus-export:/export:ro"
        "${applyDir}:/apply"
        # Last deploy result per app, written by app-<name>-deploy.service
        # (`<digest> ok|failed`). Read-only, and the DIRECTORY rather than the
        # files, so a rewritten state file is picked up without pinning an inode.
        "/var/lib/app-deploy:/deploy-state:ro"
        # The DIRECTORY, not the files: the snapshot rewrites each one, and a
        # single-file bind would pin the old inode.
        "${envDir}:/env-snapshot:ro"
        # Running image labels, published by daedalus-image-snapshot. The
        # DIRECTORY, not the file, for the same reason as above: the snapshot is
        # replaced by rename and a single-file bind would pin the old inode.
        "${imageDir}:/images:ro"
        # SMART, pools, snapshots, replication and generations, published by
        # daedalus-system-snapshot. Read-only, and no secret in it — the closest
        # thing is a drive serial, which is printed on the drive.
        "${systemDir}:/system:ro"
        # Remote Control's state, its live sessions and the credential clock,
        # published by daedalus-claude-snapshot. Read-only, and the credential
        # block in it is four non-secret fields copied out by name — the tokens
        # beside them in ~/.claude/.credentials.json never enter this file.
        #
        # The directory is 0700 and the file 0600, operator-owned: the one
        # snapshot here that carries a line of session content (the last prompt,
        # redacted host-side) is not readable by the build user or by anything
        # else on the box. This mount still works because the container runs as
        # container uid 0 = the operator on the host.
        "${claudeDir}:/claude:ro"
        # The configuration repository's state, published by
        # daedalus-repo-snapshot. Facts about the repo, never the repo: the tree
        # holds machine-generated plaintext under gitignored secrets/ dirs.
        "${repoDir}:/repo:ro"
        # site/ — the one directory daedalus writes — read-only here: the app
        # reads the committed site.json to edit against; the writes go through
        # the bridge as ever.
        "${config.fleet.site.path}:/site:ro"
        # The project workspaces snapshot — live git facts for every clone under
        # ~/projects plus each one's last sync outcome. The DIRECTORY, not the
        # file, like every snapshot here: it is replaced by rename and a
        # single-file bind would pin the old inode.
        "${workspacesDir}:/workspaces:ro"
        # The ENGINE repository — the public one the dev server already runs from,
        # read-only, so the MCP server can hand an agent the two design documents
        # at its repo root (ARCHITECTURE.md, BUILDS.md) before it acts. /app is a
        # bind of that clone's app/ subdirectory, so nothing above it is reachable
        # without this.
        #
        # The DIRECTORY, never the two files: git replaces a file on every pull and
        # a single-file bind would pin the old inode — the same rule every snapshot
        # mount here follows. Widening the mount does NOT widen what is served: the
        # app reads a hard allowlist of two names (host/mcp/docs.ts), there is no
        # path parameter, and this is the public engine repo, not this one.
        "${engineRoot}:/engine:ro"
      ]
      # The GitHub App's two read-only mounts, only once the App exists: a bind of
      # a missing source fails the whole container start. The DIRECTORIES, never
      # the files — both are replaced by rename or re-render.
      ++ lib.optionals haveGithubApp [
        # The webhook secret, alone (daedalus-github-render). Never the key.
        "${githubRenderDir}:/github:ro"
        # installation.json, from daedalus-github-token.
        "${githubTokenDir}:/github-token:ro"
        # The box builds' logs (daedalus-build, build-agent.nix): root-written,
        # already redacted, on the root filesystem so this mount never waits for the
        # builder's dataset. The directory, not a file — logs come and go.
        "${config.fleet.builder.logDir}:/builds:ro"
      ]
      # What the stacks mount into the control plane (fleet.dashboard.<id>.volumes):
      # pi-hole's rendered DHCP reservations at /dhcp, shotter's run archive at
      # /shotter. Each is the owner's contribution, absent with the owner.
      ++ lib.concatMap (d: d.volumes) dashboard;
    };

    # Dev mode builds the runtime stage on the box before the container starts
    # (mkLocalImage's `gates`); a host on the published image builds nothing.
    systemd.services.app-daedalus-image-build = lib.mkIf (appsOn && daedalusDev) devRuntime.service;

    # Refresh the published environments. A timer rather than an on-demand
    # request/response through the bind mount: a container's env only changes
    # when it restarts, so a page render should read a recent snapshot rather
    # than wait on a round trip through systemd.
    systemd.services.daedalus-env-snapshot = {
      description = "Publish app container environments for daedalus";
      # Runs rootless podman, so it must not be the boot's first podman:
      # platform/podman.nix creates the userns once, in the gate.
      after = [
        "podman-rootless-ready.service"
        "linger-users.service"
      ];
      wants = [
        "podman-rootless-ready.service"
        "linger-users.service"
      ];
      before = [ "podman-app-daedalus.service" ];
      wantedBy = [ "podman-app-daedalus.service" ];
      serviceConfig = {
        Type = "oneshot";
        ExecStart = "${envSnapshotScript}/bin/daedalus-env-snapshot";
      };
    };

    # The running images' OCI labels — where a service pinned to a moving tag
    # states the version its pin cannot. Ordered before daedalus like the env
    # snapshot, so a fresh boot has one before the first render.
    systemd.services.daedalus-image-snapshot = {
      description = "Publish running container image labels for daedalus";
      # Same gate as the env snapshot: on 2026-09-10 this unit was the
      # boot's first rootless podman, ran before the user manager had a
      # bus, and left a pause process that died with it.
      after = [
        "podman-rootless-ready.service"
        "linger-users.service"
      ];
      wants = [
        "podman-rootless-ready.service"
        "linger-users.service"
      ];
      before = [ "podman-app-daedalus.service" ];
      wantedBy = [ "podman-app-daedalus.service" ];
      serviceConfig = {
        Type = "oneshot";
        ExecStart = "${imageSnapshotScript}/bin/daedalus-image-snapshot";
      };
    };

    # Both snapshots fail SILENTLY from the reader's side, which is the whole
    # reason they are monitored. A missing image snapshot does not blank a page —
    # `imageVersion` falls back to the flake pin, and for the services whose pin
    # is a channel it reports "unknown", which is indistinguishable from a
    # service that genuinely has no version. So a stuck oneshot would show up as
    # Shelfmark and Recyclarr quietly going back to saying nothing.
    #
    # No `slug`: these are not dead-man jobs. A missed run costs a stale reading
    # of something that changes on rebuilds, so a failure email is the whole of
    # what is wanted.
    fleet.monitoredJobs.daedalus-image-snapshot = { };
    fleet.monitoredJobs.daedalus-env-snapshot = { };

    # Digest-vs-tag freshness. NOT ordered before the container, unlike the two
    # snapshots above: this dials fifty registries, and a network probe must
    # never gate the app's start — the reader treats an absent file as "not
    # checked yet" and the pages simply show no freshness verdict.
    systemd.services.daedalus-image-freshness = {
      description = "Check digest-pinned images against where their tags point now";
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];
      serviceConfig = {
        Type = "oneshot";
        ExecStart = "${imageFreshnessScript}/bin/daedalus-image-freshness";
        # ~55 refs with a polite sleep between network calls is a few minutes;
        # the oneshot default of 90s would SIGTERM it mid-list.
        TimeoutStartSec = "30min";
      };
    };

    # Daily is the honest cadence: upstream tags move on release schedules, the
    # answer feeds a verdict chip rather than an alert, and docker.io's
    # anonymous budget is the scarce resource. The four-hour jitter is the
    # rate-limit posture — never the same minute two days running, and never a
    # thundering herd with anything else nightly. The run itself is a few KB of
    # manifest reads, so the never-on-the-hour rule (a bandwidth rule) is not in
    # play; a run landing in the myspeed blackout costs error rows for a day,
    # which the reader renders as "registry did not answer".
    #
    # OnBootSec because /run is tmpfs: without it a reboot erases the file and
    # Persistent=true only covers a missed CALENDAR trigger, so the verdicts
    # would stay blank for up to a day after every boot.
    systemd.timers.daedalus-image-freshness = {
      wantedBy = [ "timers.target" ];
      timerConfig = {
        OnCalendar = "daily";
        RandomizedDelaySec = "4h";
        OnBootSec = "15min";
        Persistent = true;
      };
    };

    # Same argument as its siblings: the failure mode is silent from the
    # reader's side — verdicts quietly go stale, then (after the reader's 3-day
    # window) quietly disappear. No slug: a missed run costs a day-old reading
    # of something that moves in days.
    fleet.monitoredJobs.daedalus-image-freshness = { };

    # The export publisher must have populated /run/daedalus-export before the
    # container mounts it: rootless podman cannot create a root-owned /run dir,
    # and a bind mount of a missing source fails the whole container start.
    # (The publisher itself lives in platform/export.nix; only the ordering is
    # daedalus's concern.)
    systemd.services.daedalus-export-publish = {
      before = [ "podman-app-daedalus.service" ];
      wantedBy = [ "podman-app-daedalus.service" ];
    };

    # The host facts behind three System tabs. Runs as ROOT and unprivileged
    # nowhere: smartctl needs a raw device, and `zpool status` needs the pool.
    # No setpriv drop like its two siblings — there is no rootless store to
    # reach into here, only root-only tools.
    systemd.services.daedalus-system-snapshot = {
      description = "Publish SMART, ZFS and generation facts for daedalus";
      before = [ "podman-app-daedalus.service" ];
      wantedBy = [ "podman-app-daedalus.service" ];
      serviceConfig = {
        Type = "oneshot";
        ExecStart = "${systemSnapshotScript}/bin/daedalus-system-snapshot";
      };
    };

    # Same argument as the image snapshot: it fails silently from the reader's
    # side. A stale file does not blank the Disks tab, it shows yesterday's
    # temperatures as though they were now — which is worse than an empty panel,
    # because it looks like an answer.
    fleet.monitoredJobs.daedalus-system-snapshot = { };

    # Ten minutes. Everything in it moves in hours at best — a scrub runs
    # monthly, a self-test weekly, snapshot usage grows over days — and the one
    # genuinely live number, drive temperature, is not worth a shorter interval
    # on a box whose alerting has its own thresholds.
    systemd.timers.daedalus-system-snapshot = {
      wantedBy = [ "timers.target" ];
      timerConfig = {
        OnBootSec = "4min";
        OnUnitActiveSec = "10min";
      };
    };

    # Root for the same shape of reason as its sibling, though a narrower one:
    # the journal read wants the system journal rather than a user one. What it
    # reads out of ~/.claude it reads as the operator (host/claude-snapshot.sh).
    systemd.services.daedalus-claude-snapshot = {
      description = "Publish Claude Code remote-control and session facts for daedalus";
      before = [ "podman-app-daedalus.service" ];
      wantedBy = [ "podman-app-daedalus.service" ];
      serviceConfig = {
        Type = "oneshot";
        ExecStart = "${claudeSnapshotScript}/bin/daedalus-claude-snapshot";
      };
    };

    # One minute, and it is the shortest timer daedalus runs for a reason: a
    # session list is the one thing here that is worth nothing when it is old.
    # Somebody opening this page has usually just started a session from a
    # phone and wants to see it, and a ten-minute snapshot would answer "no
    # sessions" to a question asked about one that is running.
    #
    # It costs a systemctl call, four bounded journal seeks and a handful of
    # /proc reads — cheaper than the env snapshot, which already runs at two.
    systemd.timers.daedalus-claude-snapshot = {
      wantedBy = [ "timers.target" ];
      timerConfig = {
        OnBootSec = "90s";
        OnUnitActiveSec = "1min";
      };
    };

    # Silent from the reader's side like every snapshot here, and with a twist
    # of its own: the page it feeds is about Remote Control, which is how the
    # operator would be TALKING to this box when it broke. A mail is the only
    # channel that does not depend on the thing it reports on.
    fleet.monitoredJobs.daedalus-claude-snapshot = { };

    # Ordered before the container like the other snapshots, so a fresh boot
    # has a repo.json before the first render of the settings page.
    systemd.services.daedalus-repo-snapshot = {
      description = "Publish the configuration and site repositories' state for daedalus";
      before = [ "podman-app-daedalus.service" ];
      wantedBy = [ "podman-app-daedalus.service" ];
      serviceConfig = {
        Type = "oneshot";
        ExecStart = "${repoSnapshotScript}/bin/daedalus-repo-snapshot";
      };
    };

    # Five minutes: the facts change when someone commits or an Apply lands,
    # and both are rare enough that a reading up to five minutes old is the
    # truth for every practical purpose. The apply agent's own status file is
    # what the page reads for "is an Apply running now".
    systemd.timers.daedalus-repo-snapshot = {
      wantedBy = [ "timers.target" ];
      timerConfig = {
        OnBootSec = "2min";
        OnUnitActiveSec = "5min";
      };
    };

    fleet.monitoredJobs.daedalus-repo-snapshot = { };

    # Fifteen minutes, not two: an image label changes only when an image does,
    # which means a rebuild or a deploy pull — both of which restart the
    # container and re-run this via the ordering above. The timer is the
    # backstop for the third case, an out-of-band `podman pull`.
    systemd.timers.daedalus-image-snapshot = {
      wantedBy = [ "timers.target" ];
      timerConfig = {
        OnBootSec = "3min";
        OnUnitActiveSec = "15min";
      };
    };

    systemd.timers.daedalus-env-snapshot = {
      wantedBy = [ "timers.target" ];
      timerConfig = {
        OnBootSec = "2min";
        OnUnitActiveSec = "2min";
      };
    };

    fleet.statePaths.${applyDir} = { };
    # The approved nodes as prometheus targets: the control plane writes
    # `nodes/targets.json` under the apply bridge (app/src/host/node-targets.ts)
    # whenever a machine is approved, revoked, forgotten or moves address,
    # and prometheus discovers them from the file — a node joins the fleet's
    # metrics at approval, with no rebuild. The directory is pre-created so
    # the read-only mount has something to bind on a fresh box.
    fleet.statePaths."${applyDir}/nodes" = { };
    fleet.prometheusFileSd.nodes = "${applyDir}/nodes";

    # The nodes' names on the LAN, the same way: the control plane writes
    # `nodes/dhcp-hosts` — one dnsmasq `dhcp-host` line per approved node,
    # `<MAC>,<name>` — and this unit copies it where the resolver reads it
    # (`dhcp-hostsdir=/run/daedalus-nodes`, modules/pihole) and sends FTL a
    # HUP, which is what `pihole reloaddns` sends: dnsmasq re-reads its hosts
    # and dhcp-hosts files and renames the leases, without a restart and
    # without a gap in DNS. A directory rather than the file itself because
    # dnsmasq picks a NEW file in a hostsdir up on its own and needs the
    # signal only for a changed one; the copy exists so the resolver's user
    # never reads the operator's tree. Runtime rather than nix on purpose: a
    # MAC address is not for git (the household's reservations are sops for
    # the same reason), and a machine joining must not cost a rebuild. A MAC
    # the household file already names is the app's job to leave out, since
    # dnsmasq would see the same address twice.
    systemd.paths.daedalus-nodes-dhcp = {
      description = "Watch the nodes' DHCP name bindings from daedalus";
      wantedBy = [ "multi-user.target" ];
      # PathChanged only: PathExists would restart a oneshot every time it
      # finished with the file still there. Boot is covered by the service's
      # own wantedBy below.
      pathConfig.PathChanged = "${applyDir}/nodes/dhcp-hosts";
    };
    systemd.services.daedalus-nodes-dhcp = {
      description = "Hand the nodes' DHCP name bindings to the resolver";
      # Once at boot too, after the resolver, so a file written before the
      # reboot is in place when the first lease asks — the path unit alone
      # fires only on a change.
      wantedBy = [ "multi-user.target" ];
      after = lib.optional config.fleet.modules.pihole.enable "pihole-ftl.service";
      unitConfig.ConditionPathExists = "${applyDir}/nodes/dhcp-hosts";
      serviceConfig = {
        Type = "oneshot";
        RuntimeDirectory = "daedalus-nodes";
        RuntimeDirectoryPreserve = true;
        RuntimeDirectoryMode = "0755";
      };
      script = ''
        src=${lib.escapeShellArg "${applyDir}/nodes/dhcp-hosts"}
        dst=/run/daedalus-nodes/dhcp-hosts
        if [ -f "$src" ]; then
          install -m 0644 -o root -g root "$src" "$dst.tmp"
          mv -f "$dst.tmp" "$dst"
        else
          rm -f "$dst"
        fi
        ${lib.optionalString config.fleet.modules.pihole.enable ''
          # A HUP is only safe once FTL is up: in its first moments no
          # handler is installed and the signal's default action ends the
          # process — which is how the first activation of this unit took
          # LAN DNS down for four minutes (2026-09-23). A resolver that
          # started less than half a minute ago has read the directory
          # itself, and dnsmasq picks up a NEW file there without any
          # signal; the HUP is for a changed or removed line, and can wait
          # for the next write if it lands in that window.
          if systemctl is-active --quiet pihole-ftl.service; then
            started=$(systemctl show -p ActiveEnterTimestampMonotonic --value pihole-ftl.service)
            now=$(cut -d' ' -f1 /proc/uptime | tr -d .)0000
            if [ -n "$started" ] && [ "$(( now - started ))" -gt 30000000 ]; then
              systemctl kill --kill-whom=main -s HUP pihole-ftl.service
            else
              echo "pihole-ftl started under 30 s ago; leaving the HUP to the next write"
            fi
          fi
        ''}
      '';
    };
    fleet.prometheusScrapes = [
      {
        job_name = "nodes";
        file_sd_configs = [
          {
            files = [ "/etc/prometheus-sd/nodes/*.json" ];
            refresh_interval = "1m";
          }
        ];
      }
    ];
    # Rollback state (see prevDir). statePaths rather than a use-time mkdir
    # alone: it is the fleet's one convention for pre-creating these (tmpfiles
    # skips /home), it exists before the first Apply on a fresh restore, and
    # owner + 0700 are re-enforced at every boot. site-lib's mkdir is only the
    # fallback for a run that beats state-paths.service.
    fleet.statePaths.${prevDir}.mode = "0700";

    # Refreshes /run/daedalus-export/applied.json (the read-only /export mount)
    # from the committed registry. Ordered before
    # the container so the file exists on a cold boot; re-runs on any rebuild
    # that changed apps.json, because its ExecStart embeds that file's store path.
    systemd.services.daedalus-registry-snapshot = {
      description = "Publish the committed app registry for daedalus to read";
      before = [ "podman-app-daedalus.service" ];
      wantedBy = [
        "podman-app-daedalus.service"
        "multi-user.target"
      ];
      after = [ "local-fs.target" ];
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        ExecStart = "${registrySnapshot}/bin/daedalus-registry-snapshot";
      };
    };

    # The apply agent. Root, because only root can `nixos-rebuild switch`.
    #
    # Triggered by a path unit rather than a socket or an API: the container
    # writes request.json into the bind mount above, systemd notices, and this
    # runs. The container therefore holds no host privilege at all — the trust
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
      # switch. It used to survive only because its ExecStart happened to embed
      # nothing an Apply changes — luck rather than design, and silent when it
      # ran out. It no longer does: VAULT_APP_SECRETS is derived from apps.json,
      # so an Apply that adds an app now moves this unit's ExecStart, exactly
      # like its sibling daedalus-deploy-trigger. This line is what keeps that
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
        PathChanged = "${applyDir}/request.json";
      };
    };

    # Image updates. Same file-drop bridge, fifth verb — and the sibling of
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
    # (see stacks/apps) and is what makes deploys self-healing: a notification
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

    # The workspace clone agent — same file-drop bridge, sixth verb. Root
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

    # Not monitoredJobs, like power and claude-rc: both outcomes land in the
    # status file the page that asked is polling, and a genuine refusal exits 0.

    # Keep the clones current. Two triggers on one unit:
    #
    #   - the 30-minute timer — the cadence for the off-box projects, whose
    #     pushes nothing on this box hears about;
    #   - the path unit below — the hosted apps' push channel. Their deploy
    #     units rewrite /var/lib/app-deploy/<name>.json exactly when a new
    #     image lands (stacks/apps/assets/deploy.sh), which is minutes after
    #     the push that built it, so the workspace pulls right behind the code
    #     it is now running.
    #
    # Monotonic timer, deliberately off the hour (the myspeed rule); a sync is
    # a handful of `git fetch`es, so the cost is SSH round trips, not bandwidth.
    systemd.services.daedalus-workspace-sync = bridgeAgent // {
      description = "Fetch and fast-forward the project workspaces";
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];
      serviceConfig = {
        Type = "oneshot";
        ExecStart = "${mkWorkspaceSyncScript true}/bin/daedalus-workspace-sync";
        TimeoutStartSec = "15min";
      };
    };

    systemd.timers.daedalus-workspace-sync = {
      wantedBy = [ "timers.target" ];
      timerConfig = {
        OnBootSec = "6min";
        OnUnitActiveSec = "30min";
      };
    };

    systemd.paths.daedalus-workspace-sync = {
      description = "Sync the workspaces when an app deploy lands";
      wantedBy = [ "multi-user.target" ];
      # One entry per registry app, derived from the same apps.json the deploy
      # units are generated from — a path unit cannot glob, and a hand-kept
      # list would miss the next app.
      pathConfig.PathChanged = map (n: "/var/lib/app-deploy/${n}.json") (lib.attrNames registryApps);
    };

    # Silent from the reader's side like every snapshot: a stopped sync shows
    # yesterday's HEAD as though it were current, which reads as "no news from
    # this project" — the exact opposite of what happened.
    fleet.monitoredJobs.daedalus-workspace-sync = { };

    # Publish-only variant, ordered before the container for the same two
    # reasons as the system snapshot: the mount source must exist (rootless
    # podman cannot create a root-owned /run dir) and the page should have
    # facts on a cold boot. No network in it — a GitHub outage must never gate
    # the app's start (the image-freshness rule).
    systemd.services.daedalus-workspace-publish = {
      description = "Publish the project workspace facts for daedalus";
      before = [ "podman-app-daedalus.service" ];
      wantedBy = [ "podman-app-daedalus.service" ];
      serviceConfig = {
        Type = "oneshot";
        ExecStart = "${mkWorkspaceSyncScript false}/bin/daedalus-workspace-publish";
      };
    };

    # The site repository. Same file-drop bridge, sixth verb.
    #
    # `restartIfChanged = false` for the reason on the apps-platform rule: an
    # agent that can change its own unit definition must not be SIGTERMed
    # mid-run by the switch that lands the change. This one does not rebuild
    # anything today, but it is the agent the site repo's own settings will flow
    # through, and inheriting the flag now is cheaper than discovering it later.
    systemd.services.daedalus-site-write = bridgeAgent // {
      description = "Write daedalus's site files into the configuration repository";
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];
      restartIfChanged = false;
      serviceConfig = {
        Type = "oneshot";
        ExecStart = "${siteWriteScript}/bin/daedalus-site-write";
        # A few file writes and a git add; a push at most. Nothing waits on a build.
        TimeoutStartSec = "2min";
      };
    };

    systemd.paths.daedalus-site-write = {
      description = "Watch for a daedalus site-write request";
      wantedBy = [ "multi-user.target" ];
      pathConfig.PathChanged = "${applyDir}/site-request.json";
    };

    # Not monitoredJobs, for the same reason as the power agent: this only ever runs
    # because somebody pressed a button and is watching the page, and the
    # failure is reported there with the host's own message.
    # Restart. Same file-drop bridge, fourth verb, and the only one whose agent
    # does not outlive its own action.
    #
    # No network ordering, unlike the three above: this reads a local file, asks
    # systemd three questions and calls `systemctl reboot`. Nothing it does needs
    # a resolver.
    systemd.services.daedalus-power = bridgeAgent // {
      description = "Restart the box on daedalus's behalf";
      serviceConfig = {
        Type = "oneshot";
        ExecStart = "${powerScript}/bin/daedalus-power";
        # Everything before the reboot is a file read and three cheap checks; a
        # minute is already generous, and a hung agent here should surface rather
        # than sit on the rebuild lock it holds until it exits.
        TimeoutStartSec = "1min";
      };
    };

    systemd.paths.daedalus-power = {
      description = "Watch for a daedalus restart request";
      wantedBy = [ "multi-user.target" ];
      pathConfig.PathChanged = "${applyDir}/power-request.json";
    };

    # The claude-rc bridge's agent. Unlike daedalus-power it outlives its
    # action, so the ordinary status-file flow covers it end to end.
    systemd.services.daedalus-claude-rc = bridgeAgent // {
      description = "Restart the Claude Remote Control server on daedalus's behalf";
      serviceConfig = {
        Type = "oneshot";
        ExecStart = "${claudeRcScript}/bin/daedalus-claude-rc";
        # One restart and a five-second settle check; a minute means wedged.
        TimeoutStartSec = "1min";
      };
    };

    systemd.paths.daedalus-claude-rc = {
      description = "Watch for a daedalus claude-rc restart request";
      wantedBy = [ "multi-user.target" ];
      pathConfig.PathChanged = "${applyDir}/claude-rc-request.json";
    };

    # ── one resumed session, one unit ─────────────────────────────────────────
    #
    # `claude-session@<uuid>.service`. Started only by the agent above (or by
    # hand), never at boot: `wantedBy` is empty on purpose, because a template
    # that came up with the machine would resume whatever was running when it
    # went down, silently, with nobody watching.
    #
    # The unit IS the handle. Ending the session is `systemctl stop`, which
    # SIGTERMs the whole cgroup — no pid file to write, no `ps` output to match
    # on, and no pid-recycling race, which is the entire reason a resumed session
    # is a unit rather than a `tmux new-session -d` the way the operator has been
    # doing it by hand.
    #
    # `restartIfChanged = false` IS MANDATORY, for the reason written up at
    # platform/claude-rc.nix:9-27. A `sudo nixos-rebuild` typed inside a resumed
    # session runs in THIS unit's cgroup — sudo does not migrate cgroups — so an
    # activation that restarted the unit would SIGTERM the in-flight activation
    # that ordered the restart, leaving the box half-switched and the session
    # dead. That is the 2026-08-26 murder-suicide, and it happened to the Remote
    # Control server, which is a strictly less likely place to be running a
    # rebuild from than this one. A claude-code bump therefore reaches a resumed
    # session on its next start, never under it.
    systemd.services."claude-session@" = {
      description = "Claude Code session %i, resumed on request";
      # No wantedBy: instances exist only while something asked for one.
      after = [
        "network-online.target"
        "pihole-ready.service"
        "user@${toString config.fleet.operator.uid}.service"
      ];
      wants = [ "network-online.target" ];
      path = [ "/run/wrappers" ]; # sudo, for sessions that rebuild
      serviceConfig = {
        Type = "simple";
        User = config.fleet.operator.user;
        Group = config.fleet.operator.group;
        WorkingDirectory = lib.throwIf (lib.length claudeSessionCwds != 1) ''
          claudeSessionCwds has ${toString (lib.length claudeSessionCwds)} entries and this
          template has one WorkingDirectory. A second trusted directory needs an
          instance name that carries it (or a second template) — see the comment
          on claudeSessionCwds.
        '' (lib.head claudeSessionCwds);
        Environment = [
          "HOME=${config.users.users.${config.fleet.operator.user}.home}"
          "XDG_RUNTIME_DIR=/run/user/${toString config.fleet.operator.uid}"
          # The CLI renders an ink TUI into the pty `script` allocates; without a
          # TERM it has nothing to render against.
          "TERM=xterm-256color"
        ];
        ExecStart = "${claudeSessionRunner}/bin/claude-session-run %i";
        Restart = "no";
        # A `systemctl stop` is a requested end, not a fault: without this the
        # SIGTERM exit fires the failed-units alert every time the button works.
        SuccessExitStatus = [ 143 ];
      };
      restartIfChanged = false;
    };

    # The claude-session bridge's agent. Like claude-rc it outlives its action,
    # so `done` and `failed` are both real and the ordinary status poll covers
    # the flow end to end.
    #
    # bridgeAgent matters more here than anywhere else on this bridge: the board
    # carries a button PER ROW, which is exactly the burst surface the dropped
    # start limit exists for — five requests in ten seconds and systemd would
    # refuse the sixth silently, with the request file already in its final state
    # so nothing retriggers it.
    systemd.services.daedalus-claude-session = bridgeAgent // {
      description = "Resume or end one Claude Code session on daedalus's behalf";
      serviceConfig = {
        Type = "oneshot";
        ExecStart = "${claudeSessionScript}/bin/daedalus-claude-session";
        # A directory walk, one `claude agents` (10 s of timeout), a unit start
        # and a five-second settle check. A minute means wedged.
        TimeoutStartSec = "1min";
      };
    };

    systemd.paths.daedalus-claude-session = {
      description = "Watch for a daedalus session resume/stop request";
      wantedBy = [ "multi-user.target" ];
      pathConfig.PathChanged = "${applyDir}/claude-session-request.json";
    };

    # Not monitoredJobs, for the claude-rc agent's reason: both outcomes land in
    # the status file the page that asked is polling, and a genuine refusal exits
    # 0. A session that would not come up exits 1 and reaches `systemctl
    # --failed` and the failed-units alert, which is the only event here that
    # nobody may already be watching.

    # The secret-set bridge's agent. Like site-write and claude-rc it outlives
    # its action, so `done` and `failed` are both real and the ordinary status
    # poll covers the flow end to end.
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
        # Two sops runs, a git commit and a push. A minute is generous; past it
        # something is wedged and the page should say so rather than hang.
        TimeoutStartSec = "2min";
      };
    };

    systemd.paths.daedalus-secret-set = {
      description = "Watch for a daedalus app-secret write request";
      wantedBy = [ "multi-user.target" ];
      pathConfig.PathChanged = "${applyDir}/secret-set-request.json";
    };

    # Not monitoredJobs, for the site agent's reason: both outcomes land in the
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

    # Not monitoredJobs, like power, claude-rc and the workspace clone: both
    # outcomes land in the status file the page that asked is polling, a genuine
    # refusal exits 0, and the task's OWN failure already mails through
    # fleet.monitoredJobs.app-<app>-task-<id> — mailing here as well would send
    # two emails for one failed run.

    # Not monitoredJobs, for the power agent's reason: both outcomes land in the
    # status file and are shown on the page that asked. The only mailable event
    # is the agent itself breaking, which `systemctl --failed` and the failed-
    # units alert already carry.

    # Not monitoredJobs either, and for a sharper version of the site agent's
    # reason: a refusal is shown on the page that asked for it, and a SUCCESS
    # takes the mail relay down with the rest of the box before anything could be
    # sent. The only email this unit could ever deliver is a failure to reboot.

    # A failed apply means the box may have been rolled back without anyone
    # watching the UI. Mail it.
    fleet.monitoredJobs.daedalus-apply = { };

    # ── the GitHub App: the public webhook path (whenever the app runs) ─────
    #
    # GitHub delivers to https://hooks.<baseDomain>/api/github/webhook through
    # the Cloudflare tunnel, and that is the ONLY thing the name answers:
    #
    #   - cfweb only. No websecure router, no pi-hole record: on the LAN the
    #     name falls through to traefik's 404 like any unknown host. The tunnel
    #     is the one way in, which is also what makes Cf-Connecting-Ip the
    #     client address (cfweb trusts X-Forwarded-* only from traefik-net).
    #   - POST to the exact path. A GET, any other path, `/` — no router
    #     matches, traefik 404s, and nothing of the app is reachable from
    #     the internet through this name.
    #   - No forward-auth: GitHub cannot hold a passkey. The route authenticates
    #     itself (HMAC over the raw body, against the webhook secret below), and
    #     answers 503 while no secret exists.
    #   - The strip middleware, exactly as the app's own router and the deploy
    #     hook (stacks/registry) carry it: a request that skips the gate must
    #     not arrive holding a forged X-Forwarded-Email.
    #   - A rate limit per client, because this is the one daedalus path on the
    #     open internet. 10/s with a burst of 50 is far above GitHub's delivery
    #     rate and still caps a flood before it reaches the dev server.
    #   - Per client is weak on its own (an IPv6 client has addresses to spare),
    #     and daedalus has no memory cap and reads a body whole before it can
    #     check the HMAC. So traefik bounds what reaches it: `buffering` reads
    #     the body in traefik and answers 413 past 5 MiB (the engine's own
    #     limit), so an oversized or trickled body never reaches Vite; and
    #     `inFlightReq` lets at most 10 requests for this host through at once,
    #     whoever sends them.
    #   - Order: strip; the rate limit, which reads no body, so a refused
    #     request costs traefik nothing; buffering; the in-flight cap last, so
    #     a slow uploader holds a traefik buffer rather than one of the ten
    #     slots GitHub's deliveries need.
    #
    # Gated on the apps switch, like the container itself: the route names the
    # app's own service and reads its own webApp entry, neither of which exists
    # on a host that has the control plane's agents but not (yet) its container.
    fleet.traefikRawRules."hooks-github.yml" = lib.mkIf appsOn (
      let
        inherit (config.fleet.webApps) daedalus;
      in
      builtins.toJSON {
        http = {
          middlewares = {
            hooks-github-ratelimit.rateLimit = {
              average = 10;
              period = "1s";
              burst = 50;
              sourceCriterion.requestHeaderName = "Cf-Connecting-Ip";
            };
            hooks-github-buffering.buffering.maxRequestBodyBytes = 5242880;
            hooks-github-inflight.inFlightReq = {
              amount = 10;
              sourceCriterion.requestHost = true;
            };
          };
          routers.hooks-github-rtr = {
            entryPoints = [ "cfweb" ];
            rule = "Host(`${hooksHost}`) && Path(`/api/github/webhook`) && Method(`POST`)";
            middlewares = lib.optional (daedalus.authHeaders != { }) "oidc-daedalus-strip@file" ++ [
              "hooks-github-ratelimit@file"
              "hooks-github-buffering@file"
              "hooks-github-inflight@file"
            ];
            # The app's own service (webApps.daedalus → traefikRoutes.daedalus).
            service = "daedalus-svc";
          };
        };
      }
    );

    # The tunnel ingress + the proxied CNAME route-sync keeps for it. The label
    # is reserved by the assertion at the top of this module.
    fleet.cloudflareRoutes = lib.mkIf appsOn { daedalus-hooks.hostname = hooksHost; };

    # How the agent on another machine finds this control plane without
    # being told: an SRV record under the LAN's search domain, answered by
    # the resolver this box runs. The target is the control plane's own
    # hostname, which the same resolver answers with the LAN address; 443 is
    # traefik, and /api/nodes/hello is on the auth bypass above.
    fleet.dnsSrv = lib.mkIf appsOn [
      {
        service = "_daedalus._tcp";
        target = config.fleet.apps.daedalus.hostname;
        port = 443;
      }
    ];

    # ── the GitHub App: credentials (once site/vault/github-app.sops exists) ─
    #
    # One sops JSON file, three values: `pem`, `webhookSecret`, `clientSecret`.
    # Two are declared here, both root 0400 — sops-nix needs every secret read
    # from one file to share a format, hence json for both. `clientSecret` is
    # not declared at all: nothing on the box uses the App's OAuth half yet.
    #
    # The key is consumed where it is decrypted, by the root minter below, and
    # rotating it re-mints at once.
    sops.secrets."github-app-pem" = lib.mkIf haveGithubApp {
      sopsFile = githubAppVault;
      format = "json";
      key = "pem";
      owner = "root";
      mode = "0400";
      restartUnits = [ "daedalus-github-token.service" ];
    };
    # The webhook secret reaches the container through a copy (the render
    # below): the root-only original stays unreadable to it.
    sops.secrets."github-app-webhook-secret" = lib.mkIf haveGithubApp {
      sopsFile = githubAppVault;
      format = "json";
      key = "webhookSecret";
      owner = "root";
      mode = "0400";
      restartUnits = [
        "daedalus-github-render.service"
        "podman-app-daedalus.service"
      ];
    };

    # Copy the webhook secret into /run/daedalus-github, the container's /github.
    # `install` of the decrypted file, NOT the render heredoc: the heredoc ends
    # the file with a newline, and an HMAC keyed on "secret\n" rejects every
    # delivery GitHub signs with "secret". The heredoc only writes a marker
    # naming where the copy came from.
    systemd.services.daedalus-github-render = lib.mkIf haveGithubApp (mkSecretRender {
      description = "Copy the GitHub App webhook secret for daedalus to verify deliveries";
      gates = [ "podman-app-daedalus.service" ];
      dir = githubRenderDir;
      file = "${githubRenderDir}/source";
      mode = "0444";
      prep = ''
        install -m 0400 -o ${config.fleet.operator.user} -g ${config.fleet.operator.group} ${
          config.sops.secrets."github-app-webhook-secret".path
        } ${githubRenderDir}/webhook-secret
      '';
      content = "webhook-secret: copied from the sops secret github-app-webhook-secret (site/vault/github-app.sops, key webhookSecret)";
    });

    # The minter's output dir: root-owned and root-only-writable, so its
    # write_json_atomic publishes directly as root and nothing the container
    # controls can be planted at the name. tmpfiles (not statePaths) because
    # it is /run, and `d` with no age so a rebuild never empties it.
    systemd.tmpfiles.settings."10-daedalus-github-token" = lib.mkIf haveGithubApp {
      ${githubTokenDir}.d = {
        mode = "0755";
        user = "root";
        group = "root";
      };
    };

    # The token minter. Root, because the key is root's; network-ordered and
    # deliberately NOT ordered before the container — a GitHub outage must never
    # gate the app's start (the image-freshness rule).
    systemd.services.daedalus-github-token = lib.mkIf haveGithubApp (
      bridgeAgent
      // {
        description = "Mint the daedalus GitHub App's installation token";
        after = [ "network-online.target" ];
        wants = [ "network-online.target" ];
        serviceConfig = {
          Type = "oneshot";
          ExecStart = "${githubTokenScript}/bin/daedalus-github-token";
          # Two GitHub calls at 15 s each, plus a revoke at most.
          TimeoutStartSec = "2min";
          # The JWT, the token answer and the curl configs live in a mktemp dir;
          # a private /tmp keeps even their names off the shared one.
          PrivateTmp = true;
          UMask = "0077";
        };
      }
    );

    # A token lives 60 minutes; every 30 means a reader always holds one with
    # 25+ left (the engine wants 5). Monotonic, so never on the hour.
    systemd.timers.daedalus-github-token = lib.mkIf haveGithubApp {
      wantedBy = [ "timers.target" ];
      timerConfig = {
        OnBootSec = "1min";
        OnUnitActiveSec = "30min";
      };
    };

    # The bridge verb: the app asks for a fresh token now (a 401, an install
    # that just landed) instead of waiting for the tick. Throttled in the
    # script to one mint a minute.
    systemd.paths.daedalus-github-token = lib.mkIf haveGithubApp {
      description = "Watch for a daedalus GitHub token refresh request";
      wantedBy = [ "multi-user.target" ];
      pathConfig.PathChanged = "${applyDir}/github-token-request.json";
    };

    # Silent from the reader's side like every snapshot: a stopped minter leaves
    # a token that simply expires, and every GitHub call after that fails in a
    # place far from here. GitHub being down exits 0 (the file says so); what
    # mails is the minter itself breaking.
    fleet.monitoredJobs.daedalus-github-token = lib.mkIf haveGithubApp { };

    # The fleet's per-service read-only API keys — the credentials daedalus reads
    # other services' numbers with.
    #
    # `fleet.daedalus.serviceKeysSopsFile` (the host's file) is the store: one encrypted file, all the keys minted by
    # some OTHER service and handed to the control plane to read with. Three
    # secrets are NOT in it, on purpose, because they already have an encrypted
    # home in the stack that mints them: pocket-id's read-only API key, the
    # litellm master key and the registry's deploy-hook token each reach this
    # container as an env file THAT stack renders (fleet.dashboard.<id>.envFiles
    # — pocket-id-daedalus-key, litellm-daedalus-key, registry-daedalus-token).
    # Nothing in this box's secret tree exists twice; rotation always touches
    # exactly one file, and this module never greps another stack's secret.
    #
    # `grep -m1` on each: a missing key renders empty rather than failing the
    # unit, and the panel that needs it degrades to "no data" instead of taking
    # the whole page down. That is not hypothetical — a key minted by hand in
    # some app's UI is absent until someone goes and mints it.
    #
    # The render dir is deliberately NOT /run/app-daedalus — that is the
    # container unit's RuntimeDirectory, and systemd wipes it when the container
    # stops (the trap that produced nextcloud-redis's 500s).
    sops.secrets."daedalus-service-keys" = mkDotenvSecret config.fleet.daedalus.serviceKeysSopsFile;

    # A rotation of the Cloudflare token (site/vault, rendered by
    # platform/site.nix): re-render the dashboard keys, then restart the app
    # that reads them at start.
    sops.templates."cloudflare-api-token.env".restartUnits = [
      "daedalus-dashboard-keys.service"
      "podman-app-daedalus.service"
    ];

    systemd.services."daedalus-dashboard-keys" =
      let
        store = config.sops.secrets."daedalus-service-keys".path;
        # <n> in the store → DASH_<n> in the container's environment.
        serviceKeys = [
          "JELLYFIN_API_KEY"
          "SONARR_API_KEY"
          "RADARR_API_KEY"
          "BAZARR_API_KEY"
          "PROWLARR_API_KEY"
          "SEERR_API_KEY"
          "QBT_USER"
          "QBT_PASS"
          "IMMICH_API_KEY"
          "NEXTCLOUD_KEY"
          "HASS_API_KEY"
          "GROCY_API_KEY"
          "N8N_API_KEY"
          "OPENWEBUI_KEY"
          "CALIBREWEB_USER"
          "CALIBREWEB_PASS"
          "GRAFANA_USER"
          "GRAFANA_PASS"
          "HEALTHCHECKS_API_KEY"
          "WGEASY_USER"
          "WGEASY_PASS"
          # Optional override for the GitHub reads (the add-an-app repo picker
          # and the release-notes panels): a narrow read-only PAT, taking
          # precedence over GHTOKEN below. Empty by default, and the reason to
          # fill it is scope rather than capability — see the note on GHTOKEN.
          "GITHUB_REPO_TOKEN"
        ];
      in
      mkSecretRender {
        description = "Render the per-service API keys daedalus's dashboard reads";
        gates = [ "podman-app-daedalus.service" ];
        dir = "/run/daedalus-dashboard";
        file = "/run/daedalus-dashboard/env";
        prep = lib.concatStringsSep "\n" (
          map (k: "${k}=$(grep -m1 '^${k}=' ${store} | cut -d= -f2- || true)") serviceKeys
          ++ [
            # The box's one Cloudflare API token, read from its single encrypted
            # home (site/vault, rendered by platform/site.nix — platform, not a
            # stack, which is what makes this a read of the box's own secret
            # rather than another stack's). One token carries every scope
            # daedalus reads with: Zone:Read + DNS for the domain picker and
            # the DNS panel, "Cloudflare One Connector: cloudflared" Read for
            # the tunnel panels. It is DNS-edit-capable (lego and route-sync
            # need that); daedalus only ever GETs with it.
            "CF_TOKEN=$(grep -m1 '^CF_DNS_API_TOKEN=' ${config.fleet.cloudflare.tokenEnvFile} | cut -d= -f2- | tr -d '\"' || true)"
            # There is no DASH_GITHUB_TOKEN any more. It used to be the GHCR
            # pull credential re-shaped — a classic PAT carrying `repo`, which
            # is read-WRITE on every repository on the account — and that
            # credential died with the Actions runners. Its two consumers each
            # have a better source now: the release-notes panels and the NixOS
            # channel check fall back to the GitHub App's installation token
            # (GITHUB_TOKEN_PATH), and for the add-an-app repo picker, which
            # genuinely needs to SEE this account's private repos, the supported
            # credential is a fine-grained read-only PAT in GITHUB_REPO_TOKEN
            # (service-keys.sops, in serviceKeys above). Unset, the picker lists
            # the account's PUBLIC repos and says so.
          ]
        );
        content = lib.concatStringsSep "\n" (
          map (k: "DASH_${k}=\${${k}}") serviceKeys ++ [ "DASH_CF_API_TOKEN=\${CF_TOKEN}" ]
        );
      };
  };
}
