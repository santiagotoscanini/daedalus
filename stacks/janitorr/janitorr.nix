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

{
  config,
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
  };

  # No web UI upstream — this tile is the face: Drilldown deep-link to
  # its Loki stream + a counter of dry-run deletion candidates (the
  # "Deleting ..." report lines) over the last 7 days.
  fleet.homepageServices."Media" = [
    {
      name = "Janitorr";
      href = "https://grafana.toscanini.me/a/grafana-lokiexplore-app/explore?from=now-7d&to=now&var-ds=loki-default&var-filters=container%7C%3D%7Cjanitorr";
      description = "Media retention (dry-run) — log review";
      icon = "/icons/janitorr.png";
      widget = {
        type = "customapi";
        url = "http://loki:3100/loki/api/v1/query?query=sum%28count_over_time%28%7Bcontainer%3D%22janitorr%22%7D%20%7C%3D%20%60Deleting%60%20%5B7d%5D%29%29%20or%20vector%280%29";
        refreshInterval = 300000;
        mappings = [
          {
            field = "data.result.0.value.1";
            format = "number";
            label = "Would delete (7d)";
          }
        ];
      };
    }
  ];

  # RADARR/SONARR/JELLYFIN/SEERR_API_KEY for the ${...} placeholders in
  # assets/application.yml. Edit with `sops env.sops`.
  sops.secrets."janitorr-env" = mkDotenvSecret ./env.sops;

  fleet.statePaths = {
    "/home/santiago/selfhost/janitorr" = { };
    "/home/santiago/selfhost/janitorr/logs" = {
      uid = 1002;
      gid = 1001;
    };
    "/home/santiago/selfhost/janitorr/leaving-soon" = {
      uid = 1002;
      gid = 1001;
    };
  };

  virtualisation.oci-containers.containers.janitorr = mkRootlessContainer {
    image = "ghcr.io/schaka/janitorr:jvm-stable@sha256:270e9113c71182d30929f253ff6ff49c63078f4556487a668602c4114c7d665a";

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
      "--memory=768m" # JVM; CNB memory calculator sizes heap from this
    ];
  };
}
