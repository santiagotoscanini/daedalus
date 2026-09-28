# The controller — the daedalus agent (agent/) on the box itself, in
# `mode = "controller"`: one process as the operator, the door the app talks to
# over a unix socket (PLAN feature 13). Today it serves that socket, the
# machine's facts at the `minimal` telemetry level, its status page and
# the listener the other machines' links reach (below), the box's Claude
# remote control in the configuration checkout, and the Claude sessions the
# app asks it to resume (below).
#
# Claude remote control:
#
#   one server     the box's only one: a second `claude remote-control` in
#                  the same directory cannot run — registration answers 409,
#                  "This folder is already served by a terminal `claude
#                  remote-control` on this device", keyed on the machine and
#                  the directory (measured 2026-09-28, claude-code 2.1.281),
#                  and the refused server exits about a minute later. Never
#                  start another one in the checkout beside it.
#   the unit       `systemd-run --user --unit=daedalus-claude-rc` (agent
#                  src/claude/unit.rs): a transient unit of the operator's
#                  user manager, so a stop or restart of this service leaves
#                  it running and the next start re-attaches. Its output
#                  goes to `<dataDir>/logs/claude-rc.log`, unfiltered, rotated
#                  only when the server next starts; Loki gets it filtered
#                  (`logs`, below).
#   claude         found on this service's PATH: the pinned pkgs.claude-code
#                  (platform/claude-code) is on `path` below, the one
#                  DISABLE_UPDATES wrapper every other `claude` here is.
#   environment    the unit gets the user manager's environment plus, from
#                  the agent, HOME and this service's PATH with
#                  `~/.local/bin` in front — so /run/wrappers/bin (sudo, for
#                  sessions that rebuild) is on it.
#                  Never add DISABLE_TELEMETRY, DO_NOT_TRACK,
#                  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC,
#                  DISABLE_GROWTHBOOK or ANTHROPIC_BASE_URL to either: each
#                  silently disables remote control.
#   sessions       a session resumed from the app (agent
#                  src/claude/sessions.rs) is another transient user unit,
#                  `claude-session-<uuid>`, running the same claude under
#                  `script` (a PTY) piped through `sed` and `grep` (the log
#                  filter), all found on this service's PATH. Its output
#                  goes to `<dataDir>/logs/claude-session-<uuid>.log`.
#   gcroot         ExecStartPre pins the claude this start will use, the one
#                  the Remote Control unit is already running when that
#                  differs, and the one each running `claude-session-*` unit
#                  runs — a switch restarts this service, not those units,
#                  so they can go on running a claude no generation still
#                  names. A session link whose unit is gone is removed.
#   logs           `fleet.logFiles.claude_rc` (below) ships claude-rc.log to
#                  Loki as `unit="daedalus-claude-rc.service"`, with the
#                  rules the old journal pipeline had: ANSI stripped; the
#                  status box's repaint dropped (it redraws about once a
#                  second even when idle, ~400k lines a day measured) — the
#                  box frames, the indented session rows and the banner
#                  hints; and every line carrying `tool_result` dropped: with
#                  `--verbose` each session's transcript is in this output,
#                  and those lines hold what a tool RETURNED, secrets a
#                  session read included (~1,600 a day). The full
#                  transcripts are in ~/.claude/projects; Loki loses nothing
#                  it should keep. The page's Connection board reads the
#                  `[HH:MM:SS]` event lines from here.
#                  `fleet.logFiles.claude_session` ships every
#                  `claude-session-*.log` (not their rotated `.log.1`) as
#                  `unit="claude-session"`, one `filename` label per session,
#                  through the same stages.
#
# The status page, and the machines' metrics:
#
#   bind           `0.0.0.0:<statusPort>` (7787), every interface: the
#                  prometheus container reaches the host through pasta's
#                  host alias, and its connections arrive at the host's
#                  own address, not loopback. Other addresses than
#                  loopback get `/healthz` and `/nodes/metrics` alone.
#   firewall       CLOSED: the port is in no allowedTCPPorts, so the LAN
#                  never reaches it; the container's connections are the
#                  host talking to itself and pass.
#   scrape         the `nodes` job: `host.containers.internal:<statusPort>`
#                  at `/nodes/metrics`, every connected machine's telemetry
#                  in one target, each series labelled `node` (its id),
#                  `host`, `os` and `machine` (the name the app hands over
#                  in `nodes.set_desired`). `up` there is the controller;
#                  each machine is `daedalus_agent_link_up` (the Machine
#                  Link Down alert, modules/monitoring). The box itself is
#                  not in it: node-exporter covers the box.
#
# The machines' link (agent/README.md, "The link to the controller"):
#
#   listen         `0.0.0.0:<fleet.daedalus.controllerPort>` (7788 unless the
#                  host says otherwise): TLS 1.3, each end pinning the other's
#                  ed25519 key, no CA and no web server between.
#   firewall       the port is open on `fleet.lanInterface` ONLY — the link
#                  is for machines on the network, and the router forwards
#                  nothing to it.
#   tunnel         a WireGuard peer reaches it at the LAN address too: the
#                  tunnel ends in wg-easy's own netns, where the LAN address
#                  is the netns itself, so the port is handed to
#                  `fleet.modules.wg-easy.tunnelHostPorts` and DNATed on to
#                  the host (read only while that module is on). The peer
#                  resolves the name below through the tunnel's DNS, which
#                  is the LAN resolver.
#   advertise      `<fleet.wanHost>:<port>`, what the app hands a machine to
#                  dial. The public name, because the LAN resolver answers it
#                  with the LAN address (platform/ddclient puts it in
#                  fleet.dnsHosts, and modules/pihole makes it local-only, so
#                  A only, no AAAA to race). `<hostName>.<lanDomain>` is NOT
#                  that: the resolver answers its own host's name itself, and
#                  not with the LAN address (measured: 0.0.0.0 and ::1), and
#                  the name exists only where the host's reservations carry
#                  it. Off the LAN and off the tunnel the public name
#                  resolves to the WAN address, where nothing is forwarded
#                  to this port, so such a machine fails closed.
#   SRV            `_daedalus-controller._tcp.<lanDomain>` → the same name
#                  and port, through fleet.dnsSrv: how an agent installed
#                  without `--controller` finds the listener. modules/pihole
#                  renders each entry as a `srv-host=` line in pihole.toml,
#                  so ADDING or changing one restarts the resolver at the
#                  switch (a few seconds without LAN DNS) — this list is not
#                  a runtime file. A record is only a first use for the
#                  machine: anyone who answers DNS on the LAN could redirect
#                  it, which is why the key is pinned, not the address.
#   identity.key   the controller's key, made on its first start in
#                  `data_dir` (0600): what every machine pins. `data_dir` is
#                  under fleet.stateRoot, which a host snapshots and
#                  replicates with the rest of its container state (the
#                  reference host: its frequent/hourly/daily snapshots and
#                  the nightly mirror of that dataset) — so a restore brings
#                  the same key back and no machine sees "controller key
#                  changed". A lost key is exactly that: every machine refuses
#                  the new one until it is re-pinned. `system.info` states its
#                  fingerprint (`controller.fingerprint`).
#
#   What the app does with it: puts `controller.{advertise,public_key}` from
#   system.info in its install lines (`--controller`, `--pin`); pushes its
#   COMPLETE set of decided keys (`nodes.set_desired`: approved/revoked, each
#   with its policy) on connect and on every decision, since the controller
#   keeps nothing across a restart; reads machines through `nodes.*` and
#   sends commands with `nodes.command`.
#
# What nix hands it:
#
#   the binary     built from the crate's own files only (Cargo.toml,
#                  Cargo.lock, build.rs, src/), so a commit that touches
#                  anything else in the repository does not rebuild it. No
#                  tray (`--no-default-features`), only `daedalus-agent`.
#   config.toml    generated below. The agent reads it from a FIXED place —
#                  `/var/lib/daedalus-agent/config.toml`, the Linux default
#                  directory (agent/src/config.rs); it takes no path on its
#                  command line, and `DAEDALUS_AGENT_DATA_DIR` is a development
#                  knob. So tmpfiles links that path to the store file (root's
#                  directory: the operator's process cannot rewrite its own
#                  policy), `data_dir` in it moves state and logs under
#                  stateRoot, and a shell's `daedalus-agent status` reads the
#                  same file the service does. The unit restarts when the file
#                  changes (restartTriggers: its own text would not).
#   the socket     `<controllerDir>/api.sock`, in a directory tmpfiles makes
#                  the operator's before any unit starts, so the app's bind
#                  source always exists. The agent refuses a directory that is
#                  a symlink, not its user's, or group/other-writable; it
#                  changes none it did not make. 0700 in dev mode — the dev
#                  container runs `--user=0:0`, the operator on the host, whom
#                  the socket always serves. The published image runs as
#                  `node` (container uid 1000 → a subuid on the host): that uid
#                  goes in `api_allowed_uids`, the agent then makes the socket
#                  0666 and lets the peer check (SO_PEERCRED) be the gate, and
#                  the directory needs 0711 so that uid can reach it.
#
# restartIfChanged stays at its default: a switch that moves the agent
# restarts it, which ends nothing — the app reconnects, and the long-lived
# children it starts (Claude remote control, resumed sessions) each run in a
# transient user unit of their own that outlives it. `Restart=always`
# because the agent is built with `panic = "abort"`.
{
  config,
  lib,
  pkgs,
  hostUid,
  ...
}:

let
  inherit (import ./daedalus-lib.nix { inherit config lib pkgs; }) controllerDir;

  daedalusDev = config.fleet.daedalus.dev;

  # The crate, by its own files only (see the header).
  crate = ../../../agent;
  cargoToml = builtins.fromTOML (builtins.readFile (crate + "/Cargo.toml"));

  # The tests run in the crate's own gate (agent/gate.sh) and in CI; building
  # the box's binary does not run them again.
  agent = pkgs.rustPlatform.buildRustPackage {
    pname = "daedalus-agent";
    inherit (cargoToml.package) version;
    src = lib.fileset.toSource {
      root = crate;
      fileset = lib.fileset.unions [
        (crate + "/Cargo.toml")
        (crate + "/Cargo.lock")
        (crate + "/build.rs")
        (crate + "/src")
      ];
    };
    cargoLock.lockFile = crate + "/Cargo.lock";
    buildNoDefaultFeatures = true;
    cargoBuildFlags = [
      "--bin"
      "daedalus-agent"
    ];
    doCheck = false;
    meta.mainProgram = "daedalus-agent";
  };

  # Its state (state.json) and logs. Beside the control plane's other host-side
  # state (apply/, prev/), and only the operator's: nothing else reads it.
  dataDir = "${config.fleet.stateRoot}/apps/daedalus/controller";
  # The agent's logs, Claude remote control's among them (the header's `logs`).
  logDir = "${dataDir}/logs";

  # Where the agent reads config.toml: its Linux default directory.
  configDir = "/var/lib/daedalus-agent";

  # The machines' link: every address, the LAN interface's firewall alone
  # admitting it (see the header).
  port = config.fleet.daedalus.controllerPort;

  # The status page: every interface, the firewall keeping it from the LAN
  # (see the header). Written into config.toml so the agent and the scrape
  # below agree.
  statusPort = 7787;

  # The published image's `node` user, as the host sees it. Dev mode runs the
  # container as the operator, who needs no listing.
  allowedUids = lib.optional (!daedalusDev) (hostUid 1000);

  # Claude remote control's transient user unit (the header's `the unit`).
  claudeUnit = "daedalus-claude-rc";

  # The header's `gcroot`. Run as root ("+"): the roots directory is root's.
  # The running claude is read from the transient unit's file, which the
  # user manager keeps while the unit is loaded; its ExecStart names the
  # store path the agent found on PATH at that start. A session unit's
  # ExecStart opens with `sh` and `script`, so its claude is matched by name,
  # not taken as the first store path.
  claudeGcroot = pkgs.writeShellScript "daedalus-claude-rc-gcroot" ''
    roots=/nix/var/nix/gcroots
    transient=${config.fleet.operator.runtimeDir}/systemd/transient
    grep=${pkgs.gnugrep}/bin/grep
    ln=${pkgs.coreutils}/bin/ln
    rm=${pkgs.coreutils}/bin/rm
    head=${pkgs.coreutils}/bin/head
    $ln -sfn ${pkgs.claude-code} "$roots/${claudeUnit}"
    running=$($grep -o '^ExecStart=.*' "$transient/${claudeUnit}.service" 2>/dev/null \
      | $grep -o '/nix/store/[^/" ]*' | $head -n1 || true)
    if [ -n "$running" ] && [ "$running" != ${pkgs.claude-code} ]; then
      $ln -sfn "$running" "$roots/${claudeUnit}-running"
    else
      $rm -f "$roots/${claudeUnit}-running"
    fi
    for link in "$roots"/claude-session-*; do
      if [ -L "$link" ] && [ ! -e "$transient/''${link##*/}.service" ]; then
        $rm -f "$link"
      fi
    done
    for unit in "$transient"/claude-session-*.service; do
      [ -e "$unit" ] || continue
      name=''${unit##*/}
      cli=$($grep '^ExecStart=' "$unit" \
        | $grep -o '/nix/store/[0-9a-z]\{32\}-claude-code-[^/"\\ ]*' | $head -n1 || true)
      if [ -n "$cli" ]; then
        $ln -sfn "$cli" "$roots/''${name%.service}"
      fi
    done
  '';

  # What both Claude log sources (below) do on the way to Loki (the header's
  # `logs`). The status-box expression is the grep the server's journal
  # filter ran before it moved here. A file source skips the journal
  # pipeline, so its "credentials in URLs" redaction (modules/logging) is
  # repeated here, verbatim: a session's output can carry an OAuth callback
  # or a manifest code as well as any journal line can.
  claudeStages = ''
    stage.replace {
      expression = "(\\x1b\\[[0-9;?]*[A-Za-z]|\\x1b\\]8;;[^\\x07]*\\x07)"
      replace    = ""
    }

    stage.replace {
      expression = "(?i)(?:[?&#]|\\\\u0026|&amp;|query=\"|%3F|%26)(?:code|state|id_token_hint|id_token|access_token|refresh_token|token|apikey|api_key|client_secret|password|passwd|secret)(?:=|%3D)((?:[^&\"\\s\\\\]|\\\\[^\"u\\s&]|\\\\u(?:[1-9a-f][0-9a-f]{3}|0[1-9a-f][0-9a-f]{2}|00[013-9a-f][0-9a-f]|002[0-57-9a-f]))*)"
      replace    = "REDACTED"
    }

    stage.replace {
      expression = "/app-manifests/([^/?&\"\\s\\\\]+)"
      replace    = "REDACTED"
    }

    stage.drop {
      expression          = "^·|^[[:space:]]|^$|Continue coding in the Claude|space to show QR code"
      drop_counter_reason = "claude_rc_status_box"
    }

    stage.drop {
      expression          = "tool_result"
      drop_counter_reason = "claude_rc_tool_output"
    }
  '';

  configFile = (pkgs.formats.toml { }).generate "daedalus-agent-controller.toml" {
    mode = "controller";
    data_dir = dataDir;
    # The box already has node-exporter and its own snapshots; minimal is the
    # machine and how it is doing, no drives, services or package lists.
    telemetry = "minimal";
    port = statusPort;
    controller = {
      api_socket = "${controllerDir}/api.sock";
      api_allowed_uids = allowedUids;
      claude_remote_control = true;
      claude_workdir = config.fleet.config.repo;
      claude_unit = claudeUnit;
      listen = "0.0.0.0:${toString port}";
      advertise = [ "${config.fleet.wanHost}:${toString port}" ];
    };
  };
in
{
  options.fleet.daedalus.controllerPort = lib.mkOption {
    type = lib.types.port;
    default = 7788;
    description = ''
      The TCP port the controller accepts the other machines' links on
      (TLS, key-pinned). Opened on the LAN interface only, published to the
      LAN as the `_daedalus-controller._tcp` SRV record, and what the app
      tells machines to dial.
    '';
  };

  config = lib.mkIf config.fleet.modules.daedalus.enable {
    fleet.statePaths.${dataDir}.mode = "0700";
    # Made by the agent too, but the log shipper bind-mounts it, so it must
    # exist before the shipper's container starts.
    fleet.statePaths.${logDir}.mode = "0755";

    # Claude remote control's output, filtered on the way to Loki (the
    # header's `logs`).
    fleet.logFiles.claude_rc = {
      path = "${logDir}/claude-rc.log";
      mountDir = logDir;
      # Where the journal put the old unit's lines: `system` is the stack
      # every host unit without a rule of its own gets.
      labels = {
        unit = "${claudeUnit}.service";
        stack = "system";
        host = config.networking.hostName;
        job = claudeUnit;
        service_name = claudeUnit;
      };
      stages = claudeStages;
    };

    # The resumed sessions' output (the header's `sessions` and `logs`): one
    # source for the family. The pattern ends in `.log`, so a session's
    # rotated `.log.1` is not matched; alloy adds a `filename` label per file.
    fleet.logFiles.claude_session = {
      path = "${logDir}/claude-session-*.log";
      mountDir = logDir;
      labels = {
        unit = "claude-session";
        stack = "system";
        host = config.networking.hostName;
        job = "claude-session";
        service_name = "claude-session";
      };
      stages = claudeStages;
    };

    # LAN only: never `allowedTCPPorts`, which would open it on every
    # interface. The tunnel's peers arrive through wg-easy's DNAT instead,
    # which reaches the host over loopback (the header's `tunnel`).
    networking.firewall.interfaces.${config.fleet.lanInterface}.allowedTCPPorts = [ port ];
    fleet.modules.wg-easy.tunnelHostPorts = [ { inherit port; } ];

    fleet.dnsSrv = [
      {
        service = "_daedalus-controller._tcp";
        target = config.fleet.wanHost;
        inherit port;
      }
    ];

    systemd.tmpfiles.rules = [
      "d ${configDir} 0755 root root -"
      "L+ ${configDir}/config.toml - - - - ${configFile}"
      "d ${controllerDir} ${
        if allowedUids == [ ] then "0700" else "0711"
      } ${config.fleet.operator.user} ${config.fleet.operator.group} -"
    ];

    fleet.monitoredJobs.daedalus-controller = { };

    # Every machine's metrics, through the controller (the header's `scrape`).
    # The job keeps the name the per-machine targets had, so a query by
    # `job="nodes"` still finds them.
    fleet.prometheusScrapes = [
      {
        job_name = "nodes";
        metrics_path = "/nodes/metrics";
        static_configs = [ { targets = [ "host.containers.internal:${toString statusPort}" ]; } ];
      }
    ];

    systemd.services.daedalus-controller = {
      description = "Daedalus controller: the agent on the box, the app's local API";
      wantedBy = [ "multi-user.target" ];
      after = [
        "network-online.target"
        "state-paths.service"
        config.fleet.operator.userService
      ];
      wants = [
        "network-online.target"
        "state-paths.service"
        config.fleet.operator.userService
      ];
      # systemctl / systemd-run / loginctl for its user units, ps for the
      # process count; /run/wrappers as on every operator-run unit (and on
      # the Claude unit's PATH, which is this one's); claude itself, the
      # pinned one (the header's `claude`); and what a resumed session runs
      # under (the header's `sessions`): util-linux's `script` for the PTY
      # the CLI needs, sed and grep for its log filter.
      path = [
        "/run/wrappers"
        config.systemd.package
        pkgs.procps
        pkgs.coreutils
        pkgs.claude-code
        pkgs.util-linux
        pkgs.gnused
        pkgs.gnugrep
      ];
      restartTriggers = [ configFile ];
      serviceConfig = {
        Type = "simple";
        User = config.fleet.operator.user;
        Group = config.fleet.operator.group;
        WorkingDirectory = dataDir;
        Environment = [
          "HOME=${config.fleet.operator.home}"
          "XDG_RUNTIME_DIR=${config.fleet.operator.runtimeDir}"
        ];
        ExecStartPre = "+${claudeGcroot}";
        ExecStart = "${lib.getExe agent} run";
        Restart = "always";
        RestartSec = "5s";
        # Each API connection is a few threads and two descriptors, up to 16 at
        # once; each machine's link a thread and a descriptor, up to 64 admitted
        # and 32 in the handshake; beside telemetry and the session's tools.
        LimitNOFILE = 4096;
      };
      unitConfig = {
        StartLimitBurst = 20;
        StartLimitIntervalSec = 600;
      };
    };
  };
}
