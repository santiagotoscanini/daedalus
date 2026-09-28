# daedalus-nodes — the control plane's side of the machines that run the
# agent: their LAN names, written by the app under the apply bridge from what
# the controller reports (no rebuild). Their metrics are the controller's
# (controller.nix scrapes its /nodes/metrics). Part of the daedalus stack
# (daedalus.nix holds the switch); never imports its siblings.
{
  config,
  lib,
  pkgs,
  ...
}:

let
  inherit (import ./daedalus-lib.nix { inherit config lib pkgs; })
    applyDir
    mkAgent
    operatorVars
    ;

  # Root, and reading a file the container writes: host/nodes-dhcp.sh reads it
  # through host/lib.sh's read_request (no link, the read as the operator) and
  # validates every line before root writes a byte.
  agent = mkAgent {
    name = "daedalus-nodes-dhcp";
    runtimeInputs = [
      pkgs.coreutils
      pkgs.gnugrep
      pkgs.util-linux # setpriv
      pkgs.systemd
    ];
    vars = operatorVars // {
      SRC = "${applyDir}/nodes/dhcp-hosts";
      DST = "/run/daedalus-nodes/dhcp-hosts";
      PIHOLE = if config.fleet.modules.pihole.enable then "1" else "0";
    };
    files = [
      ./host/lib.sh
      ./host/nodes-dhcp.sh
    ];
  };
in

{
  config = lib.mkIf config.fleet.modules.daedalus.enable {
    # Where the app writes the file below, pre-created so the path unit
    # watches a directory that exists on a fresh box.
    fleet.statePaths."${applyDir}/nodes" = { };

    # The nodes' names on the LAN: the control plane writes
    # `nodes/dhcp-hosts` — one dnsmasq `dhcp-host` line per approved node,
    # `<MAC>,<name>` — and this unit copies it where the resolver reads it
    # (`dhcp-hostsdir=/run/daedalus-nodes`, modules/pihole) and sends FTL a
    # HUP, which is what `pihole reloaddns` sends: dnsmasq re-reads its hosts
    # and dhcp-hosts files and renames the leases, without a restart and
    # without a gap in DNS. A directory rather than the file itself because
    # dnsmasq picks a NEW file in a hostsdir up on its own and needs the
    # signal only for a changed one; the copy exists so the resolver's user
    # never reads the operator's tree. Runtime rather than nix on purpose: a
    # MAC address is not for git (the household's reservations are sops for
    # the same reason), and a machine joining must not cost a rebuild. A MAC
    # the household file already names is the app's job to leave out, since
    # dnsmasq would see the same address twice.
    systemd.paths.daedalus-nodes-dhcp = {
      description = "Watch the nodes' DHCP name bindings from daedalus";
      wantedBy = [ "multi-user.target" ];
      # PathChanged only: PathExists would restart a oneshot every time it
      # finished with the file still there. Boot is covered by the service's
      # own wantedBy below.
      pathConfig.PathChanged = "${applyDir}/nodes/dhcp-hosts";
    };
    systemd.services.daedalus-nodes-dhcp = {
      description = "Hand the nodes' DHCP name bindings to the resolver";
      # Once at boot too, after the resolver, so a file written before the
      # reboot is in place when the first lease asks — the path unit alone
      # fires only on a change.
      wantedBy = [ "multi-user.target" ];
      after = lib.optional config.fleet.modules.pihole.enable "pihole-ftl.service";
      unitConfig.ConditionPathExists = "${applyDir}/nodes/dhcp-hosts";
      serviceConfig = {
        Type = "oneshot";
        ExecStart = "${agent}/bin/daedalus-nodes-dhcp";
        RuntimeDirectory = "daedalus-nodes";
        RuntimeDirectoryPreserve = true;
        RuntimeDirectoryMode = "0755";
        # It writes only its RuntimeDirectory; the read runs as the operator.
        ProtectSystem = "strict";
        ProtectHome = "read-only";
        PrivateTmp = true;
        NoNewPrivileges = true;
      };
    };
  };
}
