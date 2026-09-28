# The controller — the daedalus agent (agent/) on the box itself, in
# `mode = "controller"`: one process as the operator, the door the app talks to
# over a unix socket (PLAN feature 13). Today it serves that socket, the
# machine's facts at the `minimal` telemetry level, its status page and
# the listener the other machines' links reach (below), and it runs Claude
# remote control in the configuration checkout (below).
#
# Claude remote control:
#
#   parallel       platform/claude-rc.nix still runs the box's first server,
#                  in the same directory. This one is a second, beside it,
#                  under a user-unit name nothing else uses (the system
#                  unit of the same name is the old server's restart verb,
#                  daedalus-verbs.nix: another manager). Two servers in one
#                  directory do not collide: the second finds the first's
#                  bridge pointer (the project's `bridge-pointer.json`, a
#                  live pid in it), registers an environment of its own and
#                  leaves the pointer alone. So each has its own environment
#                  id, the banner's, which is how the Claude app tells them
#                  apart.
#   the unit       `systemd-run --user --unit=daedalus-claude-rc` (agent
#                  src/claude/unit.rs): a transient unit of the operator's
#                  user manager, so a stop or restart of this service leaves
#                  it running and the next start re-attaches. Its output
#                  goes to `<dataDir>/logs/claude-rc.log`, unfiltered.
#   claude         found on this service's PATH: the pinned pkgs.claude-code
#                  (platform/claude-code) is on `path` below, the one
#                  DISABLE_UPDATES wrapper every other `claude` here is.
#   environment    the unit gets the user manager's environment plus, from
#                  the agent, HOME and this service's PATH with
#                  `~/.local/bin` in front — so /run/wrappers/bin (sudo, for
#                  sessions that rebuild) is on it, as on claude-rc.nix's.
#                  Never add DISABLE_TELEMETRY, DO_NOT_TRACK,
#                  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC,
#                  DISABLE_GROWTHBOOK or ANTHROPIC_BASE_URL to either: each
#                  silently disables remote control.
#   gcroot         ExecStartPre pins the claude this start will use, and the
#                  one the unit is already running when that differs — a
#                  switch restarts this service, not the unit, so the unit
#                  can go on running a claude no generation still names.
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
# restarts it, which ends nothing — the app reconnects, and the one long-lived
# child it owns (Claude remote control) runs in a transient user unit of
# its own that outlives it. `Restart=always` because the agent is built with
# `panic = "abort"`.
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
  # store path the agent found on PATH at that start.
  claudeGcroot = pkgs.writeShellScript "daedalus-claude-rc-gcroot" ''
    roots=/nix/var/nix/gcroots
    ${pkgs.coreutils}/bin/ln -sfn ${pkgs.claude-code} "$roots/${claudeUnit}"
    unit=${config.fleet.operator.runtimeDir}/systemd/transient/${claudeUnit}.service
    running=$(${pkgs.gnugrep}/bin/grep -o '^ExecStart=.*' "$unit" 2>/dev/null \
      | ${pkgs.gnugrep}/bin/grep -o '/nix/store/[^/" ]*' | ${pkgs.coreutils}/bin/head -n1 || true)
    if [ -n "$running" ] && [ "$running" != ${pkgs.claude-code} ]; then
      ${pkgs.coreutils}/bin/ln -sfn "$running" "$roots/${claudeUnit}-running"
    else
      ${pkgs.coreutils}/bin/rm -f "$roots/${claudeUnit}-running"
    fi
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
      # Beside platform/claude-rc.nix's server, in the same checkout, under a
      # unit name nothing else uses (the header's `parallel`).
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
      # pinned one (the header's `claude`).
      path = [
        "/run/wrappers"
        config.systemd.package
        pkgs.procps
        pkgs.coreutils
        pkgs.claude-code
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
