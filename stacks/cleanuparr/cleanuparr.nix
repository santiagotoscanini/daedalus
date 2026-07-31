# cleanuparr — download-queue hygiene for the *arr stack
# (Cleanuparr/cleanuparr). Fills the layer Janitorr does NOT: Janitorr
# prunes the *library* on disk pressure, Cleanuparr watches the live
# download *queue* — removing stalled/failed/metadata-stuck grabs,
# blocking known malware/junk torrents, and triggering searches for
# missing + cutoff-unmet items. It is the maintained successor to
# Decluttarr and Huntarr (both retired/abandoned), so it replaces two
# dead projects with one.
#
# Networking — NOT in gluetun's netns. Cleanuparr only needs to reach
# the *arrs and qBittorrent as an API client, and the bridge can dial
# gluetun's host-published ports via host.containers.internal (same as
# seerr/scraparr already do). It joins its own isolated bridge
# (iso-cleanuparr-net, traefik the only other member) — it has no
# bridge peers of its own, and nothing else should be able to reach an
# admin UI directly.
#   Sonarr       http://host.containers.internal:8989
#   Radarr       http://host.containers.internal:7878
#   qBittorrent  http://host.containers.internal:8090
# Poll-based — no inbound webhooks, so gating the whole host behind the
# OIDC gate costs nothing. (If *arr→Cleanuparr push notifications are
# ever wanted, add an authBypassRule for the notification path.)
#
# Config lives entirely in the web UI (connection details for the arrs
# + download client, and every cleanup rule), persisted to /config as
# SQLite — there is no dotenv, hence no sops secret here. qBittorrent's
# WebUI credentials go in Cleanuparr's UI: its localhost-auth-bypass
# only covers the in-netns port-forward script, not calls arriving via
# host.containers.internal.
#
# Auth: the Pocket ID forward-auth gate at traefik is the boundary;
# Cleanuparr ships its own account system (a first-run setup wizard,
# not completed here), and its local-address bypass is off by default,
# so the gate is the only thing standing in front of the UI. Its
# /health route is [AllowAnonymous] (200 when healthy), so it doubles
# as the gatus healthPath and rides the OIDC bypass.
#
# User: image honours PUID/PGID (default 1000) → host 100999 under the
# rootless subuid map; /config is pre-created with that ownership.

{
  config,
  mkRootlessContainer,
  ...
}:

{
  # Isolated bridge (traefik-only) comes from webApps.isolated below —
  # do NOT also list "traefik" here.
  fleet.bridgeMemberships.cleanuparr = [ ];

  # PUID 1000 → host 100999; /config must exist with that ownership or
  # a fresh install fails on first write (holds the SQLite state).
  fleet.statePaths."/home/santiago/selfhost/cleanuparr/config".uid = 1000;

  # Native OIDC, SEPARATE from the forward-auth client `webApps.auth =
  # "oidc"` derives above. Both point at this hostname but they are
  # different consumers with different callbacks: traefik's middleware
  # owns /oidc/callback, while the app itself round-trips through
  # /api/auth/oidc/callback (login) and /api/account/oidc/link/callback
  # (linking an existing account). One client cannot hold both without
  # the derived one overwriting the hand-written callbacks on rebuild.
  #
  # No `consumers`: 2.10 keeps OIDC settings in its own SQLite, with no
  # env override, so the pair is pasted into Settings → Account once.
  # The client is still declarative — a rebuilt IdP re-converges it.
  # PKCE stays on: the app sends code_challenge S256.
  fleet.ssoClients.cleanuparr-app = {
    displayName = "Cleanuparr";
    description = "Download-queue cleanup & malware blocking";
    launchURL = "https://cleanuparr.toscanini.me";
    callbackURLs = [
      "https://cleanuparr.toscanini.me/api/auth/oidc/callback"
      "https://cleanuparr.toscanini.me/api/account/oidc/link/callback"
    ];
    logoutCallbackURLs = [ "https://cleanuparr.toscanini.me" ];
  };

  fleet.webApps.cleanuparr = {
    serviceName = "cleanuparr";
    port = 11011;
    auth = "oidc";
    healthPath = "/health"; # AllowAnonymous liveness probe → gatus + OIDC bypass
    isolated = true;
    homepage = {
      group = "Media";
      description = "Download-queue cleanup & malware blocking";
      icon = "cleanuparr.png";
    };
  };

  virtualisation.oci-containers.containers.cleanuparr = mkRootlessContainer {
    image = "ghcr.io/cleanuparr/cleanuparr:2.10.1@sha256:6564af85578254728a9b06ded12836d2773e56f0da703c317cb589b176c4e215";

    environment = {
      PORT = "11011";
      PUID = "1000";
      PGID = "1000";
    };

    volumes = [
      "/home/santiago/selfhost/cleanuparr/config:/config"
    ];
  };
}
