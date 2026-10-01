# The session host — santree's remote projects, served on the box (the crate
# in session-host/, its README the contract). santree on a machine talks to
# the daedalus agent there; the agent opens a pinned TLS 1.3 connection with
# its NODE key to this host and pipes santree's protocol v1 through it. Here
# that protocol runs: PTYs that outlive the link and re-attach through their
# replay ring, argv exec, file read / write / stat, a queue of agent hook
# events, and the workspaces snapshot. Primitives only; santree keeps the
# logic.
#
#   who          the approved nodes whose policy turns santree on — the
#                controller writes their keys to `allowList` (in its own
#                data dir), and this host admits exactly those keys at the
#                TLS handshake. It polls the file every second: a node that
#                leaves it loses its connections AND the PTYs it opened
#                within about a second. A missing or untrustworthy file admits
#                nobody. An admitted node is a login as the operator — who
#                has NOPASSWD sudo — so root on the box (ARCHITECTURE.md,
#                trust boundaries).
#   listen       `0.0.0.0:<port>` (7789 unless the host says otherwise),
#                opened on `fleet.lanInterface` ONLY and handed to
#                `fleet.modules.wg-easy.tunnelHostPorts`, exactly as the
#                controller's link is (nix/README.md
#                "The controller"): LAN or the system VPN, and the
#                router forwards nothing to it. Tunnel peers and containers
#                arrive over loopback, which has a pre-auth pool of its own
#                (the crate's README, "The link").
#   host.key     made by the host on its first start, in `stateDir` (0600),
#                beside `status.json`; under fleet.stateRoot, so a restore
#                brings the same key back and no node has to re-pin.
#   status.json  what the controller reads (`statusFile`): state, version,
#                the running build (`exe`) and config (`config`), the host
#                key, connections by node id, live PTYs, the allow-list in
#                force. Rewritten at least every 10 s; the last one says
#                `stopped`.
#   hooks        agents on the box run `<hookBin> hook <event>`, which pushes
#                to `/run/daedalus-session-host/hook.sock` (the unit's
#                RuntimeDirectory, 0700; the socket 0600 and served to this
#                uid alone). The package is on the system PATH so `hookBin`
#                outlives any one build.
#   icons        `workspaces.icon` reads `<workspaceIconsDir>/<name>.icon`, which
#                the app exports (the Apps page's icon for the workspace's
#                repo; daedalus-lib.nix). The app writes, this host reads;
#                nothing is stored.
#
# restartIfChanged = false is load-bearing: every live terminal and agent is
# a child of this unit, so a restart kills them all. A switch installs the new
# build and config and leaves the running host alone; the controller compares
# `exe` and `config` in the status file with the installed `bin` and
# `configFile` (a new port, root or path is a new store path) and the app
# offers the restart, which is the root verb `session-host-restart` (below).
# The unit's environment (PATH, LANG) is not compared: a change there alone
# waits for the next restart.
#
# The unit is the operator's shell, not a sandboxed daemon: its PTYs and
# `exec.run` `git push`, build and `sudo nixos-rebuild`, so there is no
# ProtectSystem, NoNewPrivileges or private /tmp, and the environment is the
# operator's login one (profile PATH with /run/wrappers first, HOME, SHELL,
# LANG) with the login umask, 0022 — files made in a terminal here come out as
# they would over ssh. What guards it is the pinned TLS, the allow-list and a
# LAN/VPN-only port.
#
# The host brings:
#   fleet.daedalus.sessionHost.enable   the switch (default off)
#   the agent CLIs (claude, codex, …) on the operator's profile PATH
{
  config,
  lib,
  pkgs,
  utils,
  ...
}:

let
  cfg = config.fleet.daedalus.sessionHost;
  op = config.fleet.operator;
  inherit (import ./daedalus-lib.nix { inherit config lib pkgs; })
    controllerDataDir
    workspaceIconsDir
    workspaceRoot
    workspacesDir
    ;

  package = pkgs.callPackage ../../pkgs/session-host.nix { };

  stateDir = "${config.fleet.stateRoot}/apps/daedalus/session-host";
  runtimeName = "daedalus-session-host";
  hookBin = "/run/current-system/sw/bin/daedalus-session-host";

  # The app writes each workspace's icon here (app/src/host/workspace-icons.ts,
  # through its /workspace-icons mount, container.nix); this host only reads it
  # (`workspaces.icon`).
  workspaceIcons = workspaceIconsDir;

  configFile = pkgs.writeText "daedalus-session-host.json" (
    builtins.toJSON {
      listen = [ "0.0.0.0:${toString cfg.port}" ];
      inherit stateDir hookBin;
      inherit (cfg) allowList;
      hookSocket = "/run/${runtimeName}/hook.sock";
      projectsRoot = workspaceRoot;
      workspaces = "${workspacesDir}/workspaces.json";
      inherit workspaceIcons;
    }
  );
