# grocy — linuxserver image (PHP-FPM). Split-horizon publish: LAN
# clients hit traefik:443 directly via pi-hole short-circuit; off-LAN
# clients reach the same hostname through the Cloudflare tunnel.
#
# PUID/PGID quirk: unlike the tv stack (PUID=0 maps to host santiago),
# grocy's image runs PHP-FPM, which has an internal safety check that
# refuses UID 0 regardless of the kernel's view. So we use the
# linuxserver default (PUID=911 / PGID=911) by NOT setting those env
# vars. Container UID 911 maps to host UID 100910 via the subuid range
# (100000 + 910); the data dir is chowned to match (100910:100910).

{ config, mkRootlessContainer, ... }:

{
  myStack.containerNetworks.grocy = null;
  myStack.webApps.grocy = {
    hostname = "grocy.toscanini.me";
    port = 8084;
    exposeRemotely = true;
  };


  myStack.homepageServices."Productivity" = [{
    name = "Grocy";
    href = "https://grocy.toscanini.me";
    description = "Household inventory & chores";
    icon = "grocy.png";
    siteMonitor = "http://host.containers.internal:8084";
  }];

  virtualisation.oci-containers.containers.grocy = mkRootlessContainer {
    image = "docker.io/linuxserver/grocy:latest";

    ports = [ "8084:80" ];

    volumes = [
      "/home/santiago/selfhost/grocy/config:/config"
    ];
  };
}
