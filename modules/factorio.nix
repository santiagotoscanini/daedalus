# factorio — headless game server, no Traefik route (raw UDP/TCP).
#
# Pinned to the version players are using; clients refuse to connect
# to a server on a different version. When updating, bump this tag AND
# make sure savegames are compatible.
#
# The image's internal `factorio` user is UID 845. Under our rootless
# mapping (subuid 100000:65536), container UID 845 -> host UID 100844.
# `/home/santiago/selfhost/factorio/data` is chowned to match.

{ mkRootlessContainer, ... }:

{
  myStack.containerNetworks.factorio = null;

  # No traefik route — Factorio's protocol is raw UDP. Open the game
  # port + RCON directly in the host firewall.
  networking.firewall.allowedUDPPorts = [ 34197 ];
  networking.firewall.allowedTCPPorts = [ 27015 ];

  virtualisation.oci-containers.containers.factorio = mkRootlessContainer {
    image = "docker.io/factoriotools/factorio:2.0.76";

    ports = [
      "34197:34197/udp"
      "27015:27015/tcp"
    ];

    volumes = [
      "/home/santiago/selfhost/factorio/data:/factorio"
    ];
  };
}
