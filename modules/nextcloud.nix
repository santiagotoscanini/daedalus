# nextcloud — 3 containers on a shared bridge + custom-built image +
# host-side cron timer + the dual-router Traefik rule.
#
# Why a custom podman network: nextcloud-app dials postgres and redis
# by name (POSTGRES_HOST=postgres, REDIS_HOST=redis in the persisted
# config.php). Pasta doesn't do inter-container DNS; all three on the
# same user-defined bridge do (via netavark/aardvark-dns).
# host.containers.internal still resolves on bridge networks, so
# Traefik's egress patterns continue to work.
#
# Only nextcloud-app publishes to the host (`8082:80`); postgres + redis
# are reachable only from inside the bridge. Traefik dials the app via
# host.containers.internal:8082.
#
# Post-Nextcloud-version-upgrade manual steps (NOT auto-run — they're
# slow on large instances and would block startup):
#   sudo -u santiago env HOME=/home/santiago XDG_RUNTIME_DIR=/run/user/1000 \
#     podman exec -u www-data nextcloud-app php occ db:add-missing-indices
#   sudo -u santiago env HOME=/home/santiago XDG_RUNTIME_DIR=/run/user/1000 \
#     podman exec -u www-data nextcloud-app php occ maintenance:repair \
#       --include-expensive

{ config, lib, pkgs, mkRootlessContainer, ... }:

