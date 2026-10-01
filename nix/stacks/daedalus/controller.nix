# The controller — the daedalus agent (agent/) on the box itself, in
# `mode = "controller"`: one process as the operator, the door the app talks
# to over a unix socket. It serves that socket, its local socket, the box's
# facts at the `minimal` telemetry level, the metrics page every machine's
# telemetry is scraped from, the listener the other machines' links reach,
# the box's Claude remote control in the configuration checkout, and the
# Claude sessions the app asks it to resume.
#
# agent/README.md "Controller mode" is what the agent does with each of
# these; nix/README.md "The controller" is how this box wires them — ports
# and firewall, the advertised address, config.toml, the unit's environment
# and sandbox. The root helper is root-helper.nix, Claude's logs
# claude-logs.nix; the session host the controller writes the allow-list of
# is session-host.nix.
{
  config,
  lib,
  pkgs,
  ...
}:

let
  inherit (import ./daedalus-lib.nix { inherit config lib pkgs; })
    controllerDir
    controllerDataDir
    claudeUnit
    rootSocket
    ;

  sessionHost = config.fleet.daedalus.sessionHost;

  agent = pkgs.callPackage ../../pkgs/daedalus-agent.nix { };
  inherit (import ../../platform/lib/hardening-lib.nix) hardening;

  # Its state (state.json, identity.key, a rotation's files), its local socket
  # (run/) and logs: the one place the service writes besides its API
  # socket's directory. The session host (session-host.nix, the same uid)
  # reads one file of it: the allow-list the controller keeps there.
  dataDir = controllerDataDir;

  # Where the agent reads config.toml: its Linux default directory.
  configDir = "/var/lib/daedalus-agent";

  port = config.fleet.daedalus.controllerPort;
  # Written into config.toml so the agent and the scrape below agree.
  inherit (config.fleet.daedalus) statusPort;

  configFile = (pkgs.formats.toml { }).generate "daedalus-agent-controller.toml" {
    mode = "controller";
    data_dir = dataDir;
    # The box already has node-exporter and its own snapshots; minimal is the
    # machine and how it is doing, no drives, services or package lists.
    telemetry = "minimal";
    controller = {
      api_socket = "${controllerDir}/api.sock";
      # The app's container runs as the operator (`--user=0:0`, container.nix),
      # whom the socket always serves.
      api_allowed_uids = [ ];
      claude_remote_control = true;
      claude_workdir = config.fleet.config.repo;
      claude_unit = claudeUnit;
      root_socket = rootSocket;
      listen = "0.0.0.0:${toString port}";
      # The metrics page, on the LAN address alone: what the Prometheus
      # container's connections arrive at (pasta's host alias), and the
      # upgrade guard's checks dial.
      metrics_listen = "${config.fleet.lanIp}:${toString statusPort}";
      advertise = [ "${config.fleet.wanHost}:${toString port}" ];
    }
    // lib.optionalAttrs sessionHost.enable {
      # The session host (session-host.nix).
      session_host = {
        address = "${config.fleet.wanHost}:${toString sessionHost.port}";
        allow_list = sessionHost.allowList;
        status_file = sessionHost.statusFile;
        config = sessionHost.configFile;
        inherit (sessionHost) bin;
      };
    };
  };
in
{
  options.fleet.daedalus.statusPort = lib.mkOption {
    type = lib.types.port;
    default = 7787;
    description = ''
      The TCP port of the controller's metrics page (`/healthz`,
      `/nodes/metrics`): bound on `fleet.lanIp` alone, opened on none, and
      scraped by the `nodes` job through the containers' host alias, whose
      connections arrive at that address.
    '';
  };

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
    # which reaches the host over loopback.
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
      "d ${controllerDir} 0700 ${config.fleet.operator.user} ${config.fleet.operator.group} -"
    ];

    fleet.monitoredJobs.daedalus-controller = { };

    # Every machine's metrics, through the controller: one target, each
    # series labelled with its machine.
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
      # pinned one (platform/claude-code); and what a resumed session runs
      # under: util-linux's `script` for the PTY
      # the CLI needs, sed and grep for its log filter; and `nix-store` (the
      # daemon's own nix), which pins each unit's claude.
      path = [
        "/run/wrappers"
        config.systemd.package
        pkgs.procps
        pkgs.coreutils
        pkgs.claude-code
        pkgs.util-linux
        pkgs.gnused
        pkgs.gnugrep
        config.nix.package
      ];
      restartTriggers = [ configFile ];
      serviceConfig = hardening // {
        Type = "simple";
        User = config.fleet.operator.user;
        Group = config.fleet.operator.group;
        WorkingDirectory = dataDir;
        Environment = [
          "HOME=${config.fleet.operator.home}"
          "XDG_RUNTIME_DIR=${config.fleet.operator.runtimeDir}"
        ];
        ExecStart = "${lib.getExe agent} run";
        Restart = "always";
        RestartSec = "5s";
        # Each API connection is a few threads and two descriptors, up to 16 at
        # once; each machine's link a thread and a descriptor, up to 64 admitted
        # and 32 in the handshake; beside telemetry and the session's tools.
        LimitNOFILE = 4096;

        # The root helper is its only way to root (root-helper.nix), so
        # it may not take another: no setuid (sudo is on its PATH for the
        # Claude units, which the USER manager runs — not this process's
        # children, so none of this reaches them). It writes its own state
        # and its socket's directory and nothing else; everything it asks
        # of systemd, logind or the nix daemon goes over a socket, which a
        # read-only filesystem does not stop. What runs under exactly this:
        # `systemctl --user`, `systemd-run --user`,
        # `loginctl`, `nix-store --add-root`, `claude --version`. No
        # MemoryDenyWriteExecute or syscall filter: `claude` (a JIT) runs
        # under it.
        ProtectSystem = "strict";
        ProtectHome = "read-only";
        ReadWritePaths = [
          dataDir
          controllerDir
        ];
        RestrictAddressFamilies = [
          "AF_UNIX"
          "AF_INET"
          "AF_INET6"
          # getifaddrs, for the machine's addresses.
          "AF_NETLINK"
        ];
        RestrictNamespaces = true;
      };
      unitConfig = {
        StartLimitBurst = 20;
        StartLimitIntervalSec = 600;
      };
    };
  };
}
