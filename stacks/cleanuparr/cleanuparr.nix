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
# Cleanuparr's own (optional) auth is left at its default-off, open
# behind the gate — same model as pihole/the traefik dashboard. Its
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
    image = "ghcr.io/cleanuparr/cleanuparr:2.3.3@sha256:d20efe405d4144e87736c25123cd22992fa4a76c9d80d7467ca5313b92107e4a";

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