in
{
  options.fleet.daedalus.sessionHost = {
    enable = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = ''
        The session host: santree's protocol v1 over pinned TLS, for the
        approved nodes whose policy turns santree on. An admitted node is a
        shell as the operator.
      '';
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 7789;
      description = ''
        The TCP port the session host accepts nodes on (TLS, key-pinned).
        Opened on the LAN interface only, and reachable through the system
        VPN's tunnel.
      '';
    };

    allowList = lib.mkOption {
      type = lib.types.str;
      readOnly = true;
      default = "${controllerDataDir}/session-host-allow.json";
      defaultText = lib.literalExpression ''"''${fleet.stateRoot}/apps/daedalus/controller/session-host-allow.json"'';
      description = ''
        Read-only: the file the controller writes and the session host
        reads — `{"schemaVersion": 1, "nodes": [{"id", "publicKey"}]}`, the
        keys it admits (session-host/README.md, "The allow-list").
      '';
    };

    statusFile = lib.mkOption {
      type = lib.types.str;
      readOnly = true;
      default = "${stateDir}/status.json";
      defaultText = lib.literalExpression ''"''${fleet.stateRoot}/apps/daedalus/session-host/status.json"'';
      description = ''
        Read-only: the session host's status, for the controller to read
        (session-host/README.md, "The status file").
      '';
    };

    bin = lib.mkOption {
      type = lib.types.str;
      readOnly = true;
      default = lib.getExe package;
      defaultText = lib.literalMD "the session host package's `bin/daedalus-session-host`";
      description = ''
        Read-only: the installed build, as the running host names itself in
        its status file (`exe`, `/proc/self/exe`). The controller compares
        the two: different means a restart would apply an update.
      '';
    };

    configFile = lib.mkOption {
      type = lib.types.str;
      readOnly = true;
      default = "${configFile}";
      defaultText = lib.literalMD "the generated `daedalus-session-host.json` in the store";
      description = ''
        Read-only: the installed `--config` file, as the running host names
        it in its status file (`config`). The controller compares the two,
        as it does `bin`: a changed port or path is a new store path, and a
        restart applies it.
      '';
    };
  };

  config = lib.mkIf (config.fleet.modules.daedalus.enable && cfg.enable) {
    # On PATH at a path that outlives any one build: `hookBin`.
    environment.systemPackages = [ package ];

    systemd.tmpfiles.rules = [ "d ${stateDir} 0700 ${op.user} ${op.group} -" ];
    # LAN only, and through the tunnel: the controller's own pattern
    # (controller.nix).
    networking.firewall.interfaces.${config.fleet.lanInterface}.allowedTCPPorts = [ cfg.port ];

    # The app names this port in a logged-in Mac's tunnel firewall.
    fleet.dashboard.session-host.env.SESSION_HOST_PORT = toString cfg.port;
    fleet.modules.wg-easy.tunnelHostPorts = [ { inherit (cfg) port; } ];

    fleet.monitoredJobs.daedalus-session-host = { };

    systemd.services.daedalus-session-host = {
      description = "Daedalus session host: santree's terminals, exec and files for approved machines";
      wantedBy = [ "multi-user.target" ];
      after = [ "network.target" ];
      restartIfChanged = false;
      # The operator's PATH, as an ssh login gets it (wrappers first, for sudo).
      path = [
        "/run/wrappers"
        "/etc/profiles/per-user/${op.user}"
        "/run/current-system/sw"
      ];
      environment = {
        HOME = op.home;
        USER = op.user;
        LOGNAME = op.user;
        # An empty `pty.open` command starts this, as a login shell.
        SHELL = utils.toShellPath config.users.users.${op.user}.shell;
        LANG = config.i18n.defaultLocale;
        XDG_RUNTIME_DIR = op.runtimeDir;
      };
      unitConfig.RequiresMountsFor = [
        stateDir
        workspaceRoot
      ];
      serviceConfig = {
        Type = "simple";
        User = op.user;
        Group = op.group;
        WorkingDirectory = op.home;
        UMask = "0022";
        RuntimeDirectory = runtimeName;
        RuntimeDirectoryMode = "0700";
        ExecStart = "${lib.getExe package} serve --config ${cfg.configFile}";
        Restart = "always";
        RestartSec = "2s";
        # 64 PTYs (a few descriptors each), the nodes' connections, and what
        # the terminals' own children open.
        LimitNOFILE = 8192;
      };
    };

    # The app's Restart button (through the controller's root helper): the
    # only way a new build takes over, and it ends every live terminal — the
    # app says how many before it asks.
    systemd.services.daedalus-session-host-restart = {
      description = "Restart the session host on daedalus's behalf";
      serviceConfig = {
        Type = "oneshot";
        ExecStart = "${config.systemd.package}/bin/systemctl restart daedalus-session-host.service";
        # The host closes its PTYs on SIGTERM in about two seconds at most.
        TimeoutStartSec = "2min";
      };
    };
    fleet.daedalus.rootVerbs.session-host-restart = {
      unit = "daedalus-session-host-restart.service";
      description = "Restart the session host (ends its terminals)";
      timeoutSec = 150;
    };
  };
}
