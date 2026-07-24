# factorio — OpenFactorioServerManager (ofsm) wraps the headless
# Factorio server with a web UI for saves/mods/RCON.
#
# The admin UI is LAN-only (bridge-routed via traefik on
# `factorio-admin.toscanini.me`, no `exposeRemotely`); the game port
# (UDP 34197) is still published on the host so external players can
# connect.
#
# UID note: ofsm's image has no USER directive, so it runs as
# container-root → host santiago (UID 1000:100) under rootless, which
# owns the data dirs.
#
# FACTORIO_VERSION pins the headless binary ofsm downloads on every
# container start (yes, every start — harmless but slow). Keep it
# matched to the clients' game version or they will refuse to join.

{
  config,
  mkRootlessContainer,
  mkDotenvSecret,
  ...
}:

let
  # Pinned game version ofsm downloads + runs on every start. Surfaced
  # on the homepage tile so it can be matched against the Steam client
  # at a glance, without opening the admin UI. Bump this one place on a
  # game update (clients on a different version can't join).
  factorioVersion = "2.0.77";
in
{
  # ofsm admin credentials: sops-encrypted env.sops, decrypted to
  # /run/secrets/factorio-env at activation. Edit with `sops env.sops`.
  sops.secrets."factorio-env" = mkDotenvSecret ./env.sops;

  fleet.bridgeMemberships.factorio = [ "traefik" ];

  fleet.webApps.factorio-admin = {
    hostname = "factorio-admin.toscanini.me";
    serviceName = "factorio";
    port = 80;
    homepage = {
      group = "Productivity";
      name = "Factorio Admin";
      description = "v${factorioVersion} · server manager";
      icon = "/icons/factorio.png";
      # Through traefik (not container DNS): OFSM answers redirects the
      # widget prober handles better on the public hostname.
      siteMonitor = "https://factorio-admin.toscanini.me";
    };
  };

  # Only the game port faces the world; UI is LAN-only via Traefik.
  # (No RCON host port — ofsm drives RCON internally.)
  networking.firewall.allowedUDPPorts = [ 34197 ];

  fleet.statePaths = {
    "/home/santiago/selfhost/factorio" = { };
    "/home/santiago/selfhost/factorio/fsm-data" = { };
    "/home/santiago/selfhost/factorio/mod_packs" = { };
    "/home/santiago/selfhost/factorio/data" = { };
    "/home/santiago/selfhost/factorio/data/config" = { };
    "/home/santiago/selfhost/factorio/data/mods" = { };
    "/home/santiago/selfhost/factorio/data/saves" = { };
  };

  virtualisation.oci-containers.containers.factorio = mkRootlessContainer {
    image = "docker.io/ofsm/ofsm:0.10.1@sha256:2b031bc1ec51e437a90b24266ce87f82362b4d16670e3804688610b4ac03b608";

    environment = {
      FACTORIO_VERSION = factorioVersion;
    };

    environmentFiles = [ config.sops.secrets."factorio-env".path ];

    ports = [
      "34197:34197/udp"
    ];

    volumes = [
      "/home/santiago/selfhost/factorio/fsm-data:/opt/fsm-data"
      "/home/santiago/selfhost/factorio/mod_packs:/opt/fsm/mod_packs"
      "/home/santiago/selfhost/factorio/data/saves:/opt/factorio/saves"
      "/home/santiago/selfhost/factorio/data/mods:/opt/factorio/mods"
      "/home/santiago/selfhost/factorio/data/config:/opt/factorio/config"
    ];

    # The ofsm wrapper needs >10s to forward SIGTERM and let the Factorio
    # server flush a final autosave; the default 10s stop-timeout SIGKILLs
    # it mid-save at reboot, so live players lose progress since the last
    # periodic save.
    extraOptions = [
      "--stop-timeout=30"
    ];

  };
}
