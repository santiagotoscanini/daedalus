# immich — photo backup + ML, 4 containers on immich-net.
#
# Faithful translation of Immich's official docker-compose
# (https://github.com/immich-app/immich/releases/latest/download/docker-compose.yml)
# to nix oci-containers. Same four services (server, machine-learning,
# postgres, redis), same images, same wiring; expressed in the same
# rootless-podman pattern the rest of the fleet uses.
#
# Why a custom podman network: the server dials postgres and redis by
# DNS name (defaults DB_HOSTNAME=database, REDIS_HOSTNAME=redis).
# Pasta doesn't do inter-container DNS; all four on the same user-
# defined bridge do, via netavark/aardvark-dns.
# host.containers.internal still resolves on bridge networks so
# Traefik's egress patterns keep working.
#
# Deviations from the upstream compose, with reasons:
#   - ML image uses the -openvino tag — we have an Alder Lake iGPU and
#     OpenVINO is ~5-10x faster than CPU for CLIP + face detection + OCR.
#   - Server and ML containers both get /dev/dri (QSV transcoding for
#     the server, OpenVINO for ML). The compose puts these in
#     hwaccel.*.yml overlay files that you opt into.
#   - --userns=keep-id:uid=1000,gid=1000 maps container UID 1000 (the
#     Immich `node` user) to host santiago. Required because we run
#     rootless; the compose runs rootful.
#   - --network=immich-net:alias=database / :alias=redis so the
#     standard hostnames the server expects keep resolving despite our
#     descriptive container names.
#   - IMMICH_TRUSTED_PROXIES=192.168.0.2/24 because Traefik is in front.
#     The compose assumes direct port-2283 exposure.
#
# Postgres image is non-negotiable:
# ghcr.io/immich-app/postgres:14-vectorchord... — Immich uses the
# `vectorchord` extension for vector similarity (face recognition,
# smart search). Vanilla docker.io/library/postgres won't work — the
# extension is custom-built into this image.
#
# Storage layout:
#   /s2/immich/                          # UPLOAD_LOCATION
#     upload/                                  # fresh uploads
#     library/<storageLabel>/                  # managed, template-organized
#     thumbs/, encoded-video/                  # regenerable
#     profile/, backups/                       # avatars + auto pg_dumps
#   /home/santiago/selfhost/immich/postgres/   # DB on NVMe
#   /home/santiago/selfhost/immich/model-cache # CLIP / face / OCR models

{ config, lib, pkgs, mkRootlessContainer, ... }:

let
  # Pin both server + ML to the same tag. Bump intentionally — iOS app
  # version mismatches stall background sync silently.
  immichVersion = "v2.7.5";

  # Immich-built postgres image with vectorchord baked in. Tag is tied
  # to the immich major; check before bumping immichVersion.
  immichPostgresImage =
    "ghcr.io/immich-app/postgres:14-vectorchord0.4.3-pgvectors0.2.0";
