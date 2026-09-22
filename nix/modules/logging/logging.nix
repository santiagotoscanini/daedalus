# logging — centralized log aggregation: loki + alloy.
#
# Two containers on monitoring-net (grafana queries loki by name on
# the same bridge it queries prometheus).
#
#   - loki:  log DB. Filesystem store under
#            <stateRoot>/logging/loki/data, 30-day retention
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
# `fleet.logStacks` (declared by the platform, publishing.nix) maps
# stack name -> list of container names; each stack contributes its own
# entry and the entries merge across modules like every fleet option.
# Each entry becomes one relabel rule assigning the `stack` label.
# FALLBACK: any container NOT claimed by an entry gets
# `stack = <its own container name>` — unregistered single-container
# stacks stay usable and nothing lands in a "no stack" bucket. The one
# exception is a container carrying podman's auto-generated
# `adjective_surname` name (an ad-hoc `podman run` with no --name):
# those collapse into `stack = adhoc` rather than each minting a
# phantom service that outlives the container by 30 days.
#
# Why alloy in a container (not as a native NixOS service): keeps the
# "everything in containers + declared in nix" pattern uniform across
# the fleet; the journal-permission gymnastics below are the only cost.
#
# Journal read permissions:
#   - the operator is in the `systemd-journal` group (extraGroups below);
#     NixOS grants that group `rx` ACL on /var/log/journal.
#   - Alloy container: `--user=0:0` (the operator on the host) +
#     `--group-add=keep-groups` to inherit the operator's supplementary
#     groups (notably systemd-journal) inside its userns.
#
# What other stacks contribute, all declared by the platform (publishing.nix):
#   fleet.logStacks.<stack>   container names → the `stack` label
#   fleet.logDrops.<name>     lines to keep out of Loki, with the reason
#   fleet.logFiles.<name>     files outside the journal, with their parse stages
#
# The host brings:
#   fleet.modules.logging.enable   the switch (default off, as every catalog module)
#   fleet.images.loki, .alloy      the digest-pinned images

