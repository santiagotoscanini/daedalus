# logging — centralized log aggregation: loki + alloy.
#
# Two containers on monitoring-net (grafana queries loki by name on
# the same bridge it queries prometheus).
#
#   - loki:  log DB. Filesystem store under
#            /home/santiago/selfhost/logging/loki/data, 30-day retention
#            (matches prometheus). Reachable ONLY over monitoring-net —
#            no traefik route by design (see the bridgeMemberships
#            comment below); grafana is the query UI.
#
#   - alloy: log collector. Reads the host's systemd journal — the ONE
#            source (every rootless-podman unit's stdout/stderr lands
#            there via --log-driver=journald, plus pi-hole/ddclient/
#            smartd/fail2ban). Forwards to loki with labels
#            {unit, container, host, level, stack}. Add `loki.source.file`
#            to the rendered config below if a specific service stops
#            journald.
#
# The alloy config is nix-rendered (pkgs.writeText) and bind-mounted
# from /nix/store — changing it changes the store hash, so the
# container restarts on rebuild (same pattern as monitoring's
# prometheus.yml). No hand-maintained config file.
#
# `fleet.logStacks` (declared here — logging owns the consumer) maps
# stack name -> list of container names; each stack contributes its own
# entry and the entries merge across modules like every fleet option.
# Each entry becomes one relabel rule assigning the `stack` label.
# FALLBACK: any container NOT claimed by an entry gets
# `stack = <its own container name>` — unregistered single-container
# stacks stay usable and nothing lands in a "no stack" bucket.
#
# Why alloy in a container (not as a native NixOS service): keeps the
# "everything in containers + declared in nix" pattern uniform across
# the fleet; the journal-permission gymnastics below are the only cost.
#
# Journal read permissions:
#   - santiago is in the `systemd-journal` group (extraGroups below);
#     NixOS grants that group `rx` ACL on /var/log/journal.
#   - Alloy container: `--user=0:0` (host santiago) +
#     `--group-add=keep-groups` to inherit santiago's supplementary
#     groups (notably systemd-journal) inside its userns.

{
  config,
  lib,
  pkgs,
  mkRootlessContainer,
  ...
}:

