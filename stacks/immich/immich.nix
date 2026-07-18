# immich — photo backup + ML. 4 containers on immich-net (server + ML +
# postgres + redis). Custom bridge because the server dials postgres and
# redis by DNS name (DB_HOSTNAME=database, REDIS_HOSTNAME=redis); pasta
# doesn't do inter-container DNS, a user-defined bridge does (via
# netavark/aardvark-dns). The server container also joins traefik-net so
# traefik dials its three HTTP ports (2283 UI, 8081 api metrics, 8082
# microservices metrics) by container DNS — no host ports published.
#
# Faithful translation of the upstream docker-compose to rootless
# oci-containers. Notable deviations:
#   - ML uses the -openvino tag for Alder Lake iGPU acceleration
#     (~5-10x faster than CPU on CLIP + face detection + OCR).
#   - Server + ML both get /dev/dri (QSV transcoding + OpenVINO).
#   - --userns=keep-id:uid=1000 maps container `node` (UID 1000) to
#     host santiago (compose runs rootful, so this is rootless-only).
#   - --network=immich-net:alias=database / :alias=redis preserves the
#     standard hostnames the server expects.
#   - IMMICH_TRUSTED_PROXIES set because traefik is in front.
#
# Postgres image is non-negotiable: ghcr.io/immich-app/postgres:14-vectorchord*
# — Immich uses the `vectorchord` extension for vector similarity
# (face recognition, smart search), built into this custom image.
#
# Storage layout:
#   /s2/immich/                  UPLOAD_LOCATION
#     upload/                    fresh uploads
#     library/<storageLabel>/    managed, template-organized
#     thumbs/, encoded-video/    regenerable
#     profile/, backups/         avatars + auto pg_dumps
#   /home/santiago/selfhost/immich/{postgres,model-cache}/   on NVMe

{
  config,
  lib,
  pkgs,
  mkRootlessContainer,
  mkDotenvSecret,
  ...
}:

let
  # Pin server + ML to the same tag. Bump intentionally — iOS app
  # version mismatches stall background sync silently. The per-image
  # @sha256 digests below must be bumped together with the tag.
  immichVersion = "v3.0.3";

  # Tied to the immich major; check before bumping immichVersion.
  immichPostgresImage = "ghcr.io/immich-app/postgres:14-vectorchord0.4.3-pgvectors0.2.0@sha256:bcf63357191b76a916ae5eb93464d65c07511da41e3bf7a8416db519b40b1c23";
in
{
  # POSTGRES_PASSWORD + DB_PASSWORD (shared by db and server): sops-encrypted env.sops, decrypted to
  # /run/secrets/immich-env at activation. Edit with `sops env.sops`.
  sops.secrets."immich-env" = mkDotenvSecret ./env.sops;

  myStack.containerNetworks = {
    immich-postgres = [ "immich:alias=database" ];
    immich-redis = [ "immich:alias=redis" ];
    immich-machine-learning = [ "immich" ];
    immich = [ "immich" "traefik" ];
  };

  # One webApp: the UI (exposed remotely). The two telemetry ports (8081
  # api, 8082 microservices) are NOT published as web routes — prometheus
  # scrapes them directly by container DNS on traefik-net (see
  # prometheusScrapes below), so routing them through traefik + pi-hole +
  # gatus would be redundant surface for endpoints nobody browses by hand.
  myStack.webApps.immich = {
    serviceName = "immich";
    port = 2283;
    exposeRemotely = true;
    homepage = {
      group = "Cloud & AI";
      description = "Photo + video backup (ML on iGPU via OpenVINO)";
      icon = "immich.png";
      widget = {
        type = "immich";
        url = "http://immich:2283";
        key = "{{HOMEPAGE_VAR_IMMICH_API_KEY}}";
        version = 2;
        fields = [
          "users"
          "photos"
          "videos"
          "storage"
        ];
      };
    };
  };

  # Bridge scrape — prometheus is on traefik-net too (see monitoring.nix).
  myStack.prometheusScrapes = [
    {
      job_name = "immich-api";
      static_configs = [ { targets = [ "immich:8081" ]; } ];
    }
    {
      job_name = "immich-microservices";
      static_configs = [ { targets = [ "immich:8082" ]; } ];
    }
  ];

  myStack.grafanaDashboardsByFolder."Services".immich = builtins.readFile ./assets/dashboard.json;

  virtualisation.oci-containers.containers.immich-postgres = mkRootlessContainer {
    image = immichPostgresImage;

    volumes = [
      "/home/santiago/selfhost/immich/postgres:/var/lib/postgresql/data"
    ];

    environment = {
      POSTGRES_DB = "immich";
      POSTGRES_USER = "immich";
      # Applied only on first initdb — can't be added later without
      # offline pg_checksums. Cheap insurance against bit-rot.
      POSTGRES_INITDB_ARGS = "--data-checksums";
    };

    # POSTGRES_PASSWORD + DB_PASSWORD (same value, both keys consumed natively).
    environmentFiles = [ config.sops.secrets."immich-env".path ];

    extraOptions = [
      "--shm-size=128m"
    ];
  };

  virtualisation.oci-containers.containers.immich-redis = mkRootlessContainer {
    image = "docker.io/valkey/valkey:9@sha256:8e8d64b405ce18f41b8e5ee20aa4687a8ed0022d1298f2ce31cdcf3a76e09411";

    extraOptions = [
    ];
  };

  virtualisation.oci-containers.containers.immich-machine-learning = mkRootlessContainer {
    image = "ghcr.io/immich-app/immich-machine-learning:${immichVersion}-openvino@sha256:42295f06067186ee62f8bc20379c72a263e600b8ad22dc9fb22385712d00944e";

    volumes = [
      "/home/santiago/selfhost/immich/model-cache:/cache"
    ];

    extraOptions = [
      "--device=/dev/dri:/dev/dri"
    ];
  };

  virtualisation.oci-containers.containers.immich = mkRootlessContainer {
    image = "ghcr.io/immich-app/immich-server:${immichVersion}@sha256:c716dc20f957aafd89fa9d284a2ec63e25c9e2d8d8e87c6197d540a3dce237db";
    dependsOn = [
      "immich-postgres"
      "immich-redis"
      "immich-machine-learning"
    ];

    volumes = [
      "/s2/immich:/data"
      "/etc/localtime:/etc/localtime:ro"
    ];

    environment = {
      # Match the bridge aliases above.
      DB_HOSTNAME = "database";
      DB_USERNAME = "immich";
      DB_DATABASE_NAME = "immich";
      REDIS_HOSTNAME = "redis";

      # Honor X-Forwarded-For from traefik (correct IPs in audit logs).
      IMMICH_TRUSTED_PROXIES = "${config.myStack.lanIp}/24";
      # /metrics on :8081 (api) + :8082 (microservices).
      IMMICH_TELEMETRY_INCLUDE = "all";
    };

    # DB_PASSWORD — same env file as postgres so they stay in sync.
    environmentFiles = [ config.sops.secrets."immich-env".path ];

    extraOptions = [
      "--device=/dev/dri:/dev/dri" # iGPU for QSV transcoding
      "--userns=keep-id:uid=1000,gid=1000" # node (UID 1000) → santiago
    ];
  };
}
