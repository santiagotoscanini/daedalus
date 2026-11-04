# factorio — OpenFactorioServerManager (ofsm) wraps the headless
# Factorio server with a web UI for saves/mods/RCON.
#
# The admin UI is LAN-only (bridge-routed via traefik on
# `factorio-admin.<baseDomain>` by default, no `exposeRemotely`); the game port
# (UDP 34197) is still published on the host so external players can
# connect.
#
# UID note: ofsm's image has no USER directive, so it runs as
# container-root → the operator under rootless, which
# owns the data dirs.
#
# FACTORIO_VERSION pins the headless binary ofsm downloads on every
# container start (yes, every start — harmless but slow). Keep it
# matched to the clients' game version or they will refuse to join — so it
# is the host's to say (`fleet.modules.factorio.version`): a default here
# would be a version somebody else's players are on.
#
# daedalus moves it (Gaming › Factorio, and the `version.update` MCP tool)
# through fleet.versionPins: the agent finds the host's `version = "<v>";`
# line, rewrites it, rebuilds, and passes only when the downloaded binary
# reports the new version (assets/verify-version.sh).
#
# The host brings:
#   fleet.modules.factorio.enable       the switch (default off, as every catalog module)
#   fleet.modules.factorio.version      the headless server version (required), written
#                                       `version = "<v>";` on a line of its own so daedalus can move it
#   fleet.modules.factorio.envSopsFile  ADMIN_USER, ADMIN_PASS, RCON_PASS, COOKIE_ENCRYPTION_KEY
#   fleet.images.factorio               the digest-pinned OFSM image

{
  config,
  lib,
  pkgs,
  mkRootlessContainer,
  mkDotenvSecret,
  pinnedImage,
  ...
}:

let
  cfg = config.fleet.modules.factorio;
  factorioVersion = cfg.version;
  dataDir = "${config.fleet.stateRoot}/factorio";

  # The dataset the saves live on, found by its mountpoint rather than named:
  # a host that gives the stack its own can have the updater snapshot it
  # before the switch. Null when the saves share a wider dataset — rolling
  # that back would undo every other stack's writes since.
  saveDataset = lib.findFirst (
    n:
    lib.elem (config.fleet.zfs.datasets.${n}.mount or null) [
      dataDir
      "${dataDir}/data/saves"
    ]
  ) null (builtins.attrNames config.fleet.zfs.datasets);

  verifyVersion = pkgs.writeShellApplication {
    name = "factorio-verify-version";
    runtimeInputs = [
      pkgs.podman
      pkgs.coreutils
      pkgs.util-linux
    ];
    text = ''
      OPERATOR_USER=${lib.escapeShellArg config.fleet.operator.user}
      OPERATOR_GROUP=${lib.escapeShellArg config.fleet.operator.group}
      OPERATOR_HOME=${lib.escapeShellArg config.fleet.operator.home}
      OPERATOR_RUNTIME_DIR=${lib.escapeShellArg config.fleet.operator.runtimeDir}
      ${builtins.readFile ./assets/verify-version.sh}
    '';
  };
