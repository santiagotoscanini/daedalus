# monitoring — prometheus + grafana + node-exporter + cadvisor.
#
# Four containers on `monitoring-net`:
#   - prometheus scrapes node-exporter and cadvisor by container DNS
#     (e.g. `node-exporter:9100`, `cadvisor:8080`).
#   - grafana queries prometheus on `prometheus:9090`.
#   - prometheus + grafana also join traefik-net so (a) traefik dials
#     them by container DNS, and (b) prometheus reaches any other
#     traefik-net-attached stack (litellm:4000, immich:8081, …) without
#     per-stack host-port publishing.
#   - prometheus keeps its host port :9090 for external scrapers /
#     remote_write / federation; grafana drops its host port.
#
# `prometheus.yml` and the dashboards dir are nix-generated:
#   - `prometheusConfig`: base scrape list + each stack's
#     `myStack.prometheusScrapes` contribution.
#   - `dashboardsDir`: static JSON under ./assets/dashboards/, plus
#     `myStack.grafanaDashboards` (root) and `grafanaDashboardsByFolder`
#     (organized into sidebar folders via `foldersFromFilesStructure`).
# Changing either changes the /nix/store hash → container restarts on
# rebuild. No manual reload.
#
# Wire local `claude` to Grafana via MCP (token from
# https://grafana.toscanini.me/org/serviceaccounts):
#   claude mcp add --transport stdio --scope user grafana -- \
#     podman run --rm -i \
#     -e GRAFANA_URL=https://grafana.toscanini.me \
#     -e GRAFANA_SERVICE_ACCOUNT_TOKEN={TOKEN} \
#     docker.io/grafana/mcp-grafana -t stdio

{
  config,
  lib,
  pkgs,
  mkRootlessContainer,
  mkDotenvSecret,
  ...
}:

let
  # ── Container liveness metric ─────────────────────────
  # cadvisor can't see rootless-podman container cgroups (they live under
  # user@1000.service, invisible to cadvisor), so its per-container series
  # are empty and a dead container fires no alert while its systemd unit
  # stays `active (exited)`. This closes the gap: a 1-min timer writes
  # `container_up{name=...} 0|1` for EVERY declared oci-container into
  # node-exporter's textfile-collector dir. The set is derived from the
  # config at eval time (attrNames below), never hand-maintained, so a
  # newly-added stack is covered automatically.
  #
  # The dir lives at /var/lib/node-exporter/textfile — deliberately NOT
  # under ~/selfhost (rewriting a .prom every minute would churn the
  # 16K-recordsize, snapshotted + replicated selfhost dataset) and NOT on
  # /run (nixos activation's `systemd-tmpfiles` wipes /run dirs on every
  # rebuild, racing the node-exporter bind-mount → podman 125). /var/lib is
  # on rpool/root, which is opted out of snapshots (platform/zfs.nix), so it
  # dodges the churn concern while being persistent — the bind source is
  # always present.
  containerNames = lib.attrNames config.virtualisation.oci-containers.containers;

  textfileDir = "/var/lib/node-exporter/textfile";

  livenessScript = pkgs.writeShellScript "container-up-export" ''
    set -eu
    export PATH=${
      lib.makeBinPath [
        pkgs.podman
        pkgs.coreutils
        pkgs.gnugrep
      ]
    }
    tmp="${textfileDir}/container_up.prom.$$"
    # One podman call; each declared name is 1 iff it appears in `ps`.
    running=$(podman ps --format '{{.Names}}' || true)
    {
      echo "# HELP container_up Declared oci-container running (1) or stopped/missing (0)."
      echo "# TYPE container_up gauge"
      for name in ${lib.concatStringsSep " " containerNames}; do
        if printf '%s\n' "$running" | grep -qxF "$name"; then up=1; else up=0; fi
        echo "container_up{name=\"$name\"} $up"
      done
    } > "$tmp"
    # Atomic swap — node-exporter reads whole files; a half-written file
    # would export a truncated series.
    mv -f "$tmp" "${textfileDir}/container_up.prom"
  '';

  baseScrapes = [
    {
      job_name = "prometheus";
      static_configs = [ { targets = [ "prometheus:9090" ]; } ];
    }

    {
      job_name = "node_exporter";
      static_configs = [ { targets = [ "host.containers.internal:9100" ]; } ];
    }

    {
      job_name = "cadvisor";
      static_configs = [ { targets = [ "cadvisor:8080" ]; } ];
    }
  ];

  # JSON is a YAML 1.1 superset — toJSON sidesteps quoting/escape pitfalls.
  prometheusConfig = pkgs.writeText "prometheus.yml" (
    builtins.toJSON {
      global = {
        scrape_interval = "15s";
        evaluation_interval = "15s";
      };
      scrape_configs = baseScrapes ++ config.myStack.prometheusScrapes;
    }
  );

  # /etc/prometheus must be a dir (rule files land there too). Single
  # generated yml wrapped in a dir so alert_rules.yml can be added later
  # as a one-line extension.
  prometheusDir = pkgs.runCommand "prometheus-etc" { } ''
    mkdir -p $out
    cp ${prometheusConfig} $out/prometheus.yml
  '';

  # Three sources merged into one /nix/store dir mounted into grafana:
  #   1. Static JSON under ./assets/dashboards/         (root)
  #   2. myStack.grafanaDashboards                       (root)
  #   3. myStack.grafanaDashboardsByFolder               (subdirs ↔ sidebar folders)
  dashboardsDir = pkgs.runCommand "grafana-dashboards" { } (
    ''
      mkdir -p $out
      cp -r ${./assets/dashboards}/. $out/
      # store copies are read-only; byFolder contributions below must be able
      # to write into subdirs the assets tree now ships (e.g. System/)
      chmod -R u+w $out
    ''
    + lib.concatStringsSep "\n" (
      lib.mapAttrsToList (
        name: content: "cp ${pkgs.writeText "${name}.json" content} $out/${name}.json"
      ) config.myStack.grafanaDashboards
    )
    + "\n"
    + lib.concatStringsSep "\n" (
      lib.mapAttrsToList (
        folder: dashboards:
        ''
          mkdir -p "$out/${folder}"
        ''
        + lib.concatStringsSep "\n" (
          lib.mapAttrsToList (
            name: content: "cp ${pkgs.writeText "${name}.json" content} \"$out/${folder}/${name}.json\""
          ) dashboards
        )
      ) config.myStack.grafanaDashboardsByFolder
    )
  );
