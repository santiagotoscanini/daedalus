# calibre-web — Calibre-Web-Automated (CWA) fronting the ebook library and
# auto-importing new books from an ingest folder.
#
# LAN-only; traefik dials http://calibre-web:8083 over an isolated bridge.
#
# Runs as container root (PUID=0/PGID=0): CWA is a Flask app and, like
# vanilla Calibre-Web (and unlike the PHP-FPM linuxserver images), tolerates
# UID 0. Container root -> host santiago (1000:100), which owns /config, the
# library, and the ingest folder.
#
# CWA reuses the vanilla Calibre-Web /config (app.db) verbatim — users and
# settings carry over. It BUNDLES Calibre itself (no DOCKER_MODS mod), so
# ebook-convert/calibredb and format conversion work out of the box; the
# External-Binaries path in the UI points at CWA's own calibre install.
#
# Three SEPARATE bind mounts — CWA errors if one bind nests inside another:
#   /calibre-library <- /s2/books/library  the library (metadata.db + books).
#     CWA auto-detects the library at this fixed path (ignores the old
#     `/books` value in app.db); the container log names which metadata.db
#     it picked.
#   /cwa-book-ingest <- /s2/books/ingest    the shelfmark downloader drops
#     files here; CWA imports them into the library, then DELETES the ingest
#     copy. Shared bind with stacks/shelfmark.
#   /config          <- selfhost/calibre-web/config
#
# The library lives on the HDD pool at /s2/books — its own snapshotted
# dataset (platform/zfs.nix). library/ + ingest/ are siblings in that ONE
# dataset (no separate ingest dataset); ingest churn is caught by snapshots
# but is negligible for ebooks. The binds auto-emit RequiresMountsFor
# (platform/podman.nix), closing the cold-boot race where the container
# could start before the dataset mounts.

{ mkRootlessContainer, ... }:

{
  fleet.statePaths = {
    "/home/santiago/selfhost/calibre-web/config" = { };
    # library/ + ingest/ siblings in the /s2/books dataset. Ownership is
    # re-enforced NON-recursively, so declaring library/ can't touch its
    # contents; both map to container root (santiago 1000:100), which CWA
    # and shelfmark both run as.
    "/s2/books/library" = { };
    "/s2/books/ingest" = { };
  };

  fleet.webApps.calibre-web = {
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
    # Household app: santi + sofi, not admins-only.
    authGroups = [ "admins" "family" ];
    # Probe /opds, not /login: healthPath is appended to the auth-bypass
    # rule as Path(), which matches POST as well as GET, so aiming it at
    # a credential-accepting route leaves the local password form
    # reachable outside the gate. /opds is bypassed already and 401s.
    healthPath = "/opds";
    isolated = true;
    authBypassRule = "PathPrefix(`/opds`) || PathPrefix(`/kobo`)";
    authHeaders."Remote-User" = "santi";
    homepage = {
      group = "Books";
      extra.weight = 10;
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
    image = "docker.io/crocodilestick/calibre-web-automated:v4.0.6@sha256:c31a738b6d5ec6982c050063dd3f063b6943eb1051fc81144789f840d9093a8d";

    environment = {
      PUID = "0";
      PGID = "0";
    };

    volumes = [
      "/home/santiago/selfhost/calibre-web/config:/config"
      "/s2/books/library:/calibre-library"
      "/s2/books/ingest:/cwa-book-ingest"
    ];
  };
}
