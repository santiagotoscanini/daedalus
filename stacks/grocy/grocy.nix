# grocy — linuxserver PHP-FPM image. Split-horizon publish: LAN +
# CF tunnel reach the same hostname. Bridge-routed via traefik
# (`http://grocy:80`, no host port).
#
# PUID/PGID quirk: PHP-FPM's internal safety check refuses UID 0
# regardless of the kernel's view. Use the linuxserver default
# (PUID=911 / PGID=911) by NOT setting those env vars. Container UID
# 911 → host UID 100910 in the subuid range (100000 + 910); the data
# dir is chowned 100910:100910 to match.

{ config, mkRootlessContainer, ... }:

{
  myStack.containerNetworks.grocy = "traefik";
  myStack.webApps.grocy = {
    hostname = "grocy.toscanini.me";
    serviceName = "grocy";
    port = 80;
    exposeRemotely = true;
  };

  myStack.homepageServices."Productivity" = [{
    name = "Grocy";
    href = "https://grocy.toscanini.me";
    description = "Household inventory & chores";
    icon = "grocy.png";
    siteMonitor = "https://grocy.toscanini.me";
  }];

  virtualisation.oci-containers.containers.grocy = mkRootlessContainer {
    image = "docker.io/linuxserver/grocy:latest";

    volumes = [
      "/home/santiago/selfhost/grocy/config:/config"
    ];

    extraOptions = [
      "--network=traefik-net"
    ];
  };
}
