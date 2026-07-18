# nextcloud — app + redis on nextcloud-net, custom-built image +
# host-side cron timer. The database lives on the shared app-db
# cluster (stacks/app-db); config.php holds the live connection
# values (dbhost=pg, db/role `nextcloud`).
#
# nextcloud-net carries inter-container DNS (redis). The app container
# also joins app-db-net (to dial `pg`) and traefik-net so traefik
# dials it as `http://nextcloud-app:80` without host-publishing. The
# websecure + cfweb dual-router shape is materialized by
# `exposeRemotely = true`.
#
# Post-Nextcloud-version-upgrade manual steps (NOT auto-run — slow on
# large instances, would block startup):
#   sudo -u santiago env HOME=/home/santiago XDG_RUNTIME_DIR=/run/user/1000 \
#     podman exec -u www-data nextcloud-app php occ db:add-missing-indices
#   sudo -u santiago env HOME=/home/santiago XDG_RUNTIME_DIR=/run/user/1000 \
#     podman exec -u www-data nextcloud-app php occ maintenance:repair \
#       --include-expensive

{
  config,
  lib,
  pkgs,
  mkRootlessContainer,
  mkDotenvSecret,
  ...
}:

let
  # Bump to track upstream. After bumping, `nixos-rebuild switch`
  # rebuilds the image and restarts the app; then run the post-upgrade
  # `occ` commands above by hand.
  nextcloudVersion = "34";
  # Digest of docker.io/library/nextcloud:''${nextcloudVersion} — makes
  # the custom build reproducible. Bump together with nextcloudVersion.
  nextcloudBaseDigest = "sha256:6444fc5450302534e850b4d23c05b5f06c7b0d25bd5ece716452061454699c58";

  # Official nextcloud:N doesn't ship ffmpeg, but the preview generator
  # and `recognize` ML app both want it. Build localhost/nextcloud-ffmpeg
  # once via the systemd oneshot below; podman layer-caches subsequent
  # builds (~instant).
  nextcloudImageBuildDir = pkgs.writeTextDir "Containerfile" ''
    FROM docker.io/library/nextcloud:${nextcloudVersion}@${nextcloudBaseDigest}
    RUN apt-get update \
     && apt-get install -y --no-install-recommends ffmpeg \
     && apt-get clean \
     && rm -rf /var/lib/apt/lists/*
  '';
in
{
  # REDIS_PASS (shared by redis + app): sops-encrypted env.sops,
  # decrypted to /run/secrets/nextcloud-env at activation. Edit with
  # `sops env.sops`. The DB password lives in config.php (mutable app
  # state), sourced from the app-db bootstrap env at migration time.
  sops.secrets."nextcloud-env" = mkDotenvSecret ./env.sops;

  # Database on the shared app-db cluster: role + db + env file with
  # DATABASE_URL, materialized by app-db-nextcloud-bootstrap.service
  # (see stacks/app-db/). config.php holds the live connection values.
  myStack.appDatabases.nextcloud = { };

  myStack.containerNetworks = {
    nextcloud-redis = [ "nextcloud:alias=redis" ]; # config.php has redis.host = redis
    nextcloud-app = [ "nextcloud" "app-db" "traefik" ]; # config.php dials pg:5432
  };

  myStack.stateDirs = {
    "/home/santiago/selfhost/nextcloud/nc_config".uid = 33; # www-data
    "/home/santiago/selfhost/nextcloud/nc_redis".uid = 999;
  };

  # nextcloud-redis BGSAVE under memory pressure (1 = always allow).
  boot.kernel.sysctl."vm.overcommit_memory" = 1;

  # Split-horizon publish — same hostname for LAN (websecure) + off-LAN
  # (cfweb via CF tunnel), wildcard cert covers both. HSTS is set by
  # Nextcloud itself in its .htaccess/config.php.
  myStack.webApps.nextcloud = {
    serviceName = "nextcloud-app";
    port = 80;
    exposeRemotely = true;
    homepage = {
      group = "Cloud & AI";
      description = "Files, calendar, contacts — primary household sync";
      icon = "nextcloud.png";
      # Probe + widget through traefik: NC_overwriteprotocol 30x-redirects
      # plain HTTP, which homepage's proxy can't follow (--add-host'ed).
      siteMonitor = "https://nextcloud.toscanini.me";
      widget = {
        type = "nextcloud";
        url = "https://nextcloud.toscanini.me";
        key = "{{HOMEPAGE_VAR_NEXTCLOUD_KEY}}";
        fields = [
          "freespace"
          "activeusers"
          "numfiles"
          "numshares"
        ];
      };
    };
  };


  virtualisation.oci-containers.containers.nextcloud-redis = mkRootlessContainer {
    image = "docker.io/library/redis:alpine@sha256:9d317178eceac8454a2284a9e6df2466b93c745529947f0cd42a0fa9609d7005";

    volumes = [
      "/home/santiago/selfhost/nextcloud/nc_redis:/data"
    ];

    # Read REDIS_PASS in the cmd's shell so the secret isn't baked
    # into the unit's argv.
    environmentFiles = [ config.sops.secrets."nextcloud-env".path ];

    cmd = [
      "sh"
      "-c"
      "exec redis-server --requirepass \"$REDIS_PASS\""
    ];

    extraOptions = [
    ];
  };

  virtualisation.oci-containers.containers.nextcloud-app = mkRootlessContainer {
    # Built by nextcloud-image-build below.
    image = "localhost/nextcloud-ffmpeg:${nextcloudVersion}";
    dependsOn = [ "nextcloud-redis" ];

    volumes = [
      "/home/santiago/selfhost/nextcloud/nc_config:/var/www/html"
      # Only the external-storage paths occ actually serves — NOT all of /s2.
      # A Nextcloud compromise (public, RCE-prone) cannot reach
      # /s2/immich, /s2/tv, or /s2/backup. Verified via `occ files_external:list`.
      "/s2/santi:/s2/santi"
      "/s2/shared:/s2/shared"
      "/s2/sofi:/s2/sofi"
    ];

    environment = {
      REDIS_HOST = "nextcloud-redis";
      # No POSTGRES_* vars: the instance is installed, so the image
      # only reads DB settings from config.php.

      TRUSTED_PROXIES = "${config.myStack.lanIp}/24";
      PHP_MEMORY_LIMIT = "2G";
      NEXTCLOUD_TRUSTED_DOMAINS = "nextcloud.toscanini.me host.containers.internal";
      NEXTCLOUD_INIT_HTACCESS = "true";

      # Nextcloud config.php overrides (NC_<key> -> config[key]).
      "NC_overwrite.cli.url" = "https://nextcloud.toscanini.me";
      "NC_overwriteprotocol" = "https";
      "NC_default_phone_region" = "UY";
      "NC_loglevel" = "0";
      # >= 24 disables the window gate: background jobs may run at any
      # hour (100 is also upstream's "not configured" default).
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
      # tmpfs for /tmp speeds up the `recognize` ML app per its README.
      "--tmpfs=/tmp:exec"
    ];
  };

  # Build localhost/nextcloud-ffmpeg:<ver>. Runs before nextcloud-app.
  systemd.services.nextcloud-image-build = {
    description = "Build localhost/nextcloud-ffmpeg:${nextcloudVersion}";
    # linger-users gates /run/user/1000 → rootless podman → newuidmap.
    after = [
      "network-online.target"
      "linger-users.service"
    ];
    wants = [
      "network-online.target"
      "linger-users.service"
    ];
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
    after = [
      "nextcloud-image-build.service"
      "app-db-nextcloud-bootstrap.service"
    ];
    wants = [
      "nextcloud-image-build.service"
      "app-db-nextcloud-bootstrap.service"
    ];
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
      Persistent = true; # catch up if the server was off
    };
  };
}
