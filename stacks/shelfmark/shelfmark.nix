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
# Fast Anna's Archive downloads need a membership: add AA_DONATOR_KEY to
# env.sops — omitted, so AA runs on the free (slower, wait-gated) tier. That
# tier is the reason the second source below exists.
#
# ── second source: Prowlarr + qBittorrent ─────────────────────────────────
#
# Book releases from the indexers Prowlarr already has, downloaded by the
# qBittorrent the *arrs already use. Unusually cheap to wire here because all
# three are tenants of the SAME gluetun netns: shelfmark dials both on
# 127.0.0.1, so there is no bridge, no host port, no new firewall surface, and
# the traffic never leaves the namespace.
#
# qBittorrent needs no credentials for the same reason. Its "bypass
# authentication for clients on localhost" is already on — it is what lets
# gluetun's port-forward hook POST setPreferences (CLAUDE.md, tv stack) — and
# an in-netns caller IS localhost. So QBITTORRENT_USERNAME/PASSWORD stay unset
# rather than putting a fourth copy of that password on the box.
#
# Shelfmark COPIES a finished torrent into the ingest folder rather than
# moving it ("to preserve seeding", download/staging.py), so qBittorrent keeps
# seeding from /data/books and CWA imports its own copy. A book is a few MB;
# the duplication is not worth avoiding.
#
# Nothing prunes those seeding torrents today — see the note on the `books`
# category below and the header of stacks/cleanuparr.

{
  config,
  lib,
  pkgs,
  mkDotenvSecret,
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
  # books/ group, beside calibre-web — the two halves of one pipeline.
  fleet.statePaths."${config.fleet.stateRoot}/books/shelfmark" = { };
  # Where qBittorrent puts book torrents and shelfmark reads them back. On the
  # BOOKS dataset, deliberately not under /s2/tv: nothing about a book belongs
  # in the media pool's hardlink space, and keeping them apart is what lets
  # Janitorr keep seeing only /s2/tv.
  fleet.statePaths."/s2/books/torrents" = { };

  # PROWLARR_API_KEY. qBittorrent needs none — see the header. Edit with
  # `sops env.sops`.
  sops.secrets."shelfmark-env" = mkDotenvSecret ./env.sops;

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
    }
  ];
  # Consent screen and Pocket ID's My Apps page.
  fleet.ssoClients.shelfmark = {
    displayName = "Shelfmark";
    description = "Book downloader (Anna’s Archive, via VPN)";
  };

  virtualisation.oci-containers.containers.shelfmark = mkNetnsTenant "gluetun" {
    image = "ghcr.io/calibrain/shelfmark:latest@sha256:056f02e28d446b128d91fa10451c7cc376392f7383bbb841deec49838a419d53";

    environmentFiles = [ config.sops.secrets."shelfmark-env".path ];

    volumes = [
      "${config.fleet.stateRoot}/books/shelfmark:/config"
      # Shared ingest handoff to CWA (declared in stacks/calibre-web).
      "/s2/books/ingest:/cwa-book-ingest"
      # Finished torrents, read-only: shelfmark only ever copies OUT of here.
      # Mounted at the same path qBittorrent writes to (stacks/tv), which is
      # why PROWLARR_REMOTE_PATH_MAPPINGS stays empty — the two agree on the
      # path, so there is nothing to translate.
      "/s2/books/torrents:/data/books:ro"
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

      # ── Prowlarr as a release source ──────────────────────────────────
      #
      # Shelfmark syncs env into its own config file on EVERY start
      # (settings_registry.sync_env_to_config), merging over what is there —
      # so these stay authoritative and a UI edit survives only until the next
      # restart. That is the opposite of the usual "env seeds once" trap and
      # is what keeps this declarative.
      PROWLARR_ENABLED = "true";
      # Same network namespace — see the header.
      PROWLARR_URL = "http://127.0.0.1:9696";

      # Prowlarr's own indexer IDs, comma-separated (the field is a
      # multi-select over them). The four that actually carry book
      # categories: 1337x, The Pirate Bay, Knaben, LimeTorrents.
      #
      # Nyaa.si is excluded despite advertising Books — its catalogue is
      # manga and anime — and EZTV has no book categories at all, so both
      # would only cost a query per search.
      #
      # These are database ids, not names, so removing and re-adding an
      # indexer in Prowlarr changes them. The failure mode is benign
      # (shelfmark searches fewer indexers, nothing breaks) and the current
      # mapping is readable from Prowlarr → Indexers or `/api/v1/indexer`.
      # Empty would mean "every enabled indexer", including the two above.
      PROWLARR_INDEXERS = "7,10,12,13";

      # ── qBittorrent as the client for what Prowlarr finds ─────────────
      PROWLARR_TORRENT_CLIENT = "qbittorrent";
      QBITTORRENT_URL = "http://127.0.0.1:8090";
      # Books land on the books dataset, never in the media pool.
      QBITTORRENT_DOWNLOAD_DIR = "/data/books";
      # A category AND a tag, and both exist for the same reason: they are the
      # only handles anything else has for "this torrent is a book". Cleanuparr
      # cannot see book torrents today — it works from the Sonarr/Radarr queues
      # and there is no Readarr — but its Download Cleaner, the one feature
      # that sweeps a client BY CATEGORY, is switched off rather than
      # unable. If it is ever switched on, these are what excludes them.
      QBITTORRENT_CATEGORY = "books";
      QBITTORRENT_TAG = "shelfmark";
    };
  };
}
