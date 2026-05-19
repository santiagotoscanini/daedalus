# grocy — linuxserver image (PHP-FPM), CF-tunnel only.
#
# Routed only on the cfweb entrypoint (no LAN `*.s2` host) — same as
# the old compose. `grocy.toscanini.me` is in the Cloudflare Zero Trust
# dashboard's ingress and reaches Traefik via cloudflared.
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
  myStack.traefikRoutes.grocy = {
    host = "grocy.toscanini.me";
    port = 8084;
    entrypoint = "cfweb";
  };

  virtualisation.oci-containers.containers.grocy = mkRootlessContainer {
    image = "docker.io/linuxserver/grocy:latest";

    ports = [ "8084:80" ];

    volumes = [
      "/home/santiago/selfhost/grocy/config:/config"
    ];
  };
}
