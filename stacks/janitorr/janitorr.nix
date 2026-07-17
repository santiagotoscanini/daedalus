# janitorr — retention reporting/cleanup for the media stack (Schaka/
# janitorr): flags media past its per-disk-tier age via Radarr/Sonarr,
# clears stale Seerr requests, maintains Jellyfin "Leaving Soon"
# collections. Jellyfin's Plex-only cousin is Maintainerr.
#
# DRY-RUN, doubly fenced: application.yml sets dry-run=true AND the
# media bind below is :ro — janitorr cannot write or delete anything.
# Review candidates in /home/santiago/selfhost/janitorr/logs/. To go
# live: flip dry-run, make the bind rw, fix the leaving-soon symlink
# namespace (header of assets/application.yml), and re-check ownership
# of the leaving-soon dir for the image's 1002:1001 user.
#
# No web UI — logs are the interface. Tag an *arr item `janitorr_keep`
# (or favorite it in Jellyfin) to protect it forever.
#
# Image user is 1002:1001 (CNB buildpacks) -> host 101001:101000; only
# /logs needs to be writable.

{ config, mkRootlessContainer, ... }:

{
  myStack.containerNetworks.janitorr = "traefik";

  # RADARR/SONARR/JELLYFIN/SEERR_API_KEY for the ${...} placeholders in
  # assets/application.yml. Edit with `sops env.sops`.
  sops.secrets."janitorr-env" = {
    sopsFile = ./env.sops;
    format = "dotenv";
    key = "";
    owner = "santiago";
  };

  systemd.tmpfiles.rules = [
    "d /home/santiago/selfhost/janitorr 0755 santiago users -"
    "d /home/santiago/selfhost/janitorr/logs 0755 101001 101000 -"
    "d /home/santiago/selfhost/janitorr/leaving-soon 0755 101001 101000 -"
  ];

  virtualisation.oci-containers.containers.janitorr = mkRootlessContainer {
    image = "ghcr.io/schaka/janitorr:jvm-stable@sha256:159349b47e6fb4ae211c799369bd8ffa2657b8865e4fc037b5d32a4acec47b3f";

    volumes = [
      "${./assets/application.yml}:/config/application.yml:ro"
      "/home/santiago/selfhost/janitorr/logs:/logs"
      "/s2/tv:/data:ro" # ro = hard write fence for the dry-run phase
      # dry-run still writes leaving-soon preview symlinks (verified: EROFS
      # without this) — give it a dedicated rw dir OUTSIDE the real library,
      # overlaid on the ro /data bind.
      "/home/santiago/selfhost/janitorr/leaving-soon:/data/media/leaving-soon"
    ];

    environmentFiles = [ config.sops.secrets."janitorr-env".path ];

    extraOptions = [
      "--network=traefik-net"
      "--memory=768m" # JVM; CNB memory calculator sizes heap from this
    ];
  };
}
