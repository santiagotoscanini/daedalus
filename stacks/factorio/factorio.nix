# factorio — OpenFactorioServerManager (ofsm) wraps the headless
# Factorio server with a web UI for saves/mods/RCON.
#
# The admin UI is LAN-only (bridge-routed via traefik on
# `factorio-admin.toscanini.me`, no `exposeRemotely`); the game port
# (UDP 34197) is still published on the host so external players can
# connect.
#
# UID note: ofsm's image has no USER directive, so it runs as
# container-root → host santiago (UID 1000:100) under rootless. The
# previous bare factoriotools image used UID 845 → host 100844, so
# the existing on-disk saves/mods/config need to be re-chowned to
# 1000:100 — the `Z` tmpfiles rule below does that on every rebuild.
#
# FACTORIO_VERSION pins the headless binary ofsm downloads on every
# container start (yes, every start — harmless but slow). Keep it
# matched to the clients' game version or they will refuse to join.

{ mkRootlessContainer, ... }:

{
  myStack.containerNetworks.factorio = "traefik";

  myStack.webApps.factorio-admin = {
    hostname    = "factorio-admin.toscanini.me";
    serviceName = "factorio";
    port        = 80;
  };

  myStack.homepageServices."Productivity" = [{
    name = "Factorio Admin";
    href = "https://factorio-admin.toscanini.me";
    description = "Factorio server manager";
    icon = "/icons/factorio.png";
    siteMonitor = "https://factorio-admin.toscanini.me";
  }];

  # Only the game port faces the world; UI is LAN-only via Traefik.
  # (Old module also opened 27015/tcp for RCON; ofsm handles RCON
  # internally so that host port is no longer needed.)
  networking.firewall.allowedUDPPorts = [ 34197 ];

  systemd.tmpfiles.rules = [
    "d /home/santiago/selfhost/factorio              0755 santiago users -"
    "d /home/santiago/selfhost/factorio/fsm-data     0755 santiago users -"
    "d /home/santiago/selfhost/factorio/mod_packs    0755 santiago users -"
    "d /home/santiago/selfhost/factorio/data         0755 santiago users -"
    # Re-chown existing saves/mods/config from the old image UID
    # (100844) to ofsm's container-root UID (santiago/1000).
    "Z /home/santiago/selfhost/factorio/data         - santiago users -"
  ];

  virtualisation.oci-containers.containers.factorio = mkRootlessContainer {
    image = "docker.io/ofsm/ofsm:0.10.1";

    environment = {
      FACTORIO_VERSION = "2.0.77";
    };

    environmentFiles = [ "/etc/nixos/stacks/factorio/secrets/env" ];

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

    extraOptions = [
      "--network=traefik-net"
    ];
  };
}
