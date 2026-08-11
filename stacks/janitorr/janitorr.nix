# janitorr — retention reporting/cleanup for the media stack (Schaka/
# janitorr): flags media past its per-disk-tier age via Radarr/Sonarr,
# clears stale Seerr requests, maintains Jellyfin "Leaving Soon"
# collections. Jellyfin's Plex-only cousin is Maintainerr.
#
# DRY-RUN, doubly fenced: application.yml sets dry-run=true AND the
# media bind below is :ro — janitorr cannot write or delete anything.
# Review candidates in /home/santiago/selfhost/tv/janitorr/logs/. To go
# live: flip dry-run, make the bind rw, fix the leaving-soon symlink
# namespace (header of assets/application.yml), and re-check ownership
# of the leaving-soon dir for the image's 1002:1001 user.
#
# No web UI — logs are the interface. Tag an *arr item `janitorr_keep`
# (or favorite it in Jellyfin) to protect it forever.
#
# Books need no exclusion here, and that is structural rather than
# configured: janitorr's only clients are Sonarr, Radarr, Jellyfin and
# Seerr — none of which knows /s2/books exists — and the single media
# bind below is /s2/tv, so the books dataset is not in its mount
# namespace at all. Its free-space tiers watch /data, which IS /s2/tv.
# Adding an exclusion rule would be a comment pretending to be a
# control; keeping the mount narrow is the actual guarantee.
#
# Image user is 1002:1001 (CNB buildpacks) -> host 101001:101000; only
# /logs needs to be writable.

{
  config,
  pkgs,
  mkRootlessContainer,
  mkDotenvSecret,
  ...
}:

{
  fleet.bridgeMemberships.janitorr = [ "traefik" ];

  # janitorr resolves and dials seerr during Spring startup and exits on
  # failure; under --rm the crash leaves the oneshot unit green with no
  # container behind it. Start after seerr is attached to traefik-net so
  # aardvark-dns can resolve the name on the first attempt.
  systemd.services.podman-janitorr = {
    after = [ "podman-seerr.service" ];
    wants = [ "podman-seerr.service" ];
    # `after` only orders behind seerr's *container launch*; seerr's HTTP
    # comes up ~10s later, and janitorr dials seerr:5055 during Spring
    # startup and hard-exits on connection-refused (the oneshot unit then
    # masks the dead container — it stays green with nothing behind it).
    # Gate the start on seerr actually answering: poll from inside the
    # seerr container (this unit runs as santiago, so podman is in
    # context). Bounded to ~2 min so a genuinely-down seerr can't wedge
    # the boot.
    preStart = ''
      for _ in $(seq 1 60); do
        ${pkgs.podman}/bin/podman exec seerr wget -q -O- \
          http://localhost:5055/api/v1/status >/dev/null 2>&1 && exit 0
        sleep 2
      done
      exit 0
    '';
  };

  # RADARR/SONARR/JELLYFIN/SEERR_API_KEY for the ${...} placeholders in
  # assets/application.yml. Edit with `sops env.sops`.
  sops.secrets."janitorr-env" = mkDotenvSecret ./env.sops;

  # Lives in the tv/ group: it janitors the media library and nothing else.
  fleet.statePaths = {
    "${config.fleet.stateRoot}/tv/janitorr" = { };
    "${config.fleet.stateRoot}/tv/janitorr/logs" = {
      uid = 1002;
      gid = 1001;
    };
    "${config.fleet.stateRoot}/tv/janitorr/leaving-soon" = {
      uid = 1002;
      gid = 1001;
    };
  };

  virtualisation.oci-containers.containers.janitorr = mkRootlessContainer {
    image = "ghcr.io/schaka/janitorr:jvm-stable@sha256:270e9113c71182d30929f253ff6ff49c63078f4556487a668602c4114c7d665a";

    volumes = [
      "${./assets/application.yml}:/config/application.yml:ro"
      "${config.fleet.stateRoot}/tv/janitorr/logs:/logs"
      "/s2/tv:/data:ro" # ro = hard write fence for the dry-run phase
      # dry-run still writes leaving-soon preview symlinks (verified: EROFS
      # without this) — give it a dedicated rw dir OUTSIDE the real library,
      # overlaid on the ro /data bind.
      "${config.fleet.stateRoot}/tv/janitorr/leaving-soon:/data/media/leaving-soon"
    ];

    environment = {
      # The AOT-cache launcher validates its classpath with
      # -Xlog:class+path=info, which prints one line per jar — ~90% of
      # this container's entire journal volume, all of it JVM bookkeeping
      # rather than app output. The app's own logging is unaffected.
      JAVA_TOOL_OPTIONS = "-Xlog:class+path=off";
    };

    environmentFiles = [ config.sops.secrets."janitorr-env".path ];

    extraOptions = [
      "--memory=768m" # JVM; CNB memory calculator sizes heap from this
    ];
  };
}
