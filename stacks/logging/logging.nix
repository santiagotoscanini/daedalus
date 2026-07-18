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
    //                  container name itself (see below)
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
        regex         = "^(pihole-(ftl|web)|ddclient|smartd|fail2ban)\\.service$"
        target_label  = "stack"
        replacement   = "infra"
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
    }

    loki.source.journal "system" {
      path          = "/var/log/journal"
      max_age       = "12h"
      forward_to    = [loki.write.default.receiver]
      relabel_rules = loki.relabel.journal.rules
      labels        = {
        job = "systemd-journal",
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
        href = "https://grafana.toscanini.me/a/grafana-lokiexplore-app/explore?from=now-1h&to=now&var-ds=loki-default";
        description = "All services — journald -> Loki (Grafana Drilldown)";
        icon = "loki.png";
        siteMonitor = "http://loki:3100/ready";
      }
    ];

    # Loki has NO traefik route by design: it is unauthenticated, so any
    # route would let every LAN device (and every traefik-net peer) query
    # all logs. Reachable only over monitoring-net — grafana is the UI,
    # alloy pushes to it, homepage's per-app log widget joins
    # monitoring-net to reach it.

    virtualisation.oci-containers.containers.loki = mkRootlessContainer {
      image = "docker.io/grafana/loki:3.7.3@sha256:70b9f699fc9bb868b62f1cfd4f787dfa50242f1fd92e6089787d5d7daea75fe8";

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
      image = "docker.io/grafana/alloy:v1.17.1@sha256:4f6ddc56ffdcf8a6316748fc5162972e20cb301523cac1bb4a31957df733ae9b";
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