in
{
  # grafana admin credentials: sops-encrypted env.sops, decrypted to
  # /run/secrets/grafana-env at activation. Edit with `sops env.sops`.
  sops.secrets."grafana-env" = mkDotenvSecret ./env.sops;

  # Persistent textfile-collector dir. Owned by santiago so the rootless
  # liveness sweep writes it and node-exporter (UID 0 → host santiago) reads
  # it. On /var/lib (persistent), so unlike a /run path it survives every
  # rebuild — the node-exporter bind source is always present, no 125 race.
  systemd.tmpfiles.rules = [
    "d /var/lib/node-exporter 0755 santiago users -"
    "d ${textfileDir} 0755 santiago users -"
  ];

  # 1-min liveness sweep. Runs as santiago so it can talk to the rootless
  # podman socket; writes the .prom file node-exporter serves.
  systemd.services.container-up-exporter = {
    description = "Export container_up{name} liveness to node-exporter textfile";
    after = [
      "podman.service"
      "systemd-tmpfiles-setup.service"
    ];
    wants = [ "systemd-tmpfiles-setup.service" ];
    serviceConfig = {
      Type = "oneshot";
      User = "santiago";
      Environment = [
        "HOME=/home/santiago"
        "XDG_RUNTIME_DIR=/run/user/1000"
      ];
      ExecStart = livenessScript;
    };
  };
  systemd.timers.container-up-exporter = {
    wantedBy = [ "timers.target" ];
    timerConfig = {
      OnBootSec = "1min";
      OnUnitActiveSec = "1min";
    };
  };

  myStack.containerNetworks = {
    prometheus = "monitoring";
    grafana = "monitoring";
    cadvisor = "monitoring";
    node-exporter = null; # host net — see comment on container below
  };

  myStack.webApps = {
    prometheus = {
      serviceName = "prometheus";
      port = 9090;
      # No auth of its own; grafana + self-scrape dial container-direct
      # and never cross traefik. NOTE: host port 9090 stays open and
      # ungated (external scrapers) — see AUTH.md open decision.
      auth = "oidc";
      homepage = {
        group = "Monitoring";
        description = "TSDB — 30d / 100GB retention";
        icon = "prometheus.png";
        widget = {
          type = "prometheus";
          url = "http://prometheus:9090";
        };
      };
    };
    grafana = {
      serviceName = "grafana";
      port = 3000;
      homepage = {
        group = "Monitoring";
        href = "https://grafana.toscanini.me/bookmarks";
        # Default probe (upstream /) now 302s into the OAuth auto-login
        # chain, which homepage's proxy can't follow. /api/health is
        # auth-exempt.
        siteMonitor = "http://grafana:3000/api/health";
        description = "Dashboards (prometheus + loki)";
        icon = "grafana.png";
        widget = {
          type = "grafana";
          version = 2;
          url = "http://grafana:3000";
          username = "{{HOMEPAGE_VAR_GRAFANA_USER}}";
          password = "{{HOMEPAGE_VAR_GRAFANA_PASS}}";
        };
      };
    };
  };

  virtualisation.oci-containers.containers.prometheus = mkRootlessContainer {
    image = "docker.io/prom/prometheus:v3.13.1@sha256:3c42b892cf723fa54d2f262c37a0e1f80aa8c8ddb1da7b9b0df9455a35a7f893";

    # Host port kept for external scrapers / remote_write / federation
    # (raw API access — bridge-routing via traefik would lose that).
    ports = [ "9090:9090" ];

    cmd = [
      "--config.file=/etc/prometheus/prometheus.yml"
      "--storage.tsdb.path=/prometheus"
      "--web.enable-lifecycle"
      "--storage.tsdb.retention.time=30d"
      "--storage.tsdb.retention.size=100GB"
    ];

    volumes = [
      "${prometheusDir}:/etc/prometheus:ro"
      # litellm scrape auth — bare token rendered from env.sops at boot by
      # litellm-prom-token.service (stacks/litellm/). Mount the DIR (not the
      # file) so a re-render/rotation is picked up without a prometheus restart
      # — a single-file bind pins the old inode until the container restarts.
      "/run/litellm-prom-token:/run/secrets/litellm-prom-token:ro"
      "/home/santiago/selfhost/monitoring/prometheus/data:/prometheus"
    ];

    extraOptions = [
      # Image's default `nobody` (UID 65534) → host 100533, owner of
      # nothing. Override to UID 0 → host santiago, who owns the data dir.
      "--user=0:0"
      "--network=monitoring-net"
      "--network=traefik-net" # scrape migrated stacks + traefik dials by DNS
    ];
  };

  virtualisation.oci-containers.containers.grafana = mkRootlessContainer {
    image = "docker.io/grafana/grafana:13.1.0@sha256:121a7a9ece6dc10b969f1f96eed64b4f07dfac0d0b8abc070f7cb83bbde86f63";
    dependsOn = [ "prometheus" ];

    volumes = [
      "/home/santiago/selfhost/monitoring/grafana/data:/var/lib/grafana"
      # Gmail app password for GF_SMTP_PASSWORD__FILE (shared mail secret).
      "${config.sops.secrets."mail-relay-password".path}:/run/secrets/mail-relay-password:ro"
      "${./assets/provisioning/datasources}:/etc/grafana/provisioning/datasources:ro"
      "${./assets/provisioning/dashboards}:/etc/grafana/provisioning/dashboards:ro"
      "${./assets/provisioning/alerting}:/etc/grafana/provisioning/alerting:ro"
      "${dashboardsDir}:/var/lib/grafana/dashboards:ro"
    ];

    environment = {
      GF_USERS_ALLOW_SIGN_UP = "false";
      GF_SERVER_ROOT_URL = "https://grafana.toscanini.me";
      GF_SERVER_SERVE_FROM_SUB_PATH = "false";

      # SMTP alert delivery via the same Gmail relay msmtp uses. Password
      # read from the bind-mounted mail secret through Grafana's __FILE
      # convention (grafana runs --user=0:0 → santiago, which owns it).
      GF_SMTP_ENABLED = "true";
      GF_SMTP_HOST = "${config.myStack.mail.smtpHost}:${toString config.myStack.mail.smtpPort}";
      GF_SMTP_USER = config.myStack.mail.sender;
      GF_SMTP_PASSWORD__FILE = "/run/secrets/mail-relay-password";
      GF_SMTP_FROM_ADDRESS = config.myStack.mail.sender;
      GF_SMTP_FROM_NAME = "s2-server Grafana";
      GF_SMTP_STARTTLS_POLICY = "MandatoryStartTLS";

      # Pocket ID SSO (AUTH.md). Client creds ride env.sops
      # (GF_AUTH_GENERIC_OAUTH_CLIENT_ID/SECRET). Single-user box:
      # every Pocket ID account maps to Grafana Admin. Basic auth stays
      # on — the homepage widget authenticates with the admin user/pass
      # against the API. Escape hatch: /login?disableAutoLogin.
      GF_AUTH_GENERIC_OAUTH_ENABLED = "true";
      GF_AUTH_GENERIC_OAUTH_NAME = "Pocket ID";
      GF_AUTH_GENERIC_OAUTH_AUTH_URL = "https://id.toscanini.me/authorize";
      GF_AUTH_GENERIC_OAUTH_TOKEN_URL = "https://id.toscanini.me/api/oidc/token";
      GF_AUTH_GENERIC_OAUTH_API_URL = "https://id.toscanini.me/api/oidc/userinfo";
      GF_AUTH_GENERIC_OAUTH_SCOPES = "openid email profile groups";
      GF_AUTH_GENERIC_OAUTH_USE_PKCE = "true";
      GF_AUTH_GENERIC_OAUTH_ALLOW_SIGN_UP = "true";
      GF_AUTH_GENERIC_OAUTH_AUTO_LOGIN = "true";
      GF_AUTH_GENERIC_OAUTH_ROLE_ATTRIBUTE_PATH = "'Admin'";
      GF_AUTH_DISABLE_LOGIN_FORM = "true";
      # Link by email instead of erroring if an existing account shares
      # the address (single-user box; "insecure" is fine here).
      GF_AUTH_OAUTH_ALLOW_INSECURE_EMAIL_LOOKUP = "true";
    };

    # GF_SECURITY_ADMIN_USER + GF_SECURITY_ADMIN_PASSWORD.
    environmentFiles = [ config.sops.secrets."grafana-env".path ];

    extraOptions = [
      "--user=0:0"
      "--network=monitoring-net"
      "--network=traefik-net"
    ];
  };

  # node-exporter runs in the host netns so it sees the real `enp3s0`
  # and reports actual NIC traffic. Inside a bridge it would only see
  # a synthetic `eth0` with meaningless 0 traffic.
  virtualisation.oci-containers.containers.node-exporter = mkRootlessContainer {
    image = "docker.io/prom/node-exporter:v1.12.1@sha256:1b4e4438faca4dd7e001dd445d161a4a2091b0fededa84093b3a8dfeae1f1be0";

    cmd = [
      "--path.procfs=/host/proc"
      "--path.sysfs=/host/sys"
      "--path.rootfs=/rootfs"
      "--collector.filesystem.mount-points-exclude=^/(sys|proc|dev|host|etc)($|/)"
      # Read container_up{} (+ any future .prom) from the textfile dir.
      "--collector.textfile.directory=/var/lib/node-exporter/textfile"
    ];

    volumes = [
      "/run/udev/data:/run/udev/data:ro"
      "/proc:/host/proc:ro"
      "/sys:/host/sys:ro"
      "/:/rootfs:ro"
      "${textfileDir}:/var/lib/node-exporter/textfile:ro"
    ];

    extraOptions = [
      "--network=host"
    ];
  };

  # No /var/lib/docker or /var/run mounts — the latter would overlay the
  # container's /run and hide /run/.containerenv that podman's crun
  # needs. cadvisor still reports cgroup-level container stats via the
  # /sys mount; per-container CPU/RAM works.
  virtualisation.oci-containers.containers.cadvisor = mkRootlessContainer {
    image = "gcr.io/cadvisor/cadvisor:v0.55.1@sha256:3de2bd5203120b866d74a9b283b2ffb8ec382fbf9dc321814700c6ea6f44ec57";

    volumes = [
      "/:/rootfs:ro"
      "/sys:/sys:ro"
      "/dev/disk:/dev/disk:ro"
      "/etc/machine-id:/etc/machine-id:ro"
    ];

    extraOptions = [
      # De-privileged (was `--privileged`): cadvisor reads host cgroup /
      # machine stats via the ro /sys + /rootfs mounts, which don't need
      # full privilege. /dev/kmsg (OOM-event parsing) is best-effort — with
      # kernel.dmesg_restrict=1 it needs CAP_SYSLOG, deliberately NOT
      # granted; the container_* metrics don't depend on it.
      "--device=/dev/kmsg"
      "--network=monitoring-net"
    ];
  };
}