in
{
  myStack.containerNetworks = {
    immich-postgres         = "immich";
    immich-redis            = "immich";
    immich-machine-learning = "immich";
    immich                  = "immich";
  };

  # LAN HTTPS — pi-hole resolves this to 192.168.0.2.
  myStack.traefikRoutes.immich = {
    host = "immich.s2.toscanini.me";
    port = 2283;
  };

  # Public — reached via the Cloudflare tunnel (CF terminates TLS at
  # the edge, traffic to traefik is plain HTTP on cfweb).
  myStack.traefikRoutes.immich-public = {
    host = "immich.toscanini.me";
    port = 2283;
    entrypoint = "cfweb";
  };


  myStack.dnsHosts = [ "192.168.0.2 immich.s2.toscanini.me" ];

  myStack.prometheusScrapes = [
    { job_name = "immich-api";
      static_configs = [{ targets = [ "host.containers.internal:18081" ]; }]; }
    { job_name = "immich-microservices";
      static_configs = [{ targets = [ "host.containers.internal:18082" ]; }]; }
  ];

  myStack.grafanaDashboards.immich = builtins.readFile ./immich-dashboard.json;

  myStack.homepageServices."Cloud & AI" = [{
    name = "Immich";
    href = "https://immich.s2.toscanini.me";
    description = "Photo + video backup (ML on iGPU via OpenVINO)";
    icon = "immich.png";
    siteMonitor = "http://host.containers.internal:2283";
    widget = {
      type = "immich";
      url = "http://host.containers.internal:2283";
      key = "{{HOMEPAGE_VAR_IMMICH_API_KEY}}";
      version = 2;
      fields = [ "users" "photos" "videos" "storage" ];
    };
  }];

  virtualisation.oci-containers.containers.immich-postgres = mkRootlessContainer {
    image = immichPostgresImage;

    volumes = [
      "/home/santiago/selfhost/immich/postgres:/var/lib/postgresql/data"
    ];

    environment = {
      POSTGRES_DB = "immich";
      POSTGRES_USER = "immich";
      # Applied only on first initdb. Cheap insurance against silent
      # page-level bit-rot; can't be added later without offline
      # pg_checksums.
      POSTGRES_INITDB_ARGS = "--data-checksums";
    };

    # POSTGRES_PASSWORD (also DB_PASSWORD for immich-server — same
    # value, two keys, both consumed natively).
    environmentFiles = [ "/etc/nixos/containers/immich/env" ];

    extraOptions = [
      "--network=immich-net:alias=database"
      "--shm-size=128m"
    ];
  };

  virtualisation.oci-containers.containers.immich-redis = mkRootlessContainer {
    image = "docker.io/valkey/valkey:9";

    extraOptions = [
      "--network=immich-net:alias=redis"
    ];
  };

  # OpenVINO image variant — uses the Alder Lake iGPU via /dev/dri.
  # CPU fallback works but is ~5-10x slower on CLIP + face detection.
  virtualisation.oci-containers.containers.immich-machine-learning = mkRootlessContainer {
    image = "ghcr.io/immich-app/immich-machine-learning:${immichVersion}-openvino";

    volumes = [
      "/home/santiago/selfhost/immich/model-cache:/cache"
    ];

    extraOptions = [
      "--network=immich-net"
      "--device=/dev/dri:/dev/dri"
    ];
  };

  virtualisation.oci-containers.containers.immich = mkRootlessContainer {
    image = "ghcr.io/immich-app/immich-server:${immichVersion}";
    dependsOn = [ "immich-postgres" "immich-redis" "immich-machine-learning" ];

    ports = [ "2283:2283" "18081:8081" "18082:8082" ];

    volumes = [
      "/s2/immich:/data"
      "/etc/localtime:/etc/localtime:ro"
    ];

    environment = {
      # Match the bridge aliases above. Setting explicitly so future
      # ops grep finds them.
      DB_HOSTNAME = "database";
      DB_USERNAME = "immich";
      DB_DATABASE_NAME = "immich";
      REDIS_HOSTNAME = "redis";

      # Trust Traefik so X-Forwarded-For is honored (correct client
      # IPs in audit logs and rate limiting).
      IMMICH_TRUSTED_PROXIES = "192.168.0.2/24";
      # Enables OpenTelemetry-style /metrics on :8081 (api) + :8082 (microservices).
      IMMICH_TELEMETRY_INCLUDE = "all";
    };

    # DB_PASSWORD — same env file as postgres so they stay in sync.
    environmentFiles = [ "/etc/nixos/containers/immich/env" ];

    extraOptions = [
      "--network=immich-net"
      # iGPU for QSV transcoding — see Settings → Video Transcoding.
      "--device=/dev/dri:/dev/dri"
      # Container UID 1000 (node) → host UID 1000 (santiago), so
      # /s2/immich is owned by santiago on the host.
      "--userns=keep-id:uid=1000,gid=1000"
    ];
  };
}
