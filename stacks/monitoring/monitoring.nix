# monitoring — prometheus + grafana + node-exporter.
#
# Three containers on `monitoring-net`:
#   - prometheus scrapes node-exporter at host.containers.internal:9100
#     (node-exporter runs on the host network to read real NIC stats,
#     so bridge DNS can't reach it).
#   - grafana queries prometheus on `prometheus:9090`.
#   - prometheus + grafana also join traefik-net so (a) traefik dials
#     them by container DNS, and (b) prometheus reaches any other
#     traefik-net-attached stack (litellm:4000, immich:8081, …) without
#     per-stack host-port publishing.
#   - neither prometheus nor grafana publishes a host port — both are
#     reachable via traefik (prometheus.toscanini.me / grafana.toscanini.me)
#     or by container DNS on their bridges.
#
# `prometheus.yml` and the dashboards dir are nix-generated:
#   - `prometheusConfig`: base scrape list + each stack's
#     `fleet.prometheusScrapes` contribution.
#   - `dashboardsDir`: static JSON under ./assets/dashboards/, plus
#     `fleet.grafanaDashboards` (root) and `grafanaDashboardsByFolder`
#     (organized into sidebar folders via `foldersFromFilesStructure`).
# Changing either changes the /nix/store hash → container restarts on
# rebuild. No manual reload.
#
# Claude reaches Grafana/Loki/Prometheus via the `grafana` MCP server
# declared in .claude/mcp.json.sops (project-scoped, sops-encrypted) —
# a Viewer service-account token minted via Grafana's own API. Rotate by
# minting a new token and editing that sops file, not here.

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
  # No PACKAGED cgroup exporter (cadvisor-style) can see rootless-podman
  # containers — cadvisor walks the system cgroup tree and never descends into
  # user@1000.service — and a dead container's systemd unit
  # stays `active (exited)` (Type=oneshot). This closes the gap: a 1-min
  # timer writes
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

  # Where rootless podman puts every container's cgroup. Uniform for all of
  # them (verified: 73/73 scopes sit directly here), so the path can be built
  # from the container id instead of asking podman for it one inspect at a
  # time. `user@1000.service` is santiago's systemd user manager; the inner
  # `user.slice` is podman's own default parent within it.
  cgroupRoot = "/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/user.slice";

  # The router, and something past it. Two pings a minute is the whole
  # extent of what this house can learn about its own uplink: the TP-Link
  # serves no API, so every fact about it has to be measured from this side.
  #
  # Two probes rather than one because separately they localise a fault that
  # either alone only reports. Gateway up + internet down is the ISP; both
  # down is this box's link. A literal address for the far end, never a
  # name — resolving it would route the check through pi-hole and turn a DNS
  # outage into a phantom internet outage.
  gateway = config.networking.defaultGateway.address;
  farSide = "1.1.1.1";

  livenessScript = pkgs.writeShellScript "container-up-export" ''
    set -eu
    export PATH=${
      lib.makeBinPath [
        pkgs.podman
        pkgs.coreutils
        pkgs.gnugrep
        pkgs.gawk # cpu.max quota → cores, the one bit of float division here
        pkgs.iputils # the only way to learn anything about the router
        pkgs.systemd
      ]
    }
    tmp="${textfileDir}/liveness.prom.$$"
    # One podman call; each declared name is 1 iff it appears in `ps`.
    running=$(podman ps --format '{{.Names}}' || true)
    # Failed system units — node-exporter runs without --collector.systemd,
    # so this textfile gauge is the only systemd-health signal prometheus
    # sees. `systemctl list-units` is read-only; works unprivileged.
    failed=$(systemctl --failed --plain --no-legend --no-pager | wc -l)
    {
      echo "# HELP container_up Declared oci-container running (1) or stopped/missing (0)."
      echo "# TYPE container_up gauge"
      for name in ${lib.concatStringsSep " " containerNames}; do
        if printf '%s\n' "$running" | grep -qxF "$name"; then up=1; else up=0; fi
        echo "container_up{name=\"$name\"} $up"
      done
      echo "# HELP systemd_failed_units Count of systemd system units in failed state."
      echo "# TYPE systemd_failed_units gauge"
      echo "systemd_failed_units $failed"

      # The uplink, one hop at a time.
      #
      # `rtt` is emitted only when the probe answered, so a gap in the graph
      # is an outage rather than a zero that reads as "instant". `up` is the
      # series to alert on; the pair of them says which side is at fault.
      echo "# HELP network_hop_up Probe answered (1) or timed out (0)."
      echo "# TYPE network_hop_up gauge"
      echo "# HELP network_hop_rtt_seconds Round trip to the hop, absent when it did not answer."
      echo "# TYPE network_hop_rtt_seconds gauge"
      for hop in "gateway ${gateway}" "internet ${farSide}"; do
        set -- $hop
        # -n so a reply never triggers a reverse lookup; the whole point of
        # probing by address is not to depend on the resolver.
        if rtt=$(ping -c 1 -W 1 -n -q "$2" 2>/dev/null | awk -F'[/=]' '/^rtt|^round-trip/ { printf "%.6f", $5 / 1000 }') \
           && [ -n "$rtt" ]; then
          echo "network_hop_up{hop=\"$1\"} 1"
          echo "network_hop_rtt_seconds{hop=\"$1\"} $rtt"
        else
          echo "network_hop_up{hop=\"$1\"} 0"
        fi
      done

      # Per-container resource usage, straight out of cgroup v2.
      #
      # cadvisor can't reach these, but nothing stops us reading the files
      # ourselves: systemd delegates `cpu io memory pids` to
      # user@1000.service, so every container gets a real cgroup with real
      # accounting at a uniform path, and santiago owns it.
      #
      # Read from the filesystem rather than from `podman stats`, which
      # reports pre-formatted strings ("41.35MB", "0.08%") that would have to
      # be parsed back into numbers, and whose CPU percentage with
      # --no-stream is a whole-lifetime average — useless for a graph. Here
      # CPU is exported as the raw counter and rate() does the work, which is
      # what prometheus is for.
      echo "# HELP container_cpu_usage_seconds_total Cumulative CPU time consumed by a rootless container."
      echo "# TYPE container_cpu_usage_seconds_total counter"
      echo "# HELP container_memory_usage_bytes Current charge against the container's memory cgroup, page cache included."
      echo "# TYPE container_memory_usage_bytes gauge"
      echo "# HELP container_memory_limit_bytes memory.max, emitted only when a limit is set."
      echo "# TYPE container_memory_limit_bytes gauge"
      echo "# HELP container_cpu_limit_cores cpu.max quota expressed in cores, emitted only when a limit is set."
      echo "# TYPE container_cpu_limit_cores gauge"
      echo "# HELP container_pids Processes and threads in the container."
      echo "# TYPE container_pids gauge"
      echo "# HELP container_pids_limit pids.max, emitted only when a limit is set."
      echo "# TYPE container_pids_limit gauge"
      echo "# HELP container_oom_kills_total Processes killed by the cgroup OOM killer."
      echo "# TYPE container_oom_kills_total counter"
      echo "# HELP container_network_receive_bytes_total Bytes into the container's network namespace, tunnels excluded."
      echo "# TYPE container_network_receive_bytes_total counter"
      echo "# HELP container_network_transmit_bytes_total Bytes out of the container's network namespace, tunnels excluded."
      echo "# TYPE container_network_transmit_bytes_total counter"

      # One inspect for the whole fleet — the same single call the
      # `podman ps --no-trunc` this replaces cost, and the two extra fields
      # are what make per-container NETWORK counters possible at all. A
      # cgroup accounts cpu, memory and pids but never bytes, because a
      # network namespace is not a cgroup; /proc/<pid>/net/dev is the same
      # counter the kernel would show from inside the container.
      podman inspect --format '{{.ID}} {{.Name}} {{.State.Pid}} {{.HostConfig.NetworkMode}}' \
        $running 2>/dev/null | while read -r id name pid netmode; do
        cg="${cgroupRoot}/libpod-$id.scope"
        [ -d "$cg" ] || continue

        # usage_usec is the whole subtree's CPU time in microseconds.
        usec=$(grep -m1 '^usage_usec ' "$cg/cpu.stat" 2>/dev/null | cut -d' ' -f2) || true
        [ -n "''${usec:-}" ] && echo "container_cpu_usage_seconds_total{name=\"$name\"} $(( usec / 1000000 )).$(printf '%06d' $(( usec % 1000000 )))"

        mem=$(cat "$cg/memory.current" 2>/dev/null) || true
        [ -n "''${mem:-}" ] && echo "container_memory_usage_bytes{name=\"$name\"} $mem"

        # "max" means uncapped. Emitting nothing beats emitting +Inf or the
        # host's RAM: absent is unambiguous, and a graph that divides by this
        # series simply has no line rather than a wrong one.
        memmax=$(cat "$cg/memory.max" 2>/dev/null) || true
        [ -n "''${memmax:-}" ] && [ "$memmax" != "max" ] && echo "container_memory_limit_bytes{name=\"$name\"} $memmax"

        # cpu.max is "QUOTA PERIOD", or "max PERIOD" when uncapped.
        set -- $(cat "$cg/cpu.max" 2>/dev/null || echo "max 100000")
        [ "$1" != "max" ] && echo "container_cpu_limit_cores{name=\"$name\"} $(awk "BEGIN{printf \"%.4f\", $1/$2}")"

        pids=$(cat "$cg/pids.current" 2>/dev/null) || true
        [ -n "''${pids:-}" ] && echo "container_pids{name=\"$name\"} $pids"

        pidsmax=$(cat "$cg/pids.max" 2>/dev/null) || true
        [ -n "''${pidsmax:-}" ] && [ "$pidsmax" != "max" ] && echo "container_pids_limit{name=\"$name\"} $pidsmax"

        # The signal that a memory cap is actually too tight. Usage sitting at
        # the limit is normal (page cache is charged there and is reclaimable);
        # this counter moving is not.
        oom=$(grep -m1 '^oom_kill ' "$cg/memory.events" 2>/dev/null | cut -d' ' -f2) || true
        [ -n "''${oom:-}" ] && echo "container_oom_kills_total{name=\"$name\"} $oom"

        # Two kinds of container are skipped here rather than reported as
        # zero, and both would otherwise be a lie about who moved the bytes.
        # `host` shares the host's interfaces, so its counters ARE
        # node-exporter's — printing them under one app's name would
        # attribute the entire box to it. `container:<id>` borrows another
        # container's namespace: the ten sharing gluetun's all read the same
        # numbers, so emitting each would multiply one flow by ten. The
        # namespace owner reports for the group, which is also the only
        # honest reading available — a shared namespace has no per-member
        # split to report.
        #
        # tun/wg devices are left out of the sum for the reason a packet is
        # not counted twice: inside gluetun the same payload crosses tun0
        # decrypted and enp3s0 encrypted. Summing both would double every
        # byte the VPN carries. What is left is what crossed the wire.
        case "$netmode" in
          host | container:*) ;;
          *)
            set -- $(awk 'NR > 2 {
                p = index($0, ":")
                dev = substr($0, 1, p - 1); gsub(/[ \t]/, "", dev)
                if (dev == "lo" || dev ~ /^(tun|wg)/) next
                split(substr($0, p + 1), b, " ")
                rx += b[1]; tx += b[9]
              } END { printf "%d %d", rx, tx }' "/proc/$pid/net/dev" 2>/dev/null || true)
            [ $# -eq 2 ] && {
              echo "container_network_receive_bytes_total{name=\"$name\"} $1"
              echo "container_network_transmit_bytes_total{name=\"$name\"} $2"
            }
            ;;
        esac
      done
    } > "$tmp"
    # Atomic swap — node-exporter reads whole files; a half-written file
    # would export a truncated series.
    mv -f "$tmp" "${textfileDir}/liveness.prom"
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

  ];

  # JSON is a YAML 1.1 superset — toJSON sidesteps quoting/escape pitfalls.
  prometheusConfig = pkgs.writeText "prometheus.yml" (
    builtins.toJSON {
      global = {
        scrape_interval = "15s";
        evaluation_interval = "15s";
      };
      scrape_configs = baseScrapes ++ config.fleet.prometheusScrapes;
      # OTLP-push ingestion (open-webui OpenTelemetry). Promote the OTel
      # resource attribute service.name to a `service_name` label so
      # pushed series are filterable per app (e.g. service_name="open-webui").
      otlp = {
        promote_resource_attributes = [
          "service.name"
          "service.instance.id"
        ];
      };
    }
  );

  # /etc/prometheus must be a dir (rule files land there too). Single
  # generated yml wrapped in a dir so alert_rules.yml can be added later
  # as a one-line extension.
  prometheusDir = pkgs.runCommand "prometheus-etc" { } ''
    mkdir -p $out
    cp ${prometheusConfig} $out/prometheus.yml
  '';

  # Two sources merged into one /nix/store dir mounted into grafana:
  #   1. Static JSON under ./assets/dashboards/         (root + subdirs)
  #   2. fleet.grafanaDashboardsByFolder               (subdirs ↔ sidebar folders)
  dashboardsDir = pkgs.runCommand "grafana-dashboards" { } (
    ''
      mkdir -p $out
      cp -r ${./assets/dashboards}/. $out/
      # store copies are read-only; byFolder contributions below must be able
      # to write into the subdirs the assets tree ships (e.g. System/)
      chmod -R u+w $out
    ''
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
      ) config.fleet.grafanaDashboardsByFolder
    )
  );

  # Alerting provisioning: rules + policies are static assets; the
  # contact point is GENERATED so the recipient derives from
  # fleet.mail.alertTo instead of a second hardcoded copy.
  contactPointsYaml = (pkgs.formats.yaml { }).generate "contact-points.yaml" {
    apiVersion = 1;
    contactPoints = [
      {
        orgId = 1;
        name = "email";
        receivers = [
          {
            uid = "email-cp-1";
            type = "email";
            # Delivered via Grafana's own SMTP (GF_SMTP_*, below; the
            # same Gmail relay msmtp uses).
            settings.addresses = config.fleet.mail.alertTo;
            disableResolveMessage = false;
          }
        ];
      }
    ];
  };
  alertingDir = pkgs.runCommand "grafana-alerting" { } ''
    mkdir -p $out
    cp ${./assets/provisioning/alerting/rules.yaml} $out/rules.yaml
    cp ${./assets/provisioning/alerting/policies.yaml} $out/policies.yaml
    cp ${contactPointsYaml} $out/contact-points.yaml
  '';
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
    "d ${textfileDir} 0755 santiago users -"
  ];

  fleet.statePaths = {
    "${config.fleet.stateRoot}/monitoring/grafana/data" = { };
    "${config.fleet.stateRoot}/monitoring/prometheus/data" = { };
    "/var/lib/node-exporter" = { };
  };

  # 1-min liveness sweep. Runs as santiago so it can talk to the rootless
  # podman socket; writes the .prom file node-exporter serves.
  systemd.services.host-liveness-exporter = {
    description = "Export container_up{name} liveness to node-exporter textfile";
    after = [ "systemd-tmpfiles-setup.service" ];
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
  systemd.timers.host-liveness-exporter = {
    wantedBy = [ "timers.target" ];
    timerConfig = {
      OnBootSec = "1min";
      OnUnitActiveSec = "1min";
    };
  };

  # Grafana's database on the shared app-db cluster (see
  # stacks/app-db/). Dashboards/datasources stay nix-provisioned; the
  # DB holds what the UI created: alert rules, users, service accounts.
  # The narrow replacement for grafana's `X-Frame-Options: deny`.
  #
  # `frame-ancestors` is the modern, per-origin form of the same control,
  # and unlike X-Frame-Options it takes a list — so grafana stays
  # unframable by everything except itself and daedalus, which embeds
  # /d-solo panels on each app's access tab. Browsers that understand CSP
  # ignore X-Frame-Options entirely when frame-ancestors is present, so
  # there is no ordering subtlety between the two.
  #
  # Lives here rather than in the entrypoint-default sec-headers because
  # it grants an exception. Every other app on this box should keep the
  # stricter posture it has by default.
  fleet.traefikRawRules."grafana-embed.yml" = ''
    http:
      middlewares:
        grafana-embed:
          headers:
            contentSecurityPolicy: "frame-ancestors 'self' https://daedalus.toscanini.me"
  '';

  fleet.appDatabases.grafana.consumers = [ "grafana" ];

  fleet.bridgeMemberships = {
    prometheus = [
      "monitoring"
      "traefik"
    ];
    grafana = [
      "monitoring"
      "app-db"
      "traefik"
    ];
    node-exporter = [ ]; # host net — see comment on container below
  };

  fleet.logStacks.monitoring = [
    "prometheus"
    "grafana"
    "node-exporter"
  ];

  # Grafana's Pocket ID client. Declarative: id `grafana`, secret
  # generated on the box, rendered into
  # the container under the two names grafana reads. Prometheus is
  # forward-auth'd, so ITS client is derived from the webApp below.
  fleet.ssoClients.grafana = {
    description = "Dashboards + alerting (prometheus, loki)";
    launchURL = "https://grafana.toscanini.me";
    callbackURLs = [ "https://grafana.toscanini.me/login/generic_oauth" ];
    logoutCallbackURLs = [ "https://grafana.toscanini.me/login/generic_oauth" ];
    consumers = [ "grafana" ];
    consumerEnv = {
      id = "GF_AUTH_GENERIC_OAUTH_CLIENT_ID";
      secret = "GF_AUTH_GENERIC_OAUTH_CLIENT_SECRET";
    };
  };

  fleet.webApps = {
    prometheus = {
      serviceName = "prometheus";
      port = 9090;
      # No auth of its own; grafana + self-scrape dial container-direct
      # and never cross traefik. No host port — traefik (OIDC-gated) is
      # the only path in from outside the bridges.
      auth = "oidc";
      healthPath = "/-/healthy";
    };
    grafana = {
      serviceName = "grafana";
      port = 3000;
      # Replaces the blanket `X-Frame-Options: deny` that
      # GF_SECURITY_ALLOW_EMBEDDING turns off (see the container env).
      extraMiddlewares = [ "grafana-embed@file" ];
    };
  };
  # Consent screen and Pocket ID's My Apps page.
  fleet.ssoClients.prometheus = {
    description = "TSDB — 30d / 100GB retention";
  };

  virtualisation.oci-containers.containers.prometheus = mkRootlessContainer {
    image = "docker.io/prom/prometheus:v3.13.2@sha256:508729e0e2d18e11fd742a5a5ca70e557b940a93948c3c95fd0123a6fd538b69";

    cmd = [
      "--config.file=/etc/prometheus/prometheus.yml"
      "--storage.tsdb.path=/prometheus"
      "--storage.tsdb.retention.time=30d"
      "--storage.tsdb.retention.size=100GB"
      # Accept OTLP metrics pushed by apps that don't expose a /metrics
      # scrape endpoint (open-webui → OpenTelemetry). Ingest path is
      # /api/v1/otlp/v1/metrics on the web port; reachable on traefik-net.
      "--web.enable-otlp-receiver"
    ];

    volumes = [
      "${prometheusDir}:/etc/prometheus:ro"
      "${config.fleet.stateRoot}/monitoring/prometheus/data:/prometheus"
    ];

    extraOptions = [
      # Image's default `nobody` (UID 65534) → host 100533, owner of
      # nothing. Override to UID 0 → host santiago, who owns the data dir.
      "--user=0:0"
      # Prometheus flushes its TSDB head block on SIGTERM, which takes
      # longer than podman's 10s default; the SIGKILL leaves out-of-
      # sequence m-mapped chunks that fail to replay, and the recovery
      # path is to DISCARD every head chunk (silently losing the samples
      # since the last block cut) and rebuild from the WAL alone.
      "--stop-timeout=60"
    ];
  };

  virtualisation.oci-containers.containers.grafana = mkRootlessContainer {
    image = "docker.io/grafana/grafana:13.1.1@sha256:7cb8c64c4d57a57e734073f3cc94620adb24a0acb929bd80ba9f14017e3a975b";
    dependsOn = [ "prometheus" ];

    volumes = [
      "${config.fleet.stateRoot}/monitoring/grafana/data:/var/lib/grafana"
      # Gmail app password for GF_SMTP_PASSWORD__FILE (shared mail secret).
      "${config.sops.secrets."mail-relay-password".path}:/run/secrets/mail-relay-password:ro"
      "${./assets/provisioning/datasources}:/etc/grafana/provisioning/datasources:ro"
      "${./assets/provisioning/dashboards}:/etc/grafana/provisioning/dashboards:ro"
      "${alertingDir}:/etc/grafana/provisioning/alerting:ro"
      "${dashboardsDir}:/var/lib/grafana/dashboards:ro"
    ];

    environment = {
      # Database on the shared app-db cluster; GF_DATABASE_PASSWORD
      # rides the app-db bootstrap env file (environmentFiles below).
      GF_DATABASE_TYPE = "postgres";
      GF_DATABASE_HOST = "pg:5432";
      GF_DATABASE_NAME = "grafana";
      GF_DATABASE_USER = "grafana";
      GF_DATABASE_SSL_MODE = "disable";

      # Grafana preinstalls its own Drilldown apps (Logs/Metrics/Traces/
      # Profiles) into the PERSISTED /var/lib/grafana bind mount, and
      # auto-updates them on startup — but the stock `minor` strategy
      # refuses to cross a major boundary. So the Logs Drilldown app sat
      # at 1.0.37 (built for Grafana 11) while the server moved to 13,
      # and its preloaded module failed at runtime: every Drilldown ->
      # Logs route rendered "App not found", including the deep links
      # from the Janitorr and per-app Logs tiles. `latest` lets the major
      # bump through, which is what keeps plugins in step with a Grafana
      # upgrade. Trade-off: plugin versions track upstream instead of
      # being pinned like the container image.
      GF_PLUGINS_UPDATE_STRATEGY = "latest";
      # `update_strategy` alone is inert: the startup updater is gated on
      # the `pluginsAutoUpdate` feature toggle, which defaults to false.
      GF_FEATURE_TOGGLES_ENABLE = "pluginsAutoUpdate";

      GF_USERS_ALLOW_SIGN_UP = "false";
      GF_SERVER_ROOT_URL = "https://grafana.toscanini.me";
      GF_SERVER_SERVE_FROM_SUB_PATH = "false";

      # Lets daedalus embed panels with /d-solo (stacks/daedalus, the app
      # access tab). Grafana's default is to send `X-Frame-Options: deny`
      # on every response, which is a blanket refusal with no way to name
      # an exception — turning it off is the ONLY way to frame a panel.
      #
      # Off on its own would make grafana framable by any site on the
      # internet, so the narrower policy that replaces it is the
      # `grafana-embed` middleware below: a frame-ancestors CSP naming
      # daedalus and nothing else. The two belong together — do not set
      # this without it.
      GF_SECURITY_ALLOW_EMBEDDING = "true";

      # SMTP alert delivery via the same Gmail relay msmtp uses. Password
      # read from the bind-mounted mail secret through Grafana's __FILE
      # convention (grafana runs --user=0:0 → santiago, which owns it).
      GF_SMTP_ENABLED = "true";
      GF_SMTP_HOST = "${config.fleet.mail.smtpHost}:${toString config.fleet.mail.smtpPort}";
      GF_SMTP_USER = config.fleet.mail.sender;
      GF_SMTP_PASSWORD__FILE = "/run/secrets/mail-relay-password";
      GF_SMTP_FROM_ADDRESS = config.fleet.mail.sender;
      GF_SMTP_FROM_NAME = "s2-server Grafana";
      GF_SMTP_STARTTLS_POLICY = "MandatoryStartTLS";

      # Pocket ID SSO (AUTH.md). Client creds are rendered from the
      # declarative client below, under the two GF_* names grafana
      # reads. Single-user box:
      # every Pocket ID account maps to Grafana Admin. Basic auth stays
      # on — daedalus authenticates with the admin user/pass against the
      # API. Escape hatch: /login?disableAutoLogin.
      GF_AUTH_GENERIC_OAUTH_ENABLED = "true";
      GF_AUTH_GENERIC_OAUTH_NAME = "Pocket ID";
      GF_AUTH_GENERIC_OAUTH_AUTH_URL = "${config.fleet.sso.issuerUrl}/authorize";
      GF_AUTH_GENERIC_OAUTH_TOKEN_URL = "${config.fleet.sso.issuerUrl}/api/oidc/token";
      GF_AUTH_GENERIC_OAUTH_API_URL = "${config.fleet.sso.issuerUrl}/api/oidc/userinfo";
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
    environmentFiles = [
      config.sops.secrets."grafana-env".path
      # GF_DATABASE_PASSWORD (+ POSTGRES_*) from the app-db bootstrap.
      config.fleet.appDatabases.grafana.envFile
    ];

    extraOptions = [
      "--user=0:0"
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

}
