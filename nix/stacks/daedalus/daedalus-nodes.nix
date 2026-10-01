# daedalus-nodes — the control plane's side of the machines that run the
# agent: their LAN names, handed to the resolver by the root helper's
# `nodes-dhcp` from what the controller reports (no rebuild). Their metrics
# are the controller's (controller.nix scrapes its /nodes/metrics). Part of
# the daedalus stack (daedalus.nix holds the switch); never imports its
# siblings.
{
  config,
  lib,
  pkgs,
  ...
}:

let
  inherit (import ./daedalus-lib.nix { inherit config lib pkgs; })
    verbsDir
    mkAgent
    mkRootVerb
    operatorVars
    ;

  # The resolver's directory: pi-hole reads it as `dhcp-hostsdir`
  # (modules/pihole).
  runDir = "/run/daedalus-nodes";

  # Root, and writing what the container chose: host/nodes-dhcp.sh validates
  # every line before root writes a byte.
  agent = mkAgent {
    name = "daedalus-nodes-dhcp";
    runtimeInputs = [
      pkgs.coreutils
      pkgs.gnugrep
      pkgs.jq
      pkgs.util-linux # logger
      pkgs.systemd
    ];
    vars = operatorVars // {
      STORE = "${verbsDir}/nodes-dhcp-hosts";
      DST = "${runDir}/dhcp-hosts";
      PIHOLE = if config.fleet.modules.pihole.enable then "1" else "0";
    };
    files = [
      ./host/lib.sh
      ./host/nodes-dhcp.sh
    ];
  };

  # What both of its units may touch: the kept copy and the resolver's.
  sandbox = {
    ProtectSystem = "strict";
    ProtectHome = true;
    ReadWritePaths = [
      verbsDir
      runDir
    ];
    PrivateTmp = true;
    NoNewPrivileges = true;
  };
in

{
  config = lib.mkIf config.fleet.modules.daedalus.enable (
    lib.mkMerge [
      {
        systemd.tmpfiles.rules = [ "d ${runDir} 0755 root root -" ];

        # Once at boot, after the resolver, so the lines the last run kept are
        # in place when the first lease asks: the kept copy (in verbsDir, which
        # outlives a reboot) into the resolver's directory, which does not.
        systemd.services.daedalus-nodes-dhcp = {
          description = "Hand the nodes' kept DHCP name bindings to the resolver";
          wantedBy = [ "multi-user.target" ];
          after = lib.optional config.fleet.modules.pihole.enable "pihole-ftl.service";
          unitConfig.ConditionPathExists = "${verbsDir}/nodes-dhcp-hosts";
          serviceConfig = sandbox // {
            Type = "oneshot";
            ExecStart = lib.getExe agent;
          };
        };
      }

      # The nodes' names on the LAN: the control plane hands the root helper's
      # `nodes-dhcp` one dnsmasq `dhcp-host` line per approved node,
      # `<MAC>[,<IPv4>],<name>`, and the unit keeps them and copies them where
      # the resolver reads them (`dhcp-hostsdir`, modules/pihole), then sends
      # FTL a HUP, which is what `pihole reloaddns` sends: dnsmasq re-reads its
      # hosts and dhcp-hosts files and renames the leases, without a restart
      # and without a gap in DNS. A directory rather than the file itself
      # because dnsmasq picks a NEW file in a hostsdir up on its own and needs
      # the signal only for a changed one. Runtime rather than nix on purpose:
      # a MAC address is not for git (the household's reservations are sops for
      # the same reason), and a machine joining must not cost a rebuild. A MAC
      # the household file already names is the app's job to leave out, since
      # dnsmasq would see the same address twice. A refusal (a line of another
      # shape) is shown nowhere but the app's log, so it does not mail either.
      (mkRootVerb {
        verb = "nodes-dhcp";
        unit = "daedalus-nodes-dhcp";
        description = "Hand the nodes' DHCP name bindings to the resolver";
        verbDescription = "Set the approved nodes' DHCP name bindings on the resolver";
        script = agent;
        timeoutStartSec = 60;
        # At most 1024 lines of a MAC, an address and a DNS label.
        payloadMax = 131072;
        monitored = false;
        unitAttrs.after = lib.optional config.fleet.modules.pihole.enable "pihole-ftl.service";
        serviceConfig = sandbox;
      })
    ]
  );
}
