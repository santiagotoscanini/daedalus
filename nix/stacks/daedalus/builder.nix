# The builder — everything that exists permanently so a build CAN run: the
# two users, the rootless BuildKit daemon, the scratch dataset, the egress
# fence and the registry push credential. What happens per build (the path
# unit, host/build.sh, its gate and reaper) is ./build-agent.nix; the pinned
# Railpack, its frontend and mise are ./railpack.nix. The agent reads
# everything it needs from here as `config.fleet.builder.*`, declared below.
#
# ── the map ───────────────────────────────────────────────────────────────
#
#   builder.nix                     this module: the users, the options, and
#                                   the merge of the four parts below
#   builder/daemon.nix              buildkitd: its config, start/prep/ready
#                                   scripts, the unit and its limits
#   builder/storage.nix             the scratch dataset's layout, the check
#                                   that it is mounted, the log directory
#   builder/fence.nix               the egress fence: firewall rules, their
#                                   teardown, and fenceCheck
#   builder/registry-credential.nix the zot push password: generation, the
#                                   one safe reader, the docker config.json
#
# Each part is a plain function returning its values and the `settings` it
# contributes; this file merges them, so it stays the only module (a new
# module would reorder the firewall script's pieces — engine rule §6).
#
# Gated like daedalus.nix's App half: nothing here exists until
# site/vault/github-app.sops is in the flake. The option values and the
# fence's teardown are NOT gated — see those blocks for why.
#
# Two users, two jobs:
#   buildkit        runs the daemon. Owns a subuid/subgid range of its own
#                   (300000+65536, clear of the operator's 100000+65536), so a build
#                   step that escapes its sandbox lands as a uid that owns
#                   nothing of the operator's, holds no secret and reaches no LAN.
#   daedalus-build  runs everything that touches repo content on the host:
#                   clones, `railpack prepare`, the `buildctl` client. Holds the
#                   clone token, and the registry push credential only as the
#                   per-build copy host/build.sh makes for the one publishing
#                   buildctl call: `railpack prepare` runs repository mise code
#                   as this user, so the rendered original is root 0400. The
#                   daemon reads neither (credentials reach BuildKit over the
#                   session).
#
# Which rebuilds matter:
#   builder/daemon.nix (toml, start script, limits) → buildkitd restarts (kills a running build)
#   builder/fence.nix                                → firewall reload
#   ./railpack.nix                                   → nothing restarts; the next build uses it

{
  config,
  lib,
  pkgs,
  nixpkgs-unstable,
  mkSecretRender,
  ...
}:

let
  cfg = config.fleet.builder;

  # The same condition as daedalus-lib.nix's `haveGithubApp`, restated: the
  # App's credentials are in the flake.
  githubAppVault =
    if config.fleet.site.source == null then
      null
    else
      "${config.fleet.site.source}/vault/github-app.sops";
  haveGithubApp = githubAppVault != null && builtins.pathExists githubAppVault;

  # buildkit 0.32 from unstable: 25.11 ships 0.25, and `[frontend."gateway.v0"]
  # allowedRepositories` needs >= 0.26. legacyPackages rather than a second
  # `import` (claude-code needs one for allowUnfree; buildkit is Apache-2.0).
  inherit (nixpkgs-unstable.legacyPackages.${pkgs.stdenv.hostPlatform.system}) buildkit;

  # Pinned, so the fence matches numbers: a name lookup is one more thing that
  # can fail inside the firewall script at early boot. Free on this box and in
  # nixos/modules/misc/ids.nix (which ends at 327; dynamic system ids count
  # down from 999). Each group shares its user's number.
  ids = {
    buildkitUid = 350;
    buildUid = 351;
    # buildkit's subordinate ids: clear of the operator's 100000+65536.
    subIdStart = 300000;
    subIdCount = 65536;
  };

  # The four parts (the map above).
  fence = import ./builder/fence.nix {
    inherit
      config
      lib
      pkgs
      ids
      ;
  };
  daemon = import ./builder/daemon.nix {
    inherit
      config
      lib
      pkgs
      buildkit
      ;
    inherit (fence) fenceCheck;
  };
  storage = import ./builder/storage.nix { inherit config lib pkgs; };
  credential = import ./builder/registry-credential.nix {
    inherit
      config
      lib
      pkgs
      mkSecretRender
      ;
  };
