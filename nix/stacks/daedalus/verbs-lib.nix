# verbs-lib — the scripts behind the control plane's host verbs: the file-drop
# bridge's agents (the container writes `<verb>-request.json` into the apply
# dir, a path unit starts the matching agent) and the units of the root
# helper's verbs (ARCHITECTURE.md's root-helper table). Their services are
# daedalus-verbs.nix and daedalus-github.nix. Each is the env nix hands it
# followed by the shell under host/. A plain function, imported by path; never
# a module.
{
  config,
  lib,
  pkgs,
}:

let
  inherit (import ./daedalus-lib.nix { inherit config lib pkgs; })
    applyDir
    verbsDir
    prevDir
    siteLock
    registryApps
    engineRoot
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

  # The apps whose operator-secrets file the secret-set verb may write: the
  # same committed registry `vaultAppSecrets` above is built from, as bare
  # NAMES. One list, two shapes, because the two agents want different things
  # from it — apply.sh matches a payload key against a path, secret-set.sh
  # builds the path itself from a name it has matched.
  #
  # This is the security control on that verb (host/secret-set.sh), exactly as
  # `runnableTasks` is on the `task-run` verb: an app the box has not applied has no
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
      pkgs.util-linux # setpriv, flock
    ];
    vars =
      operatorHomeVars
      // commitVars
      // {
        PREV_DIR = prevDir;
        SITE_LOCK = siteLock;
        # The identity sops opens the sealed value with, read by root alone.
        HOSTKEY = lib.head config.sops.age.sshKeyPaths;
        SITE_DIR = config.fleet.site.path;
        SECRET_APPS = lib.concatStringsSep " " secretApps;
        # sopsStatic, the same binary the container bind-mounts. Nothing here
        # runs in a container, but `pkgs.sops` would be a SECOND 49 MB sops in
        # the system closure for no difference in behaviour.
        SOPS = "${sopsStatic}/bin/sops";
        # The same derivation sops-nix uses at activation, which is why the
        # identity it produces matches the `age13…` recipient in site/.sops.yaml.
        SSH_TO_AGE = "${pkgs.ssh-to-age}/bin/ssh-to-age";
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
      pkgs.util-linux # setpriv, flock
      pkgs.coreutils
      pkgs.gnugrep
      pkgs.gawk # lib.sh log_errtail
      config.system.build.nixos-rebuild # the system's own: ng, named nixos-rebuild
      config.fleet.upgradeGuard.package # fleet-switch-guard (host/lib.sh)
      pkgs.openssh # git push over ssh
    ];
    vars =
      operatorHomeVars
      // commitVars
      // {
        APPLY_DIR = applyDir;
        PREV_DIR = prevDir;
        SITE_LOCK = siteLock;
        FLAKE = config.fleet.config.repo;
        SITE_DIR = config.fleet.site.path;
        # The one tree the engine override may build from (host/lib.sh
        # site_engine_override): nix's fact, never the document's.
        ENGINE_CLONE = engineRoot;
        VAULT_APP_SECRETS = vaultAppSecrets;
        LOCKFILE = config.fleet.rebuildLock;
        HOSTNAME = config.networking.hostName;
      };
    files = [
      ./host/lib.sh
      ./host/site-lib.sh
      ./host/apply.sh
    ];
  };

  # Restart the box: the root helper's `reboot` (controller.nix, `root`), not
  # a file-drop verb. It takes nothing from anyone — host/power.sh has why
  # poweroff exists nowhere.
  powerScript = mkAgent {
    name = "daedalus-power";
    runtimeInputs = [
      pkgs.systemd
      pkgs.procps # pgrep
      pkgs.util-linux # flock
      pkgs.coreutils
    ];
    vars = {
      LOCKFILE = config.fleet.rebuildLock;
    };
    files = [
      ./host/lib.sh
      ./host/power.sh
    ];
  };

  # The clone agent. See host/workspace-clone.sh
  # for why the ssh key never enters the container and what shape the slug
  # is held to.
  workspaceCloneScript = mkAgent {
    name = "daedalus-workspace-clone";
    runtimeInputs = workspaceRuntimeInputs;
    vars = workspaceVars;
    files = [
      ./host/lib.sh
      ./host/workspace-lib.sh
      ./host/workspace-clone.sh
    ];
  };

  # Move a pin and rebuild onto it — the one root verb here that edits nix
  # source rather than copying bytes the app rendered.
  #
  # `PINS` is the same registry the freshness probe reads, plus the update
  # policy: it is simultaneously the parse (what ref is this container on),
  # the allowlist (a container absent from it reaches no command) and the
  # lockstep table. Rendered by nix from the running config, so it cannot
  # describe a container the box does not have. The hand-moved pins ride in
  # it too, keyed by their id and marked `local`: a base the configuration
  # pins is moved exactly like a container's pin and verified by its label;
  # the rest are there so a request for one is refused by name, with the file
  # to edit, rather than as an unknown container.
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
      config.system.build.nixos-rebuild # the system's own: ng, named nixos-rebuild
      config.fleet.upgradeGuard.package # fleet-switch-guard (host/lib.sh)
      pkgs.openssh # git push over ssh
    ];
    vars =
      operatorHomeVars
      // commitVars
      // {
        VERBS_DIR = verbsDir;
        FLAKE = config.fleet.config.repo;
        # For lib.sh's site_engine_override: the agent refuses while one is set.
        SITE_DIR = config.fleet.site.path;
        PINS =
          let
            inherit (config.fleet.export.domains.images) data;
          in
          pkgs.writeText "daedalus-image-pins.json" (
            builtins.toJSON (
              data.pins
              // lib.mapAttrs (
                _: p:
                {
                  local = true;
                }
                // lib.getAttrs [
                  "repo"
                  "tag"
                  "digest"
                  "updatable"
                  "lockstep"
                  "ceremony"
                  "containers"
                  "label"
                  "pinnedIn"
                ] p
              ) data.manual
            )
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

  # The same undertaker for an Apply: a run killed mid-rebuild (its timeout, OOM)
  # would otherwise leave apply-status.json `running` and the Apply button
  # refused until the app's staleness clock ran out.
  applyReaper = mkUpdateReaper {
    name = "daedalus-apply-reaper";
    statusFile = "apply-status.json";
    nextSteps = "The rebuild may or may not have completed — check `journalctl -u daedalus-apply` and `git log` in ${config.fleet.config.repo} before applying again";
  };

  # The status file's undertaker (host/update-reaper.sh). A queued batch is a
  # long run, so the unit's timeout and the app's clock are both an hour; this
  # bounds the wedge a crash leaves to seconds.
  imageUpdateReaper = mkUpdateReaper {
    name = "daedalus-image-update-reaper";
    dir = verbsDir;
    statusFile = "image-update-status.json";
    nextSteps = "Nothing was necessarily committed — check `journalctl -u 'daedalus-image-update@*'` and `git log` in ${config.fleet.config.repo}";
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
    secretApps
    secretSetScript
    applyScript
    applyReaper
    powerScript
    workspaceCloneScript
    imageUpdateScript
    imageUpdateReaper
    githubTokenScript
    ;
}
