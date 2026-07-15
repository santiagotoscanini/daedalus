# nextcloud — 3 containers on nextcloud-net + custom-built image +
# host-side cron timer.
#
# nextcloud-net carries inter-container DNS (postgres/redis). The app
# container also joins traefik-net so traefik dials it as
# `http://nextcloud-app:80` without host-publishing. The websecure +
# cfweb dual-router shape is materialized by `exposeRemotely = true`.
#
# Post-Nextcloud-version-upgrade manual steps (NOT auto-run — slow on
# large instances, would block startup):
#   sudo -u santiago env HOME=/home/santiago XDG_RUNTIME_DIR=/run/user/1000 \
#     podman exec -u www-data nextcloud-app php occ db:add-missing-indices
#   sudo -u santiago env HOME=/home/santiago XDG_RUNTIME_DIR=/run/user/1000 \
#     podman exec -u www-data nextcloud-app php occ maintenance:repair \
#       --include-expensive

{ config, lib, pkgs, mkRootlessContainer, ... }:

let
  # Bump to track upstream. After bumping, `nixos-rebuild switch`
  # rebuilds the image and restarts the app; then run the post-upgrade
  # `occ` commands above by hand.
  nextcloudVersion = "34";

  # Official nextcloud:N doesn't ship ffmpeg, but the preview generator
  # and `recognize` ML app both want it. Build localhost/nextcloud-ffmpeg
  # once via the systemd oneshot below; podman layer-caches subsequent
  # builds (~instant).
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
  # PG_PASS + REDIS_PASS (shared by postgres, redis, app): sops-encrypted env.sops, decrypted to
  # /run/secrets/nextcloud-env at activation. Edit with `sops env.sops`.
  sops.secrets."nextcloud-env" = {
    sopsFile = ./env.sops;
    format   = "dotenv";
    key      = "";
    owner    = "santiago";
  };

  myStack.containerNetworks = {
    nextcloud-postgres = "nextcloud";
    nextcloud-redis    = "nextcloud";
    nextcloud-app      = "nextcloud";
  };

  # Split-horizon publish — same hostname for LAN (websecure) + off-LAN
  # (cfweb via CF tunnel), wildcard cert covers both. HSTS is set by
  # Nextcloud itself in its .htaccess/config.php.
  myStack.webApps.nextcloud = {
    hostname = "nextcloud.toscanini.me";
    serviceName = "nextcloud-app";
    port = 80;
    exposeRemotely = true;
  };

  myStack.homepageServices."Cloud & AI" = [{
    name = "Nextcloud";
    href = "https://nextcloud.toscanini.me";
    description = "Files, calendar, contacts — primary household sync";
    icon = "nextcloud.png";
    siteMonitor = "https://nextcloud.toscanini.me";
    widget = {
      type = "nextcloud";
      url = "https://nextcloud.toscanini.me";
      key = "{{HOMEPAGE_VAR_NEXTCLOUD_KEY}}";
      fields = [ "freespace" "activeusers" "numfiles" "numshares" ];
    };
  }];

  # `:16` is load-bearing: the on-disk cluster was initdb'd for PG 16.
  # Bumping requires a pg_upgrade dance, NOT just a tag bump.
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
    environmentFiles = [ config.sops.secrets."nextcloud-env".path ];

    extraOptions = [
      # `:alias=postgres` — persisted config.php (from compose era when
      # the service was named just `postgres`) resolves both names.
      "--network=nextcloud-net:alias=postgres"
    ];
  };

  virtualisation.oci-containers.containers.nextcloud-redis = mkRootlessContainer {
    image = "docker.io/library/redis:alpine";

    volumes = [
      "/home/santiago/selfhost/nextcloud/nc_redis:/data"
    ];

    # Read REDIS_PASS in the cmd's shell so it's not in argv at config
    # time (vs. the old compose which interpolated into argv directly).
    environmentFiles = [ config.sops.secrets."nextcloud-env".path ];

    cmd = [
      "sh" "-c"
      "exec redis-server --requirepass \"$REDIS_PASS\""
    ];

    extraOptions = [
      "--network=nextcloud-net:alias=redis"   # config.php has redis.host = redis
    ];
  };

  virtualisation.oci-containers.containers.nextcloud-app = mkRootlessContainer {
    # Built by nextcloud-image-build below.
    image = "localhost/nextcloud-ffmpeg:${nextcloudVersion}";
    dependsOn = [ "nextcloud-postgres" "nextcloud-redis" ];

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
    environmentFiles = [ config.sops.secrets."nextcloud-env".path ];

    # Image reads REDIS_HOST_PASSWORD; our env file uses REDIS_PASS for
    # naming consistency. Alias here.
    entrypoint = "/bin/sh";
    cmd = [
      "-c"
      "export REDIS_HOST_PASSWORD=\"$REDIS_PASS\" && exec /entrypoint.sh apache2-foreground"
    ];

    extraOptions = [
      "--network=nextcloud-net"
      "--network=traefik-net"   # traefik dials http://nextcloud-app:80
      # tmpfs for /tmp speeds up the `recognize` ML app per its README.
      "--tmpfs=/tmp:exec"
    ];
  };

  # Build localhost/nextcloud-ffmpeg:<ver>. Runs before nextcloud-app.
  systemd.services.nextcloud-image-build = {
    description = "Build localhost/nextcloud-ffmpeg:${nextcloudVersion}";
    # linger-users gates /run/user/1000 → rootless podman → newuidmap.
    after = [ "network-online.target" "linger-users.service" ];
    wants = [ "network-online.target" "linger-users.service" ];
    before = [ "podman-nextcloud-app.service" ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      User = "santiago";
      Group = "users";
      Environment = "XDG_RUNTIME_DIR=/run/user/1000";
      Restart = "on-failure";
      RestartSec = "1s";
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

  # NixOS module merging concatenates after/wants with common.nix's
  # auto-generated override.
  systemd.services.podman-nextcloud-app = {
    after = [ "nextcloud-image-build.service" ];
    wants = [ "nextcloud-image-build.service" ];
  };

  # Nextcloud expects cron.php every 5 min for background jobs
  # (file scans, notifications, indexing). Official image doesn't ship
  # cron — podman-exec from a host-side systemd timer instead.
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
      Persistent = true;  # catch up if the server was off
    };
  };
}
