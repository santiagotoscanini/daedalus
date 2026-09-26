# daedalus-nodes — the control plane's side of the machines that run the
# agent: their metrics targets and LAN names, both written by the app under
# the apply bridge at approval time (no rebuild), and the SRV record an agent
# finds this control plane by. Part of the daedalus stack (daedalus.nix holds
# the switch); never imports its siblings.
{
  config,
  lib,
  pkgs,
  ...
}:

let
  inherit (import ./daedalus-lib.nix { inherit config lib pkgs; }) appsOn applyDir;
in

{
  config = lib.mkIf config.fleet.modules.daedalus.enable {
    # The approved nodes as prometheus targets: the control plane writes
    # `nodes/targets.json` under the apply bridge (app/src/host/node-targets.ts)
    # whenever a machine is approved, revoked, forgotten or moves address,
    # and prometheus discovers them from the file — a node joins the fleet's
    # metrics at approval, with no rebuild. The directory is pre-created so
    # the read-only mount has something to bind on a fresh box.
    fleet.statePaths."${applyDir}/nodes" = { };
    fleet.prometheusFileSd.nodes = "${applyDir}/nodes";

    # The nodes' names on the LAN, the same way: the control plane writes
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
        RuntimeDirectory = "daedalus-nodes";
        RuntimeDirectoryPreserve = true;
        RuntimeDirectoryMode = "0755";
      };
      script = ''
        src=${lib.escapeShellArg "${applyDir}/nodes/dhcp-hosts"}
        dst=/run/daedalus-nodes/dhcp-hosts
        if [ -f "$src" ]; then
          install -m 0644 -o root -g root "$src" "$dst.tmp"
          mv -f "$dst.tmp" "$dst"
        else
          rm -f "$dst"
        fi
        ${lib.optionalString config.fleet.modules.pihole.enable ''
          # A HUP is only safe once FTL is up: in its first moments no
          # handler is installed and the signal's default action ends the
          # process — which is how the first activation of this unit took
          # LAN DNS down for four minutes (2026-09-23). A resolver that
          # started less than half a minute ago has read the directory
          # itself, and dnsmasq picks up a NEW file there without any
          # signal; the HUP is for a changed or removed line, and can wait
          # for the next write if it lands in that window.
          if systemctl is-active --quiet pihole-ftl.service; then
            started=$(systemctl show -p ActiveEnterTimestampMonotonic --value pihole-ftl.service)
            # Microseconds since boot, the unit systemd reports. Whole seconds
            # are enough for a thirty-second window, so the fraction is simply
            # dropped: that is right whatever /proc/uptime prints, and it uses
            # only the shell, which awk here did not — it failed the service.
            up=$(cut -d' ' -f1 /proc/uptime)
            now=$(( ''${up%.*} * 1000000 ))
            if [ -n "$started" ] && [ "$(( now - started ))" -gt 30000000 ]; then
              systemctl kill --kill-whom=main -s HUP pihole-ftl.service
            else
              echo "pihole-ftl started under 30 s ago; leaving the HUP to the next write"
            fi
          fi
        ''}
      '';
    };
    fleet.prometheusScrapes = [
      {
        job_name = "nodes";
        file_sd_configs = [
          {
            files = [ "/etc/prometheus-sd/nodes/*.json" ];
            refresh_interval = "1m";
          }
        ];
      }
    ];

    # How the agent on another machine finds this control plane without
    # being told: an SRV record under the LAN's search domain, answered by
    # the resolver this box runs. The target is the control plane's own
    # hostname, which the same resolver answers with the LAN address; 443 is
    # traefik, and /api/nodes/hello is on the auth bypass (daedalus.nix).
    fleet.dnsSrv = lib.mkIf appsOn [
      {
        service = "_daedalus._tcp";
        target = config.fleet.apps.daedalus.hostname;
        port = 443;
      }
    ];
  };
}
