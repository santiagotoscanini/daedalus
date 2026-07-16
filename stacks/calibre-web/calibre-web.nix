# calibre-web — linuxserver image fronting a Calibre ebook library.
# LAN-only; traefik dials http://calibre-web:8083 over traefik-net.
#
# Runs as container root (PUID=0/PGID=0): Calibre-Web is a Flask app and,
# unlike the PHP-FPM linuxserver images (grocy), tolerates UID 0. Container
# root -> host santiago (1000:100), which owns both /config and the library.
#
# The library lives on the HDD pool at /s2/books — its own snapshotted
# dataset (platform/zfs.nix) so it rides the s2-pool schedule and stays off
# the 16K-recordsize selfhost dataset. The /books bind auto-emits
# RequiresMountsFor=/s2/books (platform/common.nix), closing the cold-boot
# race where the container could start before the dataset mounts.
#
# DOCKER_MODS=universal-calibre bakes the calibre binaries in at startup:
# needed to initialise the library, convert formats, and send-to-Kindle.

{ mkRootlessContainer, ... }:

{
  myStack.containerNetworks.calibre-web = "traefik";

  myStack.webApps.calibre-web = {
    hostname = "calibre.toscanini.me";
    serviceName = "calibre-web";
    port = 8083;
  };

  myStack.homepageServices."Productivity" = [
    {
      name = "Calibre-Web";
      href = "https://calibre.toscanini.me";
      description = "Ebook library";
      icon = "calibre-web.png";
      siteMonitor = "http://calibre-web:8083";
    }
  ];

  virtualisation.oci-containers.containers.calibre-web = mkRootlessContainer {
    image = "lscr.io/linuxserver/calibre-web:0.6.26-ls391@sha256:18678f5a40ca01c0681fec60fe9ea4ebb25a9e4ad6fc2e30aa485c09066ab254";

    environment = {
      PUID = "0";
      PGID = "0";
      DOCKER_MODS = "linuxserver/mods:universal-calibre";
    };

    volumes = [
      "/home/santiago/selfhost/calibre-web/config:/config"
      "/s2/books:/books"
    ];

    extraOptions = [
      "--network=traefik-net"
    ];
  };
}
