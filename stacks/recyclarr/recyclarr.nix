# recyclarr — declaratively syncs TRaSH Guides custom formats + quality
# profiles into Radarr and Sonarr. No web UI; it is a background job.
#
# assets/recyclarr.yml is the single source of truth (generated from the
# v8 `config create` templates hd-bluray-web + uhd-bluray-web for Radarr
# and web-1080p + web-2160p for Sonarr, merged one-instance-per-service).
# It is ADDITIVE: it creates the four profiles + their custom formats and
# raises quality-definition max sizes to unlimited; it never reassigns
# existing movies/series to the new profiles (that stays a manual opt-in
# in Radarr/Sonarr/Seerr).
#
# The official image runs in cron mode (CRON_SCHEDULE) via supercronic, so
# it re-applies the guides daily. Cron does NOT sync at container start —
# to apply immediately after a change, run one out-of-band sync:
#
#   sudo -u santiago env HOME=/home/santiago XDG_RUNTIME_DIR=/run/user/1000 \
#     podman exec recyclarr recyclarr sync
#
# Reaches the *arrs over traefik-net via host.containers.internal on the
# ports gluetun publishes (7878/8989) — the same path seerr uses. API keys
# are sops-encrypted in env.sops (RADARR_API_KEY + SONARR_API_KEY).

{
  config,
  mkRootlessContainer,
  mkDotenvSecret,
  ...
}:

{
  myStack.containerNetworks.recyclarr = "traefik";

  sops.secrets."recyclarr-env" = mkDotenvSecret ./env.sops;

  # /config data dir (repo clones, logs, state). Container runs as its
  # image default UID 1000 -> host 100999 under rootless podman (no
  # privilege-drop in the entrypoint), so the dir must be 100999:100999.
  systemd.tmpfiles.rules = [
    "d /home/santiago/selfhost/recyclarr 0755 100999 100999 -"
  ];

  virtualisation.oci-containers.containers.recyclarr = mkRootlessContainer {
    image = "ghcr.io/recyclarr/recyclarr:8@sha256:2d6107f758d882a59fe9d646aa54fa8a5a4fb7a40995125fade575652a3f7871";

    volumes = [
      "/home/santiago/selfhost/recyclarr:/config"
      "${./assets/recyclarr.yml}:/config/recyclarr.yml:ro"
    ];

    environment = {
      CRON_SCHEDULE = "@daily";
    };

    environmentFiles = [ config.sops.secrets."recyclarr-env".path ];

    extraOptions = [ "--network=traefik-net" ];
  };
}