in
{
  options.fleet.builder =
    let
      ro =
        type: description:
        lib.mkOption {
          inherit type description;
          readOnly = true;
        };
      inherit (lib) types;
    in
    {
      # A default, unlike the rest (and so not readOnly — a default counts as
      # a definition there): modules/registry reads this to decide whether the
      # builder gets an htpasswd user, and must get "no" rather than an eval
      # error when the control plane is switched off.
      enable = lib.mkOption {
        type = types.bool;
        default = false;
        description = "Whether the builder exists (the GitHub App's vault file is in the flake, and the control plane is on).";
      };
      socket = ro types.str "buildctl --addr for the daemon; group daedalus-build, 0660.";
      buildkitPackage = ro types.package "The buildkit the daemon runs; use its buildctl.";
      railpack = ro types.package "The pinned railpack CLI (./railpack.nix).";
      railpackFrontend = ro types.str "The gateway frontend ref matching `railpack`, tag and digest.";
      miseBinary = ro types.path "The pinned mise railpack runs on the host (./railpack.nix). Bind it read-only at `misePath`.";
      misePath = ro types.str "Where railpack's ensureInstalled looks for mise; a file there means no download.";
      dockerConfigDir = ro types.str "DOCKER_CONFIG for buildctl: config.json with the registry push credential.";
      root = ro types.str "The scratch dataset's mount point.";
      workDir = ro types.str "Per-build work dirs (daedalus-build 0700).";
      miseCacheDir = ro types.str "Railpack's mise caches, one `<app>/` each (root 0700; build.sh mounts one at /tmp/railpack).";
      logDir = ro types.str "Build logs, on the root filesystem (root 0755).";
      user = ro types.str "The unprivileged client user (also its group).";
      registryHost = ro types.str "The registry the builder pushes to.";
      # Not readOnly: a host CONTRIBUTES it from the stack that publishes the
      # mirror, inside that stack's own switch.
      npmMirrorHost = lib.mkOption {
        type = types.nullOr types.str;
        default = null;
        example = "npm.example.org";
        description = ''
          Hostname of an npm registry mirror THIS box publishes (through the
          reverse proxy, on the LAN address): a build installs through
          `https://<host>/` and pins the name to the LAN address inside
          BuildKit, where the box's own resolver is not reachable. Null: builds
          install straight from registry.npmjs.org.
        '';
      };
      registryUser = ro types.str "zot htpasswd user for pushes.";
      registryPasswordFile = ro types.str "Machine-generated dotenv carrying REGISTRY_BUILDER_PASSWORD (root 0600).";
      registryPasswordRead = ro types.path "Script printing the builder password; refuses a missing, foreign-owned, non-0600, empty or short file. Capture into a variable, never argv.";
      fenceCheck = ro types.path "Fails unless the egress fence's OUTPUT jumps for both builder uids and buildkit's subuid range are loaded. Run it as root (`+`) in ExecStartPre of every unit that runs as, or drives, the builder users.";
    };

  config = lib.mkIf config.fleet.modules.daedalus.enable (
    lib.mkMerge [
      # ── Always: the contract values, and the fence's teardown ─────────────
      {
        fleet.builder = {
          enable = haveGithubApp;
          socket = "unix://${daemon.socketPath}";
          buildkitPackage = buildkit;
          dockerConfigDir = "/run/daedalus-build";
          root = "/var/lib/daedalus-builds";
          workDir = "${cfg.root}/work";
          miseCacheDir = "${cfg.root}/railpack-mise";
          logDir = "/var/log/daedalus-builds";
          user = "daedalus-build";
          registryHost = config.fleet.webApps.registry.hostname;
          registryUser = "builder";
          registryPasswordFile = "${credential.secretsDir}/registry-builder.env";
          inherit (credential) registryPasswordRead;
          inherit (fence) fenceCheck;
        };
      }
      fence.alwaysSettings

      # ── While the builder exists ────────────────────────────────────────
      (lib.mkIf haveGithubApp (
        lib.mkMerge [
          {
            # The description names builder.nix, and stays: it is the user's
            # passwd entry, part of the system, not a comment.
            users.groups.buildkit.gid = ids.buildkitUid;
            users.users.buildkit = {
              uid = ids.buildkitUid;
              isSystemUser = true;
              group = "buildkit";
              description = "Rootless BuildKit daemon (stacks/daedalus/builder.nix)";
              subUidRanges = [
                {
                  startUid = ids.subIdStart;
                  count = ids.subIdCount;
                }
              ];
              subGidRanges = [
                {
                  startGid = ids.subIdStart;
                  count = ids.subIdCount;
                }
              ];
            };

            users.groups.${cfg.user}.gid = ids.buildUid;
            users.users.${cfg.user} = {
              uid = ids.buildUid;
              isSystemUser = true;
              group = cfg.user;
              description = "daedalus build client (clones, railpack prepare, buildctl)";
              # Created by daedalus-builds-layout (builder/storage.nix), after
              # the dataset mounts.
              home = "${cfg.root}/home";
              createHome = false;
            };
          }
          storage.settings
          daemon.settings
          fence.settings
          credential.settings
        ]
      ))
    ]
  );
}
