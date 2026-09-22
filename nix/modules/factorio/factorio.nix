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
# The host brings:
#   fleet.modules.factorio.enable       the switch (default off, as every catalog module)
#   fleet.modules.factorio.version      the headless server version (required)
#   fleet.modules.factorio.envSopsFile  ADMIN_USER, ADMIN_PASS, RCON_PASS, COOKIE_ENCRYPTION_KEY
#   fleet.images.factorio               the digest-pinned OFSM image

{
  config,
  lib,
  mkRootlessContainer,
  mkDotenvSecret,
  pinnedImage,
  ...
}:

let
  # Pinned game version ofsm downloads + runs on every start. Surfaced on
  # daedalus's Gaming tile so it can be matched against the Steam client at
  # a glance, without opening the admin UI. Bump this one place on a
  # game update (clients on a different version can't join).
  cfg = config.fleet.modules.factorio;
  factorioVersion = cfg.version;
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
    # Handed to the control plane (fleet.dashboard) so its tile renders the
    # running version rather than carrying a second copy of the number. It is
    # the same string the container downloads on start, so the tile cannot
    # drift from what is actually installed — and it is absent, not stale,
    # when this stack is switched off.
    fleet.dashboard.factorio.env.FACTORIO_VERSION = factorioVersion;

    # ofsm admin credentials: sops-encrypted env.sops, decrypted to
    # /run/secrets/factorio-env at activation. Edit with `sops env.sops`.
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

    # The one stack here whose blast radius is other people. The port is
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