let
  logStacks = lib.filterAttrs (_: names: names != [ ]) config.fleet.logStacks;

  # Container names are [a-z0-9-] so escaping is a no-op today; keep it
  # anyway so an exotic name can't corrupt the generated regex. Regex
  # backslashes must be doubled inside the alloy string literal.
  escapeName = name: lib.replaceStrings [ "\\" ] [ "\\\\" ] (lib.escapeRegex name);

  # One relabel rule per stack: container name in the stack's list ->
  # stack = <stack name>. Plain-string concat (not an indented string)
  # so the rendered file keeps the 2-space indent of the hand-written
  # rules around it.
  mkStackRule =
    stack: names:
    "  rule {\n"
    + "    source_labels = [\"__journal_container_name\"]\n"
    + "    regex         = \"^(${lib.concatStringsSep "|" (map escapeName (lib.naturalSort (lib.unique names)))})$\"\n"
    + "    target_label  = \"stack\"\n"
    + "    replacement   = \"${stack}\"\n"
    + "  }\n";

  stackRules = lib.concatStrings (lib.mapAttrsToList mkStackRule logStacks);

  alloyConfig = pkgs.writeText "config.alloy" ''
    // Grafana Alloy — single source, single sink. RENDERED FROM NIX
    // (stacks/logging/logging.nix) — do not look for a tracked copy.
    //
    // Source: systemd journal at /var/log/journal (bind-mounted ro).
    // Sink:   Loki at http://loki:3100 (monitoring-net DNS).
    //
    // Relabel rules keep the label set deliberately small to avoid
    // cardinality blow-up:
    //   - unit       → systemd unit (e.g. podman-jellyfin.service)
    //   - container  → podman container name (set by --log-driver=journald)
    //   - host       → hostname
    //   - level      → priority keyword (info|warning|err|...)
    //   - stack      → from fleet.logStacks; falls back to the
    //                  container name itself (see below). Kernel lines
    //                  have no unit or container, so they get
    //                  stack=kernel.
    //
    // Everything else stays in the log line (queryable via LogQL line
    // filters), not as labels.

    logging {
      level  = "warn"
      format = "logfmt"
    }

    loki.write "default" {
      endpoint {
        url = "http://loki:3100/loki/api/v1/push"
      }
    }

    loki.relabel "journal" {
      forward_to = []

      rule {
        source_labels = ["__journal__systemd_unit"]
        target_label  = "unit"
      }
      rule {
        source_labels = ["__journal__hostname"]
        target_label  = "host"
      }
      rule {
        source_labels = ["__journal_container_name"]
        target_label  = "container"
      }
      rule {
        source_labels = ["__journal_priority_keyword"]
        target_label  = "level"
      }

      // ===== stack label =====
      // Derive a stack label from the container name (or systemd unit
      // for native NixOS services) so the Drilldown UI and LogQL queries
      // can group logs by stack instead of by container. Cardinality
      // stays the same because stack is fully determined by container —
      // not an independent dimension.
      //
      // Rule precedence = order: later rules overwrite `stack`. The
      // apps-platform pattern comes first, then the per-stack rules
      // generated from fleet.logStacks (explicit registration wins),
      // then the fallback (only fires while `stack` is still empty).

      // ===== fleet.apps platform =====
      // app-<name> containers land in stack=apps with
      // service_name = <name>, so Grafana Drilldown groups per app.
      // (Their DBs live on the shared pg cluster; those logs are under
      // stack=app-db, not per-app.)
      rule {
        source_labels = ["__journal_container_name"]
        regex         = "^app-(.+)$"
        target_label  = "stack"
        replacement   = "apps"
      }
      rule {
        source_labels = ["__journal_container_name"]
        regex         = "^app-(.+)$"
        target_label  = "service_name"
        replacement   = "$1"
      }

      // ===== per-stack rules (generated from fleet.logStacks) =====
    ${stackRules}
      // Native NixOS services (no container) — match on unit. Everything
      // the header promises as a journald source gets a stack label so
      // Drilldown's stack grouping covers them.
      rule {
        source_labels = ["__journal__systemd_unit"]
        regex         = "^(pihole-(ftl|ready)|ddclient|smartd|fail2ban)\\.service$"
        target_label  = "stack"
        replacement   = "infra"
      }

      // ===== kernel transport =====
      // Kernel lines carry neither _SYSTEMD_UNIT nor a container name,
      // so neither fallback below can claim them — without this rule
      // they reach Loki with no stack label at all, and the header's
      // promise that every line carries one would be false.
      rule {
        source_labels = ["stack", "__journal__transport"]
        separator     = ";"
        regex         = ";kernel"
        target_label  = "stack"
        replacement   = "kernel"
      }

      // Fallback: any container not claimed above gets stack = its own
      // container name, so unregistered single-container stacks never
      // land in a "no stack" bucket. Anchored regex: it only matches
      // when `stack` is still empty (a non-empty stack means the
      // joined value no longer starts with ";").
      rule {
        source_labels = ["stack", "__journal_container_name"]
        separator     = ";"
        regex         = ";(.+)"
        target_label  = "stack"
        replacement   = "$1"
      }

      // Final catch-all: native units not claimed above (syncoid,
      // app-*-deploy, sshd, timers, ...) land in stack="system" so
      // every journald line carries a stack label.
      rule {
        source_labels = ["stack", "__journal__systemd_unit"]
        separator     = ";"
        regex         = ";(.+)\\.service"
        target_label  = "stack"
        replacement   = "system"
      }
    }

    // ===== noise drop =====
    // Two third-party emitters flood high-volume noise that cannot be
    // silenced at the source; drop it here (after relabel, so the
    // container label is set) before it reaches Loki. Journald still
    // retains everything (it rotates) — this only spares Loki and keeps
    // real logs legible. Each rule increments
    // loki_process_dropped_lines_total{reason=...} so the drops stay
    // observable.
    //
    //   - scraparr: wsgiref writes a "GET /metrics ... 200" access line
    //     per prometheus scrape straight to stderr, bypassing its Python
    //     logger (GENERAL_LOG_LEVEL can't reach it — see the scraparr
    //     module header).
    //   - seerr: an *arr call over the pasta -> gluetun-published-port
    //     path intermittently stalls to a 10s axios timeout that seerr
    //     surfaces as an UNHANDLED rejection; Node then dumps the whole
    //     ~150-line error object to stderr per failure. Every dump line
    //     is indented; real seerr logs start at column 0 (ISO
    //     timestamp), so dropping indented lines removes the flood and
    //     leaves the col-0 "unhandledRejection" header as a marker.
    loki.process "drop_noise" {
      forward_to = [loki.write.default.receiver]

      stage.match {
        selector = "{container=\"scraparr\"}"
        stage.drop {
          expression          = "GET /metrics HTTP"
          drop_counter_reason = "scraparr_metrics_access"
        }
      }

      stage.match {
        selector = "{container=\"seerr\"}"
        stage.drop {
          expression          = "^\\s+"
          drop_counter_reason = "seerr_unhandled_dump"
        }
      }
    }

    loki.source.journal "system" {
      path          = "/var/log/journal"
      max_age       = "12h"
      forward_to    = [loki.process.drop_noise.receiver]
      relabel_rules = loki.relabel.journal.rules
      labels        = {
        job = "systemd-journal",
      }
    }

    // ===== OTLP metrics =====
    // Apps that PUSH OpenTelemetry (no /metrics scrape endpoint) send
    // OTLP/gRPC here; alloy re-exports over OTLP/HTTP to prometheus's
    // native receiver (--web.enable-otlp-receiver), which promotes
    // service.name → the service_name label. Current pusher: open-webui
    // (its exporter is gRPC-only, and prometheus's OTLP ingest is
    // HTTP-only — alloy bridges the two). Reach it as alloy:4317 from
    // monitoring-net.
    otelcol.receiver.otlp "metrics" {
      grpc {
        endpoint = "0.0.0.0:4317"
      }
      output {
        metrics = [otelcol.exporter.otlphttp.prometheus.input]
      }
    }

    otelcol.exporter.otlphttp "prometheus" {
      client {
        endpoint = "http://prometheus:9090/api/v1/otlp"
        tls {
          insecure = true
        }
      }
    }
  '';
