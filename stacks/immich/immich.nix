# immich — photo backup + ML. 4 containers on immich-net (server + ML +
# postgres + redis). Custom bridge because the server dials postgres and
# redis by DNS name (DB_HOSTNAME=database, REDIS_HOSTNAME=redis); pasta
# doesn't do inter-container DNS, a user-defined bridge does (via
# netavark/aardvark-dns). The server container also joins traefik-net:
# traefik dials the UI on 2283 by container DNS, and prometheus (same
# bridge) scrapes the api/microservices metrics ports 8081/8082 — no
# host ports published.
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
  mkRootlessContainer,
  mkDotenvSecret,
  ...
}:

let
  # Pin server + ML to the same tag. Bump intentionally — iOS app
  # version mismatches stall background sync silently. The per-image
  # @sha256 digests below must be bumped together with the tag.
  immichVersion = "v3.1.0";

  # Tied to the immich major; check before bumping immichVersion.
  immichPostgresImage = "ghcr.io/immich-app/postgres:14-vectorchord0.4.3-pgvectors0.2.0@sha256:bcf63357191b76a916ae5eb93464d65c07511da41e3bf7a8416db519b40b1c23";
in
{
  # POSTGRES_PASSWORD + DB_PASSWORD (shared by db and server): sops-encrypted env.sops, decrypted to
  # /run/secrets/immich-env at activation. Edit with `sops env.sops`.
  sops.secrets."immich-env" = mkDotenvSecret ./env.sops;

  fleet.bridgeMemberships = {
    immich-postgres = [ "immich:alias=database" ];
    immich-redis = [ "immich:alias=redis" ];
    immich-machine-learning = [ "immich" ];
    immich = [
      "immich"
      "traefik"
    ];
  };

  fleet.logStacks.immich = [
    "immich"
    "immich-postgres"
    "immich-redis"
    "immich-machine-learning"
  ];

  fleet.statePaths = {
    "${config.fleet.stateRoot}/immich/model-cache".uid = 1000;
    "${config.fleet.stateRoot}/immich/postgres" = {
      uid = 999;
      mode = "0700";
    };
  };

  # One webApp: the UI (exposed remotely). The two telemetry ports (8081
  # api, 8082 microservices) are NOT published as web routes — prometheus
  # scrapes them directly by container DNS on traefik-net (see
  # prometheusScrapes below), so routing them through traefik + pi-hole +
  # gatus would be redundant surface for endpoints nobody browses by hand.
  fleet.webApps.immich = {
    serviceName = "immich";
    port = 2283;
    exposeRemotely = true;
  };

  # Bridge scrape — prometheus is on traefik-net too (see monitoring.nix).
  fleet.prometheusScrapes = [
    {
      job_name = "immich-api";
      static_configs = [ { targets = [ "immich:8081" ]; } ];
    }
    {
      job_name = "immich-microservices";
      static_configs = [ { targets = [ "immich:8082" ]; } ];
    }
  ];

  fleet.grafanaDashboardsByFolder."Services".immich = builtins.readFile ./assets/dashboard.json;

  virtualisation.oci-containers.containers.immich-postgres = mkRootlessContainer {
    image = immichPostgresImage;

    volumes = [
      "${config.fleet.stateRoot}/immich/postgres:/var/lib/postgresql/data"
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
    image = "docker.io/valkey/valkey:9@sha256:3acc0687f2a2e1091fae6450d7842dd658c941338cf0a873ddd9e14b9e4ea4dd";

  };

  virtualisation.oci-containers.containers.immich-machine-learning = mkRootlessContainer {
    image = "ghcr.io/immich-app/immich-machine-learning:${immichVersion}-openvino@sha256:4b6ef958e7749fc548377bb23ee219c09c74da8decee080d76dc6a388c39b013";

    volumes = [
      "${config.fleet.stateRoot}/immich/model-cache:/cache"
    ];

    extraOptions = [
      "--device=/dev/dri:/dev/dri"
    ];
  };

  virtualisation.oci-containers.containers.immich = mkRootlessContainer {
    image = "ghcr.io/immich-app/immich-server:${immichVersion}@sha256:b434cb9287eea1471c9974845914d4dd328c9c2d652e446ed4930f99944f0ceb";
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
      # Traefik dials immich over traefik-net, so the trusted peer is
      # that bridge's subnet (pinned in stacks/traefik).
      IMMICH_TRUSTED_PROXIES = config.fleet.bridgeSubnets.traefik;
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
