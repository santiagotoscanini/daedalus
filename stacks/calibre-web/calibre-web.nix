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
# calibre itself (ebook-convert/calibredb for library init, format
# conversion, send-to-Kindle) is baked into a locally-built image at
# build time — the DOCKER_MODS=universal-calibre runtime install did an
# apt run + tarball extract (~700 log lines) on every container start.
# The Containerfile replays exactly what the mod's init scripts do: its
# image ships /calibre.txz + /CALIBRE_RELEASE, the apt list mirrors its
# add-package script, calibre_postinstall links /usr/bin/{ebook-convert,
# calibredb} (the paths calibre-web's UI settings point at).

{
  pkgs,
  mkImageBuild,
  mkRootlessContainer,
  ...
}:

let
  # Both FROMs digest-pinned; the mod digest carries calibre 9.11.0.
  # Bump either digest to upgrade — the context hash changes, the build
  # oneshot produces a new tag, and the consumer restarts.
  calibreWebImageBuildDir = pkgs.writeTextDir "Containerfile" ''
    FROM ghcr.io/linuxserver/mods:universal-calibre@sha256:9a5f7bef2eb3f80cf32226cc2154abfbcef0ba992423df76f1d9202ff29b4793 AS mod

    FROM lscr.io/linuxserver/calibre-web:0.6.26-ls391@sha256:18678f5a40ca01c0681fec60fe9ea4ebb25a9e4ad6fc2e30aa485c09066ab254
    COPY --from=mod /calibre.txz /CALIBRE_RELEASE /
    RUN export DEBIAN_FRONTEND=noninteractive \
     && apt-get update \
     && apt-get install -y --no-install-recommends \
          xz-utils libgl1 libglx-mesa0 libxdamage1 libegl1 libxkbcommon0 \
          libnss3 libopengl0 libxcomposite1 libxkbfile1 libxrandr2 libxtst6 \
     && mkdir -p /app/calibre \
     && tar xf /calibre.txz -C /app/calibre \
     && /app/calibre/calibre_postinstall \
     && rm /calibre.txz \
     && apt-get clean \
     && rm -rf /var/lib/apt/lists/*
  '';

  calibreWebImage = mkImageBuild {
    name = "calibre-web-calibre";
    tagPrefix = "0.6.26";
    contextDir = calibreWebImageBuildDir;
    gates = [ "podman-calibre-web.service" ];
  };
in
{

  myStack.stateDirs."/home/santiago/selfhost/calibre-web/config" = { };

  myStack.webApps.calibre-web = {
    hostname = "calibre.toscanini.me";
    serviceName = "calibre-web";
    port = 8083;
    # Pocket ID gate + trusted header (AUTH.md tier 2). Calibre-Web's
    # "Allow Reverse Proxy Authentication" (enabled in its UI, header
    # name = Remote-User) matches the header VALUE to an existing user,
    # so map everyone through the gate to the sole account `santi`
    # (single-user library). e-reader clients (OPDS/Kobo) speak HTTP
    # Basic auth and can't follow an OIDC redirect, so bypass those
    # paths — Calibre-Web's own Basic auth guards them, and the strip
    # middleware removes any spoofed Remote-User there. The homepage
    # widget rides the /opds bypass through traefik on the public
    # hostname (isolated = no shared bridge with homepage).
    auth = "oidc";
    healthPath = "/login";
    isolated = true;
    authBypassRule = "PathPrefix(`/opds`) || PathPrefix(`/kobo`)";
    authHeaders."Remote-User" = "santi";
    homepage = {
      group = "Productivity";
      name = "Calibre-Web";
      description = "Ebook library";
      icon = "calibre-web.png";
      widget = {
        type = "calibreweb";
        url = "https://calibre.toscanini.me";
        username = "{{HOMEPAGE_VAR_CALIBREWEB_USER}}";
        password = "{{HOMEPAGE_VAR_CALIBREWEB_PASS}}";
      };
    };
  };

  virtualisation.oci-containers.containers.calibre-web = mkRootlessContainer {
    inherit (calibreWebImage) image;

    environment = {
      PUID = "0";
      PGID = "0";
    };

    volumes = [
      "/home/santiago/selfhost/calibre-web/config:/config"
      "/s2/books:/books"
    ];

    extraOptions = [
    ];
  };

  systemd.services.calibre-web-image-build = calibreWebImage.service;
}