let
  # Bump to track upstream Nextcloud — both the FROM line in the
  # Containerfile and the local image tag follow it. After bumping,
  # `nixos-rebuild switch` triggers a rebuild of the image and a
  # restart of the app container. Then run the post-upgrade `occ`
  # commands above by hand.
  nextcloudVersion = "33";

  # The official nextcloud:N image doesn't ship ffmpeg, but Nextcloud's
  # preview generator and the `recognize` ML app both want it. Build
  # `localhost/nextcloud-ffmpeg:<ver>` once via the
  # nextcloud-image-build oneshot below. podman caches the FROM image
  # and the RUN layer, so subsequent rebuilds are ~instant.
  nextcloudImageBuildDir = pkgs.writeTextDir "Containerfile" ''
    FROM docker.io/library/nextcloud:${nextcloudVersion}
    RUN apt-get update \
     && apt-get upgrade -y \
     && apt-get install -y --no-install-recommends ffmpeg \
     && apt-get clean \
     && rm -rf /var/lib/apt/lists/*
  '';
in
{
  myStack.containerNetworks = {
    nextcloud-postgres = "nextcloud";
    nextcloud-redis    = "nextcloud";
    nextcloud-app      = "nextcloud";
  };

  # Complex route — dual-entrypoint (cfweb + websecure) so the same URL
  # works behind the Cloudflare tunnel (plain HTTP) and on the LAN
  # (HTTPS). A single router with both entrypoints would force `tls:`
  # to apply to cfweb too (404 from CF). HSTS middleware is on both.
  myStack.traefikStaticRules."nextcloud.yml" =
    builtins.readFile ../containers/nextcloud/nextcloud.yml;

  # The `:16` pin is load-bearing: the on-disk cluster in
  # /home/santiago/selfhost/nextcloud/nc_postgres was initdb'd for
  # PostgreSQL 16. Bumping the tag requires a pg_upgrade dance (dump
  # on the old image, restore on the new one), NOT just a tag bump.
  virtualisation.oci-containers.containers.nextcloud-postgres = mkRootlessContainer {
    image = "docker.io/library/postgres:16-alpine";

    volumes = [
      "/home/santiago/selfhost/nextcloud/nc_postgres:/var/lib/postgresql/data"
    ];

    environment = {
      POSTGRES_DB = "nc_postgres";
      POSTGRES_USER = "nc_postgres";
    };

    # PG_PASS — also used by nextcloud-app to log in as oc_santi.
    environmentFiles = [ "/etc/nixos/containers/nextcloud/env" ];

    extraOptions = [
      # `:alias=postgres` so nextcloud-app's persisted config.php
      # (written when the compose service was named just `postgres`)
      # still resolves the right container. Container name is
      # `nextcloud-postgres`; alias makes it reachable as both.
      "--network=nextcloud-net:alias=postgres"
    ];
  };

  virtualisation.oci-containers.containers.nextcloud-redis = mkRootlessContainer {
    image = "docker.io/library/redis:alpine";

    volumes = [
      "/home/santiago/selfhost/nextcloud/nc_redis:/data"
    ];

    # The compose used `command: redis-server --requirepass ${REDIS_PASS}`,
    # which expanded REDIS_PASS at compose time and put it directly in
    # argv (visible in `ps`). For podman we read the password from the
    # env file in the cmd's shell instead, so it isn't in argv at
    # config time.
    environmentFiles = [ "/etc/nixos/containers/nextcloud/env" ];

    cmd = [
      "sh" "-c"
      "exec redis-server --requirepass \"$REDIS_PASS\""
    ];

    extraOptions = [
      # Same alias trick as postgres — config.php has `redis.host = redis`.
      "--network=nextcloud-net:alias=redis"
    ];
  };

  virtualisation.oci-containers.containers.nextcloud-app = mkRootlessContainer {
    # Local image built by systemd.services.nextcloud-image-build
    # below. Tag tracks nextcloudVersion.
    image = "localhost/nextcloud-ffmpeg:${nextcloudVersion}";
    dependsOn = [ "nextcloud-postgres" "nextcloud-redis" ];

    ports = [ "8082:80" ];

    volumes = [
      "/home/santiago/selfhost/nextcloud/nc_config:/var/www/html"
      "/s2:/s2"
    ];

    environment = {
      REDIS_HOST = "nextcloud-redis";
      POSTGRES_HOST = "nextcloud-postgres";
      POSTGRES_DB = "nc_postgres";
      POSTGRES_USER = "oc_santi";

      TRUSTED_PROXIES = "192.168.0.2/24";
      PHP_MEMORY_LIMIT = "2G";
      NEXTCLOUD_TRUSTED_DOMAINS = "nextcloud.toscanini.me host.containers.internal";
      NEXTCLOUD_INIT_HTACCESS = "true";

      # Nextcloud config.php overrides (NC_<key> -> config[key]).
      "NC_overwrite.cli.url" = "https://nextcloud.toscanini.me";
      "NC_overwriteprotocol" = "https";
      "NC_default_phone_region" = "UY";
      "NC_loglevel" = "0";
      "NC_maintenance_window_start" = "100";
    };

    # PG_PASS + REDIS_PASS (REDIS_HOST_PASSWORD aliased below).
    environmentFiles = [ "/etc/nixos/containers/nextcloud/env" ];

    # The official nextcloud image reads REDIS_HOST_PASSWORD; our env
    # file uses REDIS_PASS (matches postgres + makes pre-existing
    # secret naming consistent). Alias it here. ffmpeg is baked into
    # the image (built by nextcloud-image-build), so no apt-get step.
    entrypoint = "/bin/sh";
    cmd = [
      "-c"
      "export REDIS_HOST_PASSWORD=\"$REDIS_PASS\" && exec /entrypoint.sh apache2-foreground"
    ];

    extraOptions = [
      "--network=nextcloud-net"
      # tmpfs for /tmp speeds up Nextcloud's `recognize` app (ML-based
      # content recognition) per its README. The compose did this via
      # a `type: tmpfs` volume entry; podman needs the dedicated flag.
      "--tmpfs=/tmp:exec"
    ];
  };

  # Build localhost/nextcloud-ffmpeg:<ver> from upstream + ffmpeg.
  # Runs before podman-nextcloud-app starts.
  systemd.services.nextcloud-image-build = {
    description = "Build localhost/nextcloud-ffmpeg:${nextcloudVersion}";
    after = [ "network-online.target" ];
    wants = [ "network-online.target" ];
    before = [ "podman-nextcloud-app.service" ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      User = "santiago";
      Group = "users";
      Environment = "XDG_RUNTIME_DIR=/run/user/1000";
      Restart = "on-failure";
      RestartSec = "10s";
      ExecStart = pkgs.writeShellScript "build-nextcloud-image" ''
        set -eu
        cd ${nextcloudImageBuildDir}
        ${pkgs.podman}/bin/podman build \
          --tag localhost/nextcloud-ffmpeg:${nextcloudVersion} \
          --file Containerfile \
          .
      '';
    };
  };

  # Extend the auto-generated podman-nextcloud-app override with a dep
  # on nextcloud-image-build. NixOS module merging combines this with
  # the override from modules/common.nix (Type=oneshot + the bridge
  # dep). `after` and `wants` are list-typed and concatenate.
  systemd.services.podman-nextcloud-app = {
    after = [ "nextcloud-image-build.service" ];
    wants = [ "nextcloud-image-build.service" ];
  };

  # Nextcloud expects cron.php to run every 5 min for background jobs
  # (file scans, notifications, indexing). The official image doesn't
  # ship cron, so we podman-exec into the container from a host-side
  # systemd timer. The unit runs as santiago against santiago's
  # rootless podman; the container is named `nextcloud-app`
  # (oci-containers names the container from the attribute name).
  systemd.services.nextcloud-cron = {
    description = "Run Nextcloud cron.php inside the nextcloud-app container";
    after = [ "podman-nextcloud-app.service" ];
    requires = [ "podman-nextcloud-app.service" ];
    serviceConfig = {
      Type = "oneshot";
      User = "santiago";
      Environment = "XDG_RUNTIME_DIR=/run/user/1000";
      ExecStart = "${pkgs.podman}/bin/podman exec -u www-data nextcloud-app php -f /var/www/html/cron.php";
    };
  };

  systemd.timers.nextcloud-cron = {
    description = "Run Nextcloud cron every 5 minutes";
    wantedBy = [ "timers.target" ];
    partOf = [ "nextcloud-cron.service" ];
    timerConfig = {
      OnCalendar = "*:0/5";
      Persistent = true;  # run on next boot if missed (e.g. server was off)
    };
  };
}
