# shelfmark — book downloader (formerly calibre-web-automated-book-
# downloader). A web UI that searches Anna's Archive and drops files into
# the ingest folder, where Calibre-Web-Automated (stacks/calibre-web)
# auto-imports them into the library. The two never talk over the network:
# the handoff is purely the shared /s2/books/ingest folder on disk.
#
# Egress rides ProtonVPN: shelfmark is a tenant of the shared gluetun netns
# (stacks/downloads), so Anna's Archive fetches exit through the VPN. It
# reuses the flaresolverr already in that netns for Cloudflare challenges
# (EXT_BYPASSER_URL = 127.0.0.1:8191) rather than running a second headless
# browser. Runs as container root -> host santiago (mkNetnsTenant), which
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
    image = "ghcr.io/calibrain/shelfmark:latest@sha256:1f0e9ecdef24a3d8f5787282eaea3859edcd3bb0c3d508382e2b2bc4bb18d7d6";

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
      # Reuse the tv stack's flaresolverr for AA's Cloudflare challenge
      # (proven: solves annas-archive.gl search) — no second headless browser.
      USE_CF_BYPASS = "true";
      USING_EXTERNAL_BYPASSER = "true";
      EXT_BYPASSER_URL = "http://127.0.0.1:8191";
      EXT_BYPASSER_PATH = "/v1";
    };
  };
}
