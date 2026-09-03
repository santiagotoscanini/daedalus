# metube — yt-dlp web UI, sibling of the tv stack.
#
# Standalone (no VPN), traefik-net for HTTP routing — traefik reaches
# via `http://metube:8081`, no host port published. Writes downloads
# to /s2/tv/media/videos which is already part of the jellyfin
# library — anything pulled here surfaces in Jellyfin's Videos folder.
#
# UID/GID env vars on this image are `UID`/`GID` (not the linuxserver
# `PUID`/`PGID`). Same rationale as the tv stack: container UID 0 maps
# to host santiago in our rootless setup, so UID=0 GID=0 = run as the
# user that owns the videos dir.

{ mkRootlessContainer, ... }:

{
  fleet.bridgeMemberships.metube = [ "traefik" ];
  fleet.webApps.metube = {
    serviceName = "metube";
    port = 8081;
    # No auth of its own (upstream: none planned), so the Pocket ID gate
    # is the only thing in front of it.
    auth = "oidc";
    # Household app: santi + sofi, not admins-only.
    authGroups = [
      "admins"
      "family"
    ];
    healthPath = "/favicon.ico";
    # daedalus cannot dial metube container-direct — `auth.isolated`
    # deliberately keeps it off traefik-net — so it reads the queue through
    # this hostname instead. GET only, and only that one path; every
    # mutating route (/add, /delete, the socket.io channel) still needs a
    # passkey.
    authBypassRule = "Method(`GET`) && Path(`/history`)";
  };
  # Consent screen and Pocket ID's My Apps page.
  fleet.ssoClients.metube = {
    displayName = "MeTube";
    description = "yt-dlp web UI";
  };

  virtualisation.oci-containers.containers.metube = mkRootlessContainer {
    image = "ghcr.io/alexta69/metube:2026.08.28@sha256:397778fccf13d83adf9325fe813b260617a082d1772aff6d678c5b9256dd01fb";

    volumes = [
      "/s2/tv/media/videos:/downloads"
    ];

    environment = {
      UID = "0";
      GID = "0";
      # Default INFO logs "Sending download history" to stderr on every
      # poll — journald err-priority noise.
      LOGLEVEL = "WARNING";
    };

  };
}