in
{
  options.fleet.modules.factorio = {
    enable = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "The headless Factorio server behind OpenFactorioServerManager.";
    };

    version = lib.mkOption {
      type = lib.types.str;
      example = "2.0.77";
      description = ''
        The headless server version OFSM downloads at every start. Keep it
        matched to the players' clients, and mind that a bump can migrate
        the save. No default: this is which game the house is playing.
        Write it as `version = "<v>";` on a line of its own: that line is
        how daedalus finds the pin to move it.
      '';
    };

    envSopsFile = lib.mkOption {
      type = lib.types.path;
      example = lib.literalExpression "./host/sops/factorio/env.sops";
      description = ''
        sops-encrypted dotenv carrying OFSM's ADMIN_USER and ADMIN_PASS (its
        own login — the admin UI is not behind the identity gate),
        RCON_PASS and COOKIE_ENCRYPTION_KEY. Host data: the engine carries
        no box's ciphertext. Only read while the module is on.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    # The preflight's question before a reboot (platform/upgrade-guard). No
    # RCON port reaches the host (the manager drives RCON itself), so the
    # count is unknowable from here; what is knowable is whether a game runs.
    fleet.upgradeGuard.checks.factorio-players = ''
      if podman_op exec factorio pgrep -f 'bin/x64/factorio' >/dev/null 2>&1; then
        echo "a Factorio game is running; its player count is not readable without RCON — ask, or check the manager"
        return 2
      fi
      echo "no Factorio game running (only the manager, or nothing)"
    '';

    # Handed to the control plane (fleet.dashboard) so its Gaming tile shows
    # the running version rather than carrying a second copy of the number.
    # It is the same string the container downloads on start, so the tile
    # cannot drift from what is installed — and it is absent, not stale,
    # when this stack is switched off.
    fleet.dashboard.factorio.env.FACTORIO_VERSION = factorioVersion;

    # The version, movable from daedalus (version-update.nix). The binding is
    # the option's own name, as the host writes it in its `factorio` block.
    fleet.versionPins.factorio = {
      container = "factorio";
      fields.version = {
        binding = "version";
        value = factorioVersion;
        pattern = "[0-9]+\\.[0-9]+\\.[0-9]+";
      };
      dataset = saveDataset;
      verify = lib.getExe verifyVersion;
    };

    # ofsm admin credentials, decrypted to /run/secrets/factorio-env at
    # activation. Edit the host's file (`envSopsFile`) with `sops`.
    sops.secrets."factorio-env" = mkDotenvSecret cfg.envSopsFile;

    fleet.bridgeMemberships.factorio = [ "traefik" ];

    fleet.webApps.factorio-admin = {
      # The conventional label; a host that wants another defines
      # `fleet.webApps.factorio-admin.hostname` itself.
      hostname = lib.mkDefault "factorio-admin.${config.fleet.baseDomain}";
      serviceName = "factorio";
      port = 80;
    };

    # Only the game port faces the world; UI is LAN-only via Traefik.
    # (No RCON host port — ofsm drives RCON internally.)
    networking.firewall.allowedUDPPorts = [ 34197 ];

    # The router forwards this port — see fleet.directIngress.
    fleet.directIngress.factorio = {
      port = 34197;
      note = "The Factorio protocol is UDP and the game client dials the address directly, so this cannot ride the tunnel.";
    };

    fleet.statePaths = {
      "${config.fleet.stateRoot}/factorio" = { };
      "${config.fleet.stateRoot}/factorio/fsm-data" = { };
      "${config.fleet.stateRoot}/factorio/mod_packs" = { };
      "${config.fleet.stateRoot}/factorio/data" = { };
      "${config.fleet.stateRoot}/factorio/data/config" = { };
      "${config.fleet.stateRoot}/factorio/data/mods" = { };
      "${config.fleet.stateRoot}/factorio/data/saves" = { };
    };

    # Its blast radius is other people. The port is
    # router-forwarded and the server has live players, so a restart kicks
    # whoever is on it — and a Factorio version bump can force a save
    # migration that the previous build will not open afterwards.
    fleet.imageUpdates.factorio.ceremony = "live players get kicked, and a version bump can migrate the save";

    virtualisation.oci-containers.containers.factorio = mkRootlessContainer {
      image = pinnedImage "factorio" "docker.io/ofsm/ofsm";

      environment = {
        FACTORIO_VERSION = factorioVersion;
      };

      environmentFiles = [ config.sops.secrets."factorio-env".path ];

      ports = [
        "34197:34197/udp"
      ];

      volumes = [
        "${config.fleet.stateRoot}/factorio/fsm-data:/opt/fsm-data"
        "${config.fleet.stateRoot}/factorio/mod_packs:/opt/fsm/mod_packs"
        "${config.fleet.stateRoot}/factorio/data/saves:/opt/factorio/saves"
        "${config.fleet.stateRoot}/factorio/data/mods:/opt/factorio/mods"
        "${config.fleet.stateRoot}/factorio/data/config:/opt/factorio/config"
      ];

      # The ofsm wrapper needs >10s to forward SIGTERM and let the Factorio
      # server flush a final autosave; the default 10s stop-timeout SIGKILLs
      # it mid-save at reboot, so live players lose progress since the last
      # periodic save.
      extraOptions = [
        "--stop-timeout=30"
      ];

    };
  };
}
