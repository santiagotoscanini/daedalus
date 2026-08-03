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
  pkgs,
  mkRootlessContainer,
  mkDotenvSecret,
  mkLocalImage,
  mkSecretRender,
  hostUid,
  ...
}:

let
  # Bump to track upstream. After bumping, `nixos-rebuild switch`
  # rebuilds the image and restarts the app; then run the post-upgrade
  # `occ` commands above by hand.
  nextcloudVersion = "34";
  # Digest of docker.io/library/nextcloud:''${nextcloudVersion} — makes
  # the custom build reproducible. Bump together with nextcloudVersion.
  nextcloudBaseDigest = "sha256:e93ccfc952c95f18175f3d297fb2f60c35070c05ca976050c250a9ddab793e75";

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

  nextcloudImage = mkLocalImage {
    name = "nextcloud-ffmpeg";
    tagPrefix = nextcloudVersion;
    contextDir = nextcloudImageBuildDir;
    gates = [ "podman-nextcloud-app.service" ];
  };
in
{
  # REDIS_HOST_PASSWORD (one sops source, two consumers: the app's
  # redis.config.php reads it from env; the redis server gets it via
  # the rendered redis.conf below): env.sops, decrypted to
  # /run/secrets/nextcloud-env at activation. Edit with `sops env.sops`.
  # The DB password lives in config.php (mutable app state), sourced
  # from the app-db bootstrap env (they must stay in sync — rotation
  # of the nextcloud db password means updating config.php too).
  sops.secrets."nextcloud-env" = mkDotenvSecret ./env.sops;

  # redis.conf on tmpfs: the stock entrypoint drops privileges to the
  # image's redis user only when argv is `redis-server <conf...>` — a
  # password-in-cmd shell wrapper would defeat the drop and run redis
  # as container root. The file is owned by the container redis uid
  # (999 → host 100998) so the dropped process can read it; the DIR is
  # mounted (not the file) so a re-render can't pin a stale inode.
  systemd.services.nextcloud-redis-conf = mkSecretRender {
    description = "Render redis.conf for nextcloud-redis (requirepass from sops)";
    gates = [ "podman-nextcloud-redis.service" ];
    dir = "/run/nextcloud-redis-conf";
    file = "/run/nextcloud-redis-conf/redis.conf";
    owner = hostUid 999;
    prep = ''
      REDIS_HOST_PASSWORD=$(grep '^REDIS_HOST_PASSWORD=' /run/secrets/nextcloud-env | cut -d= -f2-)
    '';
    content = ''
      requirepass ''${REDIS_HOST_PASSWORD}
      dir /data
    '';
  };

  # Database on the shared app-db cluster: role + db + env file with
  # DATABASE_URL, materialized by app-db-nextcloud-bootstrap.service
  # (see stacks/app-db/). config.php holds the live connection values.
  fleet.appDatabases.nextcloud.consumers = [ "nextcloud-app" ];

  fleet.bridgeMemberships = {
    # The app resolves redis via REDIS_HOST (redis.config.php overrides
    # config.php's legacy redis block), so the container name is enough.
    nextcloud-redis = [ "nextcloud" ];
    nextcloud-app = [
      "nextcloud"
      "app-db"
      "traefik"
    ]; # config.php dials pg:5432
  };

  fleet.logStacks.nextcloud = [
    "nextcloud-app"
    "nextcloud-redis"
  ];

  fleet.statePaths = {
    "/home/santiago/selfhost/nextcloud/nc_config".uid = 33; # www-data
    "/home/santiago/selfhost/nextcloud/nc_redis".uid = 999;
  };

  # Split-horizon publish — same hostname for LAN (websecure) + off-LAN
  # (cfweb via CF tunnel), wildcard cert covers both. HSTS is set by
  # Nextcloud itself in its .htaccess/config.php.
  fleet.webApps.nextcloud = {
    serviceName = "nextcloud-app";
    port = 80;
    exposeRemotely = true;
    homepage = {
      group = "Home";
      extra.weight = 30;
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
    image = "docker.io/library/redis:alpine@sha256:8096655e437712b07503796fb64d81359256cfcff0ab29d95a7da72863786efb";

    volumes = [
      "/home/santiago/selfhost/nextcloud/nc_redis:/data"
      "/run/nextcloud-redis-conf:/etc/redis:ro"
    ];

    # Stock entrypoint: `redis-server <conf>` argv → gosu-drop to the
    # redis user (uid 999 → host 100998) before serving. The requirepass
    # lives in the rendered conf, not in argv or env.
    cmd = [
      "redis-server"
      "/etc/redis/redis.conf"
    ];
  };

  virtualisation.oci-containers.containers.nextcloud-app = mkRootlessContainer {
    # Built by nextcloud-image-build below; the tag carries the build
    # context hash so digest/Containerfile bumps restart the app.
    inherit (nextcloudImage) image;
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

      TRUSTED_PROXIES = config.fleet.bridgeSubnets.traefik;
      PHP_MEMORY_LIMIT = "2G";
      NEXTCLOUD_TRUSTED_DOMAINS = "nextcloud.toscanini.me";
      NEXTCLOUD_INIT_HTACCESS = "true";

      # Nextcloud config.php overrides (NC_<key> -> config[key]).
      "NC_overwrite.cli.url" = "https://nextcloud.toscanini.me";
      "NC_overwriteprotocol" = "https";
      "NC_default_phone_region" = "UY";
      # 2 = warning (upstream default). 0 would be full debug — floods
      # nextcloud.log on the 16K-recordsize, frequent-snapshot dataset.
      "NC_loglevel" = "2";
      # >= 24 disables the window gate: background jobs may run at any
      # hour (100 is also upstream's "not configured" default).
      "NC_maintenance_window_start" = "100";
    };

    # REDIS_HOST_PASSWORD — read by the stock entrypoint's
    # redis.config.php; no entrypoint override needed.
    environmentFiles = [ config.sops.secrets."nextcloud-env".path ];

    extraOptions = [
      # tmpfs for /tmp speeds up the `recognize` ML app per its README.
      "--tmpfs=/tmp:exec"
    ];
  };

  systemd.services.nextcloud-image-build = nextcloudImage.service;

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