in
{
  options.fleet.logStacks = lib.mkOption {
    type = lib.types.attrsOf (lib.types.listOf lib.types.str);
    default = { };
    description = ''
      Map: stack name -> container names whose logs get
      `stack = <name>` in Loki. Rendered into alloy's relabel rules by
      stacks/logging. Each stack contributes its own entry; lists merge
      across modules like every fleet option.

      Containers covered by no entry fall back to
      `stack = <container name>` (still queryable, just ungrouped), so
      registration is optional for single-container stacks and only
      adds grouping for multi-container ones.
    '';
    example = lib.literalExpression ''
      {
        tv = [ "gluetun" "qbittorrent" "sonarr" "radarr" ];
      }
    '';
  };

  config = {
    fleet.bridgeMemberships = {
      loki = [ "monitoring" ];
      alloy = [ "monitoring" ];
    };

    fleet.logStacks.logging = [
      "loki"
      "alloy"
    ];

    # The log pipeline is the one subsystem whose failure mode is
    # silence, and a healthy alloy logs nothing at all — so "no output"
    # is indistinguishable from "stopped shipping" without these.
    # Prometheus reaches both by container DNS on monitoring-net; neither
    # publishes a host port or a traefik route by design.
    fleet.prometheusScrapes = [
      {
        job_name = "alloy";
        static_configs = [ { targets = [ "alloy:12345" ]; } ];
      }
      {
        job_name = "loki";
        static_configs = [ { targets = [ "loki:3100" ]; } ];
      }
    ];

    # A container claimed by two stacks would get whichever rule renders
    # last (alphabetical stack order) — silent surprise; refuse instead.
    assertions =
      let
        all = lib.concatLists (lib.attrValues logStacks);
        dups = lib.unique (lib.filter (n: lib.count (m: m == n) all > 1) all);
      in
      [
        {
          assertion = dups == [ ];
          message = "fleet.logStacks: container(s) listed under more than one stack: ${lib.concatStringsSep ", " dups}";
        }
      ];

    fleet.statePaths = {
      "/home/santiago/selfhost/logging/alloy/data" = { };
      "/home/santiago/selfhost/logging/loki/data" = { };
    };

    # Box-wide log browser (Grafana Drilldown -> Loki). The per-app
    # Logs tiles (apps.nix) deep-link filtered views of the same data.
    fleet.homepageServices."Monitoring" = [
      {
        name = "Logs";
        weight = 20;
        href = "https://grafana.toscanini.me/a/grafana-lokiexplore-app/explore?from=now-1h&to=now&var-ds=loki-default";
        description = "All services — journald -> Loki";
        icon = "loki.png";
        siteMonitor = "http://loki:3100/ready";
        # Fleet-wide log volume by severity, off alloy's `level` label.
        # One query returns all three as a vector so this stays a single
        # row; the `k` labels are prefixed 1/2/3 because Loki sorts
        # vector results by label and the mappings index positionally.
        widget = {
          type = "customapi";
          url = "http://loki:3100/loki/api/v1/query?query=label_replace%28sum%28count_over_time%28%7Blevel%3D%7E%22.%2B%22%7D%5B1h%5D%29%29%20or%20vector%280%29%2C%20%22k%22%2C%20%221lines%22%2C%20%22%22%2C%20%22%22%29%20or%20label_replace%28sum%28count_over_time%28%7Blevel%3D%22warning%22%7D%5B1h%5D%29%29%20or%20vector%280%29%2C%20%22k%22%2C%20%222warn%22%2C%20%22%22%2C%20%22%22%29%20or%20label_replace%28sum%28count_over_time%28%7Blevel%3D%22error%22%7D%5B1h%5D%29%29%20or%20vector%280%29%2C%20%22k%22%2C%20%223err%22%2C%20%22%22%2C%20%22%22%29";
          refreshInterval = 60000;
          mappings = [
            {
              field = "data.result.0.value.1";
              label = "Lines 1h";
              format = "number";
            }
            {
              field = "data.result.1.value.1";
              label = "Warn 1h";
              format = "number";
            }
            {
              field = "data.result.2.value.1";
              label = "Errors 1h";
              format = "number";
            }
          ];
        };
      }
    ];

    # Loki has NO traefik route by design: it is unauthenticated, so any
    # route would let every LAN device (and every traefik-net peer) query
    # all logs. Reachable only over monitoring-net — grafana is the UI,
    # alloy pushes to it, homepage's per-app log widget joins
    # monitoring-net to reach it.

    virtualisation.oci-containers.containers.loki = mkRootlessContainer {
      image = "docker.io/grafana/loki:3.7.4@sha256:87f0a067673756a3cede1bcbf0c74875f7df9b09fddb53e399d0c576f756cfcc";

      cmd = [ "-config.file=/etc/loki/loki.yaml" ];

      volumes = [
        "${./assets/loki.yaml}:/etc/loki/loki.yaml:ro"
        "/home/santiago/selfhost/logging/loki/data:/loki"
      ];

      extraOptions = [
        "--user=0:0" # → host santiago, owns the data dir
      ];
    };

    virtualisation.oci-containers.containers.alloy = mkRootlessContainer {
      image = "docker.io/grafana/alloy:v1.18.0@sha256:491b0578c04983fd54fe99b587b6fab4404dc46d0dc16677bd6b00cc1140b308";
      dependsOn = [ "loki" ];

      cmd = [
        "run"
        "--server.http.listen-addr=0.0.0.0:12345"
        "--storage.path=/var/lib/alloy/data"
        "/etc/alloy/config.alloy"
      ];

      volumes = [
        # Nix-rendered (see `alloyConfig` above); store-hash change on
        # rebuild restarts the container — no manual reload.
        "${alloyConfig}:/etc/alloy/config.alloy:ro"
        # Persistent + volatile (early-boot) journal paths.
        "/var/log/journal:/var/log/journal:ro"
        "/run/log/journal:/run/log/journal:ro"
        "/etc/machine-id:/etc/machine-id:ro"
        "/home/santiago/selfhost/logging/alloy/data:/var/lib/alloy/data"
      ];

      extraOptions = [
        "--user=0:0"
        "--group-add=keep-groups" # inherit systemd-journal in userns
      ];
    };

    # Required for `--group-add=keep-groups` to grant journal access.
    users.users.santiago.extraGroups = [ "systemd-journal" ];
  };
}