{
  config,
  lib,
  pkgs,
  mkRootlessContainer,
  pinnedImage,
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

  # Alloy string literals: the values arrive as plain strings and are
  # emitted between double quotes, so quotes and backslashes are escaped
  # once here. A stack writes its regex as it would in any other config.
  alloyString = s: "\"${lib.replaceStrings [ "\\" "\"" ] [ "\\\\" "\\\"" ] s}\"";

  # One stage.match per fleet.logDrops entry, in attr-name order (the
  # entries are independent, so the order only has to be stable).
  mkDropRule =
    _: d:
    "  stage.match {\n"
    + "    selector = ${alloyString d.selector}\n"
    + "    stage.drop {\n"
    + "      expression          = ${alloyString d.expression}\n"
    + "      drop_counter_reason = ${alloyString d.reason}\n"
    + "    }\n"
    + "  }\n";

  dropRules = lib.concatStrings (lib.mapAttrsToList mkDropRule config.fleet.logDrops);

  # One file source per fleet.logFiles entry: the match (labels applied
  # here, because relabel rules on a journal source cannot reach a file
  # one), the source, and the owner's parse stages as its own process
  # block feeding the sink directly — a file's lines are not journal
  # lines, so the journal pipeline's level parse does not apply to them.
  mkFileSource =
    name: f:
    let
      labels = lib.concatStrings (
        lib.mapAttrsToList (k: v: "    ${k} = ${alloyString v},\n") (f.labels // { __path__ = f.path; })
      );
    in
    "local.file_match ${alloyString name} {\n"
    + "  path_targets = [{\n"
    + labels
    + "  }]\n"
    + "}\n\n"
    + "loki.source.file ${alloyString name} {\n"
    + "  targets    = local.file_match.${name}.targets\n"
    + "  forward_to = [loki.process.${name}.receiver]\n"
    + "}\n\n"
    + "loki.process ${alloyString name} {\n"
    + "  forward_to = [loki.write.default.receiver]\n\n"
    # The owner writes its stages at column 0 of a `lines` value; indented
    # here to sit inside the block like everything else in this file.
    + lib.concatMapStrings (l: if l == "" then "\n" else "  ${l}\n") (
      lib.splitString "\n" (lib.removeSuffix "\n" f.stages)
    )
    + "}\n";

  fileSources = lib.concatStringsSep "\n" (lib.mapAttrsToList mkFileSource config.fleet.logFiles);

  alloyConfig = pkgs.writeText "config.alloy" ''
    // Grafana Alloy — single source, single sink. RENDERED FROM NIX
    // (the engine's modules/logging) — do not look for a tracked copy.
    //
    // Source: systemd journal at /var/log/journal (bind-mounted ro).
    // Sink:   Loki at http://loki:3100 (monitoring-net DNS).
    //
    // Relabel rules keep the label set deliberately small to avoid
    // cardinality blow-up:
    //   - unit       → systemd unit (e.g. podman-jellyfin.service)
    //   - container  → podman container name (set by --log-driver=journald)
    //   - host       → hostname
    //   - level      → severity. Journal priority for native services,
    //                  parsed from the line for containers (see the
    //                  level block below — podman's priority is a lie).
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
      // ===== level, for NATIVE services only =====
      // A systemd service that logs through the journal chooses its own
      // priority per line, so the keyword means what it says. A CONTAINER
      // does not: podman's journald driver stamps priority 6 on stdout
      // and priority 3 on stderr unconditionally, so every image that
      // logs to stderr — factorio, seerr, healthchecks, pg — had
      // its entire output labelled `error`. The joined-labels regex fires
      // only when the container name is empty (relabel regexes are fully
      // anchored, so a non-empty name cannot match a pattern starting
      // with the separator). Container lines get their level from
      // loki.process.levels instead.
      rule {
        source_labels = ["__journal_container_name", "__journal_priority_keyword"]
        separator     = ";"
        regex         = ";(.+)"
        target_label  = "level"
        replacement   = "$1"
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
      // ===== fleet.apps scheduled tasks =====
      // A task unit (`app-<name>-task-<id>.service`, the apps stack) is a HOST
      // systemd unit doing a `podman exec`, so its output carries
      // _SYSTEMD_UNIT and NO container name — the two app rules above cannot
      // see it, and it would fall through to the `system` catch-all, landing
      // beside sshd instead of beside the app whose work it is doing.
      //
      // Placed here, after the generated per-stack rules and with the native
      // ones: it reads no container name, so it cannot steal a container line
      // from an explicit fleet.logStacks registration (podman's own unit is
      // `podman-app-<name>.service`, which this regex does not match), and it
      // is early enough that the fallbacks below still see `stack` filled.
      //
      // The `-task-` infix is what separates these from `app-<name>-deploy`
      // and `app-<name>-secrets-bootstrap`, which stay in `system`: those are
      // the platform acting ON an app, while a task is the app's own code.
      rule {
        source_labels = ["__journal__systemd_unit"]
        regex         = "^app-(.+)-task-.+\\.service$"
        target_label  = "stack"
        replacement   = "apps"
      }
      rule {
        source_labels = ["__journal__systemd_unit"]
        regex         = "^app-(.+)-task-.+\\.service$"
        target_label  = "service_name"
        replacement   = "$1"
      }

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

      // ===== throwaway containers =====
      // An ad-hoc `podman run` with no --name gets an auto-generated
      // `adjective_surname`, and the fallback below would promote each
      // one to its own stack — so a week of one-off `recyclarr sync`
      // runs and debugging shells becomes dozens of phantom services in
      // Grafana's Logs Drilldown, each alive for the full 30-day
      // retention. They collapse into one `adhoc` bucket instead.
      //
      // The underscore IS the discriminator: podman's generator always
      // produces exactly `[a-z]+_[a-z]+` (plus a digit on collision),
      // and every declared container on this box is [a-z0-9-]. Both
      // rules read `stack` while it is still empty, so an explicit
      // fleet.logStacks registration always wins; service_name is set
      // first because the second rule is what fills `stack` in.
      //
      // service_name is set explicitly because Loki otherwise derives it
      // from the container name — leaving Drilldown's *service* list
      // just as polluted as the stack list. `container` is deliberately
      // kept, so an individual throwaway run is still traceable.
      rule {
        source_labels = ["stack", "__journal_container_name"]
        separator     = ";"
        regex         = ";[a-z]+_[a-z]+[0-9]*"
        target_label  = "service_name"
        replacement   = "adhoc"
      }
      rule {
        source_labels = ["stack", "__journal_container_name"]
        separator     = ";"
        regex         = ";[a-z]+_[a-z]+[0-9]*"
        target_label  = "stack"
        replacement   = "adhoc"
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
      //
      // Matches ANY unit suffix, not just `.service`: sudo invocations
      // and login sessions are logged against `session-N.scope` and
      // `init.scope`, and restricting this to `.service` dropped them
      // into the "no stack" bucket this rule exists to prevent — which
      // silently hid the sudo audit trail from every stack-grouped view.
      // Lines with no unit at all are already claimed by the kernel rule
      // above, so `(.+)` cannot steal them.
      rule {
        source_labels = ["stack", "__journal__systemd_unit"]
        separator     = ";"
        regex         = ";(.+)"
        target_label  = "stack"
        replacement   = "system"
      }
    }

    // ===== credentials in URLs =====
    // The first stage every journal line meets, so nothing downstream (and
    // nothing in Loki) ever holds these values.
    //
    // OAuth puts one-time credentials in query strings, and two emitters
    // log query strings verbatim: traefik's JSON access log (`RequestPath`)
    // and pocket-id's request log (`query="…"`). So every forward-auth
    // callback's `code` and `state` sat in Loki for its 30-day retention.
    // The one that matters most is the daedalus GitHub App's manifest
    // callback: a `code` the engine never exchanged — a creation that failed
    // half way — can be traded at POST /app-manifests/{code}/conversions,
    // with no authentication, for the App's private key.
    //
    // Not only OAuth: sonarr and radarr log their failed Prowlarr calls with
    // `&apikey=` in the URL, and that key was reaching Loki too.
    //
    // The regex is shaped by what the lines actually look like:
    //   - traefik's JSON encoder writes `&` as the six characters
    //     backslash-u-0-0-2-6, so a separator of `[?&]` alone matches only
    //     the first parameter and misses every `state` that is not first;
    //   - pocket-id prints the query without its `?`, right after `query="`;
    //   - a callback URL carried inside another one (`rd=`, `next=`) is
    //     percent-encoded: `%3F`/`%26` before the name, `%3D` for its `=`;
    //   - HTML-escaped links separate parameters with `&amp;`;
    //   - `#` covers implicit-flow fragments pasted into a logged URL.
    // Names match case-insensitively (`?Code=`), and only by exact name
    // after one of those separators — `code_challenge`, `token_type` and
    // logfmt's ` state=running` / ` code=200` are untouched.
    //
    // Only the VALUE is captured, and stage.replace substitutes captures,
    // not the whole match: the name stays, so `?code=REDACTED` is still
    // readable. A value runs until `&`, `"`, whitespace or the escaped-`&`
    // sequence, and straight THROUGH any other JSON escape — a backslash
    // pair, or backslash-u with any other four hex digits — so a value
    // holding an escaped backslash or `<` cannot end the redaction early.
    // It never consumes a `"`, not even an escaped one, so a JSON line stays
    // valid JSON. A percent-encoded inner URL is redacted to its end: the
    // value does not stop at `%26`, because a password may contain one.
    //
    // The second stage takes the GitHub manifest code out of the conversion
    // URL, where it is a path segment rather than a parameter.
    //
    // Every journal stream, not just traefik's: pocket-id,
    // claude-remote-control and the *arrs log matching URLs too, and the
    // next app that logs a callback should not need an entry here.
    //
    // What this does NOT reach: the journal itself (/var/log/journal,
    // persistent, 2G / one month) keeps the raw lines, and lines already in
    // Loki keep theirs until retention ages them out.
    loki.process "redact" {
      forward_to = [loki.process.drop_noise.receiver]

      stage.replace {
        expression = "(?i)(?:[?&#]|\\\\u0026|&amp;|query=\"|%3F|%26)(?:code|state|id_token_hint|id_token|access_token|refresh_token|token|apikey|api_key|client_secret|password|passwd|secret)(?:=|%3D)((?:[^&\"\\s\\\\]|\\\\[^\"u\\s&]|\\\\u(?:[1-9a-f][0-9a-f]{3}|0[1-9a-f][0-9a-f]{2}|00[013-9a-f][0-9a-f]|002[0-57-9a-f]))*)"
        replace    = "REDACTED"
      }

      stage.replace {
        expression = "/app-manifests/([^/?&\"\\s\\\\]+)"
        replace    = "REDACTED"
      }
    }

    // ===== noise drop =====
    // Lines a stack has asked to keep out of Loki (fleet.logDrops — each
    // entry is the owning stack's, with its reason there). Dropped here,
    // after relabel so the labels a selector names are set, and before the
    // level parse. Journald still retains everything (it rotates); this only
    // spares Loki and keeps real logs legible. Each rule increments
    // loki_process_dropped_lines_total{reason=...} so the drops stay
    // observable.
    loki.process "drop_noise" {
      forward_to = [loki.process.levels.receiver]
    ${dropRules}
    }

    // ===== level, for CONTAINER lines =====
    // Podman's journald log driver decides priority from the file
    // DESCRIPTOR, not from the line: stdout is 6, stderr is 3, always. A
    // dozen images here log everything to stderr, so the priority-derived
    // label declared their entire output `error` — an "errors in the last
    // hour" count that was really a "wrote to fd 2" count, and a log panel
    // that was solid red while nothing was wrong.
    //
    // So the level is read out of the line instead, where the program
    // actually stated it. The first severity word in the opening ~120
    // characters wins, which is where every convention on this box puts it
    // — `level=warn` (logfmt), `"level":"debug"` (json), `INFO` at column
    // zero, and factorio's `Server: 0.966 Info File.cpp:245:`. It must be
    // a whole word bounded by punctuation or space, so `error` inside
    // `error_reporting` or a path does not count.
    //
    // A line stating no severity is `unknown`, NOT `info`: this pipeline
    // does not get to invent a claim the program declined to make. Loki's
    // own discover_log_levels reaches the same answers, but only for
    // streams carrying no level label at all — it trusts ours when we set
    // one, which is exactly how a wrong label survived to the panel.
    loki.process "levels" {
      forward_to = [loki.write.default.receiver]

      stage.match {
        selector = "{container=~\".+\"}"

        // The floor. Whatever the relabel step believed is discarded here
        // before anything is parsed, so an unmatched line cannot inherit
        // the stderr verdict.
        stage.static_labels {
          values = {
            level = "unknown",
          }
        }

        stage.regex {
          expression = "(?i)^.{0,120}?(?:^|[\\s\\[\\(\"'|=:,])(?P<lvl>emergency|emerg|alert|critical|crit|fatal|error|err|warning|warn|notice|info|debug|trace)(?:[\\s\\]\\)\"':|,.-]|$)"
        }

        // One template rather than a chain: lowercase, fold the synonyms
        // onto the journald keywords the dashboards already query
        // (error/warning/crit/emerg), and turn a miss into `unknown` —
        // the stage runs even when the regex captured nothing, and an
        // empty label would sort as neither present nor absent.
        stage.template {
          source   = "lvl"
          template = "{{ $l := ToLower .Value }}{{ if eq $l \"\" }}unknown{{ else if or (eq $l \"err\") (eq $l \"error\") }}error{{ else if or (eq $l \"warn\") (eq $l \"warning\") }}warning{{ else if or (eq $l \"fatal\") (eq $l \"critical\") (eq $l \"crit\") }}crit{{ else if or (eq $l \"emerg\") (eq $l \"emergency\") }}emerg{{ else if eq $l \"trace\" }}debug{{ else }}{{ $l }}{{ end }}"
        }

        stage.labels {
          values = {
            level = "lvl",
          }
        }
      }
    }

    loki.source.journal "system" {
      path          = "/var/log/journal"
      max_age       = "12h"
      forward_to    = [loki.process.redact.receiver]
      relabel_rules = loki.relabel.journal.rules
      labels        = {
        job = "systemd-journal",
      }
    }

    // ===== services that do not use the journal =====
    // One file source per fleet.logFiles entry (the owning stack's, with
    // its labels and its parse stages there). Exact paths, never globs: a
    // directory that holds a chatty neighbour or rotated copies would be
    // swallowed whole. The owner also names the directory to mount (a
    // DIRECTORY, not the file — a rotated file's inode would stay pinned).
    ${fileSources}
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
  options.fleet.modules.logging.enable = lib.mkOption {
    type = lib.types.bool;
    default = false;
    description = "Centralized logs: Loki plus the alloy shipper.";
  };

  config = lib.mkIf config.fleet.modules.logging.enable {
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
    # last (alphabetical stack order) — silent surprise; refuse instead. A
    # file source's name becomes an alloy component label, so it is held to
    # that grammar before it can break the whole config.
    assertions =
      let
        all = lib.concatLists (lib.attrValues logStacks);
        dups = lib.unique (lib.filter (n: lib.count (m: m == n) all > 1) all);
        badNames = lib.filter (n: builtins.match "[a-z_][a-z0-9_]*" n == null) (
          lib.attrNames config.fleet.logFiles
        );
      in
      [
        {
          assertion = dups == [ ];
          message = "fleet.logStacks: container(s) listed under more than one stack: ${lib.concatStringsSep ", " dups}";
        }
        {
          assertion = badNames == [ ];
          message = "fleet.logFiles: name(s) ${lib.concatStringsSep ", " badNames} are not alloy component labels ([a-z_][a-z0-9_]*).";
        }
      ];

    fleet.statePaths = {
      "${config.fleet.stateRoot}/logging/alloy/data" = { };
      "${config.fleet.stateRoot}/logging/loki/data" = { };
    };

    # Loki has NO traefik route by design: it is unauthenticated, so any
    # route would let every LAN device (and every traefik-net peer) query
    # all logs. Reachable only over monitoring-net — grafana is the UI,
    # alloy pushes to it, and daedalus joins that bridge to query it.

    virtualisation.oci-containers.containers.loki = mkRootlessContainer {
      image = pinnedImage "loki" "docker.io/grafana/loki";

      cmd = [ "-config.file=/etc/loki/loki.yaml" ];

      volumes = [
        "${./assets/loki.yaml}:/etc/loki/loki.yaml:ro"
        "${config.fleet.stateRoot}/logging/loki/data:/loki"
      ];

      extraOptions = [
        "--user=0:0" # → the operator on the host, who owns the data dir
      ];
    };

    virtualisation.oci-containers.containers.alloy = mkRootlessContainer {
      image = pinnedImage "alloy" "docker.io/grafana/alloy";
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
        "${config.fleet.stateRoot}/logging/alloy/data:/var/lib/alloy/data"
      ]
      # The files outside the journal (fleet.logFiles): each owner names the
      # DIRECTORY to mount — a rotated file's inode would stay pinned by a
      # single-file bind, and alloy would go on reading the old copy. What
      # keeps a chatty neighbour in the same directory out is the exact path
      # in the file match and the file's own permissions, not this mount.
      ++ lib.unique (map (l: "${l.mountDir}:${l.mountDir}:ro") (lib.attrValues config.fleet.logFiles));

      extraOptions = [
        "--user=0:0"
        "--group-add=keep-groups" # inherit systemd-journal in userns
      ];
    };

    # Required for `--group-add=keep-groups` to grant journal access.
    users.users.${config.fleet.operator.user}.extraGroups = [ "systemd-journal" ];
  };
}
