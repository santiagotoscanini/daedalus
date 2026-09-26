# verbs-lib — the scripts behind the file-drop bridge's verbs: the container
# writes `<verb>-request.json` into the apply dir, a path unit starts the
# matching agent (daedalus-verbs.nix, daedalus-github.nix), and the agent is
# one of these. Each is the env nix hands it followed by the shell under
# host/. A plain function, imported by path; never a module.
{
  config,
  lib,
  pkgs,
}:

let
  inherit (import ./daedalus-lib.nix { inherit config lib pkgs; })
    applyDir
    prevDir
    registryApps
    deployableApps
    mkUpdateReaper
    mkAgent
    operatorVars
    operatorHomeVars
    commitVars
    workspaceVars
    workspaceRuntimeInputs
    githubAppField
    githubTokenDir
    ;

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
  # filter). Baking this in makes apps.json part of daedalus-apply's
  # ExecStart, which the unit's `restartIfChanged = false` covers — see the
  # note there.
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
  secretSetScript = mkAgent {
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
    vars =
      operatorHomeVars
      // commitVars
      // {
        APPLY_DIR = applyDir;
        PREV_DIR = prevDir;
        SITE_DIR = config.fleet.site.path;
        SECRET_APPS = lib.concatStringsSep " " secretApps;
        SYSTEMCTL = "${pkgs.systemd}/bin/systemctl";
        GIT = "${pkgs.git}/bin/git";
        # sopsStatic, the same binary the container bind-mounts. Nothing here
        # runs in a container, but `pkgs.sops` would be a SECOND 49 MB sops in
        # the system closure for no difference in behaviour.
        SOPS = "${sopsStatic}/bin/sops";
        # The same derivation sops-nix uses at activation, which is why the
        # identity it produces matches the `age13…` recipient in site/.sops.yaml.
        SSH_TO_AGE = "${pkgs.ssh-to-age}/bin/ssh-to-age";
        HOST_SSH_KEY = lib.head config.sops.age.sshKeyPaths;
      };
    files = [
      ./host/lib.sh
      ./host/site-lib.sh
      ./host/secret-set.sh
    ];
  };

  applyScript = mkAgent {
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
    vars =
      operatorHomeVars
      // commitVars
      // {
        APPLY_DIR = applyDir;
        PREV_DIR = prevDir;
        FLAKE = config.fleet.config.repo;
        SITE_DIR = config.fleet.site.path;
        VAULT_APP_SECRETS = vaultAppSecrets;
        GIT = "${pkgs.git}/bin/git";
        LOCKFILE = config.fleet.rebuildLock;
        HOSTNAME = config.networking.hostName;
      };
    files = [
      ./host/lib.sh
      ./host/site-lib.sh
      ./host/apply.sh
    ];
  };

  # The `<app>:<taskId>` pairs that actually have an
  # `app-<app>-task-<taskId>.service` to start. Same gate the platform applies
  # (modules/apps/apps.nix generates a task's units only while the app is past
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

  deployTriggerScript = mkAgent {
    name = "daedalus-deploy-trigger";
    runtimeInputs = [
      pkgs.jq
      pkgs.systemd
      pkgs.coreutils
    ];
    vars = operatorVars // {
      APPLY_DIR = applyDir;
      DEPLOYABLE = lib.concatStringsSep " " deployableApps;
    };
    files = [
      ./host/lib.sh
      ./host/deploy-trigger.sh
    ];
  };

  # Run one of an app's scheduled tasks now. A sibling of the deploy trigger,
  # and the same shape: the unit already exists (modules/apps generates it from
  # the registry's `tasks`), this only starts it out of band and reports the
  # outcome to the page that asked. See host/task-run.sh.
  taskRunScript = mkAgent {
    name = "daedalus-task-run";
    runtimeInputs = [
      pkgs.jq
      pkgs.systemd
      pkgs.coreutils
    ];
    vars = operatorVars // {
      APPLY_DIR = applyDir;
      RUNNABLE = lib.concatStringsSep " " runnableTasks;
    };
    files = [
      ./host/lib.sh
      ./host/task-run.sh
    ];
  };

  # Restart the box. A bridge with a single verb: see
  # host/power.sh for why poweroff has no branch there at all, and why the
  # replay guard matters more here than in any of its siblings.
  #
  # No allowlist to carry and no argument from the request reaches a command —
  # the request body is read for exactly one string, which is compared against
  # one literal.
  powerScript = mkAgent {
    name = "daedalus-power";
    runtimeInputs = [
      pkgs.jq
      pkgs.systemd
      pkgs.procps # pgrep
      pkgs.util-linux # flock
      pkgs.coreutils
    ];
    vars = operatorVars // {
      APPLY_DIR = applyDir;
      LOCKFILE = config.fleet.rebuildLock;
    };
    files = [
      ./host/lib.sh
      ./host/power.sh
    ];
  };

  # Restart the Remote Control server. It exists because rebooting the box
  # (the power bridge) is oversized for its commonest customer: a
  # wedged or version-stale claude-remote-control is a single unit, and a
  # remote session cannot restart it without killing itself (the session
  # lives in that unit's cgroup — see platform/claude-rc.nix, whose
  # restartIfChanged = false is also why rebuilds no longer land updates
  # onto it). See host/claude-rc.sh for the verb and its guards.
  claudeRcScript = mkAgent {
    name = "daedalus-claude-rc";
    runtimeInputs = [
      pkgs.jq
      pkgs.systemd
      pkgs.coreutils
    ];
    vars = operatorVars // {
      APPLY_DIR = applyDir;
    };
    files = [
      ./host/lib.sh
      ./host/claude-rc.sh
    ];
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
  # ONE entry today, and the template unit (daedalus-verbs.nix) fixes it as its
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
  # The uuid is re-validated here, not only by the agent, because this is also the
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
  claudeSessionScript = mkAgent {
    name = "daedalus-claude-session";
    runtimeInputs = [
      pkgs.coreutils
      pkgs.gawk
      pkgs.gnused
      pkgs.jq
      pkgs.systemd
      pkgs.util-linux # setpriv
    ];
    vars = operatorVars // {
      APPLY_DIR = applyDir;
      OPERATOR_HOME = config.users.users.${config.fleet.operator.user}.home;
      CLAUDE_HOME = "${config.users.users.${config.fleet.operator.user}.home}/.claude";
      CLI_STORE = toString pkgs.claude-code;
      TRUSTED_CWDS = lib.concatStringsSep " " claudeSessionCwds;
      TRUSTED_SLUGS = lib.concatStringsSep " " (map claudeSessionSlug claudeSessionCwds);
    };
    files = [
      ./host/lib.sh
      ./host/claude-session.sh
    ];
  };

  # The clone agent. See host/workspace-clone.sh
  # for why the ssh key never enters the container and what shape the slug
  # is held to.
  workspaceCloneScript = mkAgent {
    name = "daedalus-workspace-clone";
    runtimeInputs = workspaceRuntimeInputs;
    vars = workspaceVars // {
      APPLY_DIR = applyDir;
    };
    files = [
      ./host/lib.sh
      ./host/workspace-lib.sh
      ./host/workspace-clone.sh
    ];
  };

  # Move a pin and rebuild onto it — the one bridge verb here that edits nix
  # source rather than copying bytes the app rendered.
  #
  # `PINS` is the same registry the freshness probe reads, plus the update
  # policy: it is simultaneously the parse (what ref is this container on),
  # the allowlist (a container absent from it reaches no command) and the
  # lockstep table. Rendered by nix from the running config, so it cannot
  # describe a container the box does not have.
  imageUpdateScript = mkAgent {
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
    vars =
      operatorHomeVars
      // commitVars
      // {
        APPLY_DIR = applyDir;
        FLAKE = config.fleet.config.repo;
        # For lib.sh's site_engine_override: the agent refuses while one is set.
        SITE_DIR = config.fleet.site.path;
        PINS = pkgs.writeText "daedalus-image-pins.json" (
          builtins.toJSON config.fleet.export.domains.images.data.pins
        );
        LOCKFILE = config.fleet.rebuildLock;
        HOSTNAME = config.networking.hostName;
        OPERATOR_RUNTIME_DIR = config.fleet.operator.runtimeDir;
        PODMAN = "${pkgs.podman}/bin/podman";
      };
    files = [
      ./host/lib.sh
      ./host/image-update.sh
    ];
  };

  # The status file's undertaker (host/update-reaper.sh). A queued batch is a
  # long run, so the unit's timeout and the app's clock are both an hour; this
  # bounds the wedge a crash leaves to seconds.
  imageUpdateReaper = mkUpdateReaper {
    name = "daedalus-image-update-reaper";
    statusFile = "image-status.json";
    nextSteps = "Nothing was necessarily committed — check `journalctl -u daedalus-image-update` and `git log` in ${config.fleet.config.repo}";
  };

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

  # The token minter. host/github-token.sh opens with why the key stays here.
  githubTokenScript = mkAgent {
    name = "daedalus-github-token";
    runtimeInputs = [
      pkgs.openssl
      pkgs.curl
      pkgs.jq
      pkgs.coreutils
      pkgs.gnused # gh_redact
      pkgs.util-linux # setpriv, for lib.sh's operator-side status publish
    ];
    vars = operatorVars // {
      PEM = config.sops.secrets."github-app-pem".path;
      CLIENT_ID = githubAppField "clientId";
      OWNER = githubAppField "owner";
      # The trusted constant, never site.json's copy (platform/site.nix
      # asserts the two agree).
      OWNER_ID = config.fleet.github.expectedOwnerId;
      OUT_DIR = githubTokenDir;
      APPLY_DIR = applyDir;
    };
    files = [
      ./host/lib.sh
      ./host/github-lib.sh
      ./host/github-token.sh
    ];
  };
in
{
  inherit
    secretSetScript
    applyScript
    deployTriggerScript
    taskRunScript
    powerScript
    claudeRcScript
    claudeSessionCwds
    claudeSessionRunner
    claudeSessionScript
    workspaceCloneScript
    imageUpdateScript
    imageUpdateReaper
    githubTokenScript
    ;
}
