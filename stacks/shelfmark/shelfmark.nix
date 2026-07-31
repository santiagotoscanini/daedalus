# shelfmark — book downloader (formerly calibre-web-automated-book-
# downloader). A web UI that searches Anna's Archive and drops files into
# the ingest folder, where Calibre-Web-Automated (stacks/calibre-web)
# auto-imports them into the library. The two never talk over the network:
# the handoff is purely the shared /s2/books/ingest folder on disk.
#
# Egress rides ProtonVPN: shelfmark is a tenant of the shared gluetun netns
# (stacks/downloads), so Anna's Archive fetches exit through the VPN. It
# runs no external bypasser (USING_EXTERNAL_BYPASSER = false), so VPN
# egress is the only reason it shares the netns rather than sitting on
# traefik-net. Runs as container root -> host santiago (mkNetnsTenant), which
# owns /config and the ingest folder.
#
# Fast Anna's Archive downloads need a membership: add AA_DONATOR_KEY via a
# stacks/shelfmark/env.sops secret (environmentFiles) — omitted here, so it
# runs on the free (slower, wait-gated) tier.

{
  config,
  lib,
  pkgs,
  mkRootlessContainer,
  ...
}:

let
  inherit
    (import ../../platform/gluetun-lib.nix {
      inherit
        config
        lib
        pkgs
        mkRootlessContainer
        ;
    })
    mkNetnsTenant
    ;
in
{
  fleet.statePaths."/home/santiago/selfhost/shelfmark/config" = { };

  # netns tenant → no bridge (still earns the Type=oneshot override).
  fleet.bridgeMemberships.shelfmark = [ ];

  # Published on the shared gluetun + gated behind Pocket ID (shelfmark's
  # own auth is off — the gate is the sole browser auth). /api/health is
  # shelfmark's own healthcheck endpoint (200, unauthenticated) — gatus
  # probes it and it's the ONLY path added to the OIDC bypass.
  fleet.gluetunTenants.gluetun = [
    {
      name = "shelfmark";
      port = 8084;
      healthPath = "/api/health";
      # Household app: santi + sofi, not admins-only.
      authGroups = [
        "admins"
        "family"
      ];
      homepage = {
        group = "Productivity";
        name = "Shelfmark";
        description = "Book downloader (Anna's Archive, via VPN)";
        icon = "mdi-book-arrow-down";
        href = "https://shelfmark.toscanini.me";
      };
    }
  ];

  virtualisation.oci-containers.containers.shelfmark = mkNetnsTenant "gluetun" {
    image = "ghcr.io/calibrain/shelfmark:latest@sha256:056f02e28d446b128d91fa10451c7cc376392f7383bbb841deec49838a419d53";

    volumes = [
      "/home/santiago/selfhost/shelfmark/config:/config"
      # Shared ingest handoff to CWA (declared in stacks/calibre-web).
      "/s2/books/ingest:/cwa-book-ingest"
    ];

    environment = {
      FLASK_PORT = "8084";
      INGEST_DIR = "/cwa-book-ingest";
      # The "Direct Download" source IS the Anna's Archive / LibGen /
      # Z-Library aggregator — Shelfmark searches nothing until it's
      # enabled AND given a mirror URL (it ships no default AA domain, by
      # design). AA rotates domains under legal pressure: .org died Jan
      # 2026, .li March 2026; .gl/.pk/.gd are the live set. Update these
      # if search starts failing (check Anna's Archive's Wikipedia page).
      DIRECT_DOWNLOAD_ENABLED = "true";
      AA_MIRROR_URLS = "https://annas-archive.gl,https://annas-archive.pk,https://annas-archive.gd";
      # Shelfmark's BUILT-IN bypasser (not the shared flaresolverr): AA's
      # search pages are Cloudflare (flaresolverr solves those), but the
      # slow_download pages sit behind DDoS-Guard, which flaresolverr can't
      # solve (times out at 60s). The bundled bypasser handles AA's full
      # download flow incl. DDoS-Guard + the no-donator countdown.
      USE_CF_BYPASS = "true";
      USING_EXTERNAL_BYPASSER = "false";
    };
  };
}
