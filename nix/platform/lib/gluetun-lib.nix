# gluetun-lib — shared plumbing for the box's gluetun (VPN netns owner)
# instances, as a PLAIN LIBRARY (`*-lib.nix` files are never listed in
# configuration.nix's imports; consumers import this by path).
#
# Why not a module exporting _module.args: the consumers build their
# whole `config` with `lib.mkMerge [ (mkGluetunInstance {...}) {...} ]`,
# and forcing a custom module arg inside a top-level mkMerge recurses
# through the `_module.args` option evaluation. A by-path import has no
# such round-trip.
#
# Two instances live today, deliberately separate tunnels: stacks/downloads
# (torrent + book-downloader egress, with ProtonVPN port forwarding) and
# stacks/argus-vpn (scanner egress). One WireGuard key cannot run two live
# sessions, and their traffic must not mix.
#
# Host-port convention: the TV instance owns host 8000 (control API) +
# 8001 (exporter); each further instance publishes the same in-netns
# ports at +2 (argus: 8002/8003; a third takes 8004/8005).
#
# Usage (in a stack module):
#   inherit (import (enginePath + "/platform/lib/gluetun-lib.nix") {
#     inherit config lib pkgs mkRootlessContainer;
#   }) mkGluetunInstance;
#   ...
#   config = lib.mkMerge [ (mkGluetunInstance { ... }) { ... } ];

let
  # pasta's host alias, as seen from inside a rootless network namespace.
  # `host.containers.internal` resolves to this. Stated once here because
  # both the kill-switch hole below and the app-db `reach = "hostPort"`
  # tenants are talking about the same address.
  pastaHostAlias = "169.254.1.2";
in
{
  config,
  lib,
  pkgs,
  mkRootlessContainer,
}:

rec {
  # The pin itself (and why it is `:latest` by digest) is the host's:
  # `fleet.gluetun.image`, defined beside the first tunnel. An image pin the
  # Updates page rewrites cannot live in a read-only engine input.
  gluetunImage = config.fleet.gluetun.image;

  # One exporter shape for every instance: polls the netns owner's
  # control API (localhost:8000 inside the shared netns) and serves
  # metrics on :8001, host-published by the owner.
  mkGluetunExporter =
    netnsOwner:
    mkRootlessContainer {
      image = config.fleet.gluetun.exporterImage;
      dependsOn = [ netnsOwner ];
      environment = {
        GLUETUN_URL = "http://localhost:8000";
        EXPORTER_PORT = "8001";
        EXPORTER_INTERVAL = "30";
      };
      extraOptions = [ "--network=container:${netnsOwner}" ];
    };

  # Netns-tenant decorator: a container that shares a gluetun instance's
  # netns (`--network=container:<owner>`) instead of a bridge. Rootless
  # podman maps container root -> the host operator, so PUID/PGID=0 means "run
  # as the user that owns the data" (non-linuxserver images ignore the
  # vars). Orders after the netns owner. Used by the downloads stack
  # (flaresolverr), the tv stack (qbittorrent/nzbget/*arrs/subgen) and the
  # shelfmark book downloader.
  mkNetnsTenant =
    netnsOwner: args:
    mkRootlessContainer (
      args
      // {
        dependsOn = [ netnsOwner ] ++ (args.dependsOn or [ ]);
        environment = {
          PUID = "0";
          PGID = "0";
        }
        // (args.environment or { });
        extraOptions = [ "--network=container:${netnsOwner}" ] ++ (args.extraOptions or [ ]);
      }
    );

  # Everything a gluetun instance needs, as one config fragment: the
  # sops-encrypted WireGuard key + its expiry-reminder timer, the
  # kernel modules, statePaths (wireguard/ 0700, auth/ for the tracked
  # control-API policy), the fail-closed gluetun container + its
  # exporter sibling and the prometheus scrape.
  # A third VPN netns is one call plus a wg0.conf.sops + auth asset.
  mkGluetunInstance =
    {
      name, # netns-owner container name ("gluetun", "gluetun-argus")
      exporterName ? "${name}-exporter", # exporter container name
      secretName ? "${name}-wg0", # sops secret key for the wg config
      wgConfSops, # ./wg0.conf.sops (sops-encrypted binary, IN the rebuild trail)
      authConfig, # ./assets/config.toml — control-server auth policy (tracked)
      stateRoot, # host dir that holds <stateRoot>/gluetun
      keyExpiry, # "YYYY-MM-DD" — ProtonVPN key expiry
      reminderDates, # OnCalendar list for the expiry reminder (30/7 days out)
      reminderPrefix ? name, # unit name: <prefix>-wg-expiry-reminder
      subject, # what the tunnel serves, for the reminder mail
      runbookPath, # file whose header holds the renewal runbook
      ports, # host-publish list — ALL netns tenants' ports live here
      environment ? { }, # instance-specific gluetun env (kill-switch holes, port forwarding)
      # Punch the kill switch open for the HOST ONLY, so tenants in this
      # netns can dial a host-published port — in practice the shared
      # postgres cluster on :5433, which no netns tenant can reach over
      # a bridge (`fleet.appDatabases.<name>.reach = "hostPort"`).
      #
      # The address is pasta's host alias, not the LAN IP: pasta copies
      # the host's address into the namespace, so the LAN address from in
      # here is the namespace itself. A /32 so opening this reaches the
      # host and nothing else on the network.
      hostEgress ? false,
      provider ? "ProtonVPN", # whose network this exits on — see fleet.vpnEgress
      scrapeJob ? name, # prometheus job_name for the exporter
      scrapeTarget, # exporter target ("host.containers.internal:<port>")
      # In-netns web UIs published on this gluetun, each
      # { name, port, healthPath, authBypassRule?, healthHeaders? }.
      # Emits the fleet.webApps entry per UI: serviceUrl dials the
      # host-published port (host.containers.internal — the netns owner
      # can't join traefik-net without mixing VPN-exit and bridge
      # traffic) and auth = "oidc" gates the browser path; the bypass
      # rule lets machine callers (API keys, RPC paths) through, since
      # they can't do an OIDC redirect. The instance still lists each
      # UI's port in `ports` — order there is load-bearing (it fixes
      # the container's ExecStart).
      webUis ? [ ],
    }:
    let
      # The HOST port the in-netns control API (:8000) is published on.
      # Read out of `ports` rather than taken as another argument: the
      # mapping is already stated there, and a second statement of it is a
      # second thing to get wrong on the instance that takes 8002 instead
      # of 8000. Fails the build loudly if no such mapping exists, which
      # is the correct answer — an instance with no reachable control API
      # has no exporter and no VPN alerts either.
      controlPort = lib.toInt (
        lib.head (
          (map (lib.removeSuffix ":8000") (lib.filter (lib.hasSuffix ":8000") ports))
          ++ [ (throw "gluetun instance ${name}: no port maps to the control API (:8000)") ]
        )
      );
    in
    {
      # Registered from the call that creates the instance, so a third
      # tunnel appears on the dashboard by existing rather than by being
      # added to a list somewhere else. See fleet.vpnEgress.
      fleet.vpnEgress.${name} = {
        container = name;
        exporter = exporterName;
        job = scrapeJob;
        inherit
          controlPort
          subject
          provider
          keyExpiry
          ;
        runbook = runbookPath;
        portForwarding = (environment.VPN_PORT_FORWARDING or "off") == "on";
      };

      # Updating this pin is never just this container. It owns a network
      # namespace every tenant rides, so the restart takes all of them with
      # it and the VPN drops for the length of the switch — and because every
      # instance reads the same `fleet.gluetun.image` pin, moving one pin moves
      # the other tunnel in the same commit whether or not anyone meant to.
      # Both facts are invisible from the container's name, which is exactly
      # what `ceremony` is for.
      fleet.imageUpdates.${name}.ceremony =
        "owns the netns its tenants ride — all of them restart, and every gluetun instance shares this pin";

      # ProtonVPN shows the private key ONCE at export — the sops copy
      # IS the recovery path. Renewal: re-export from
      # account.protonvpn.com/downloads, `sops -e --input-type binary
      # --output-type binary wg0.conf > <wgConfSops>`, bump keyExpiry +
      # reminderDates.
      sops.secrets.${secretName} = {
        sopsFile = wgConfSops;
        format = "binary";
        owner = config.fleet.operator.user;
      };

      # Key expiry kills the tunnel silently (gluetun is fail-closed:
      # egress stops, nothing leaks).
      systemd.services."${reminderPrefix}-wg-expiry-reminder" = {
        description = "Reminder: ${subject} WireGuard key expires ${keyExpiry}";
        serviceConfig.Type = "oneshot";
        script = ''
          {
            echo "From: ${config.fleet.mail.sender}"
            echo "To: ${config.fleet.mail.alertTo}"
            echo "Subject: [${config.networking.hostName}] ${subject} WireGuard key expires ${keyExpiry}"
            echo
            echo "The ProtonVPN WireGuard key for ${subject} expires ${keyExpiry}."
            echo "Renewal runbook: header of ${runbookPath}."
          } | ${pkgs.msmtp}/bin/msmtp --account=default -t
        '';
      };
      systemd.timers."${reminderPrefix}-wg-expiry-reminder" = {
        wantedBy = [ "timers.target" ];
        timerConfig = {
          OnCalendar = reminderDates;
          Persistent = true; # fire on next boot if the box was off
        };
      };

      # `[ ]` = pasta, no bridge — which still earns the mandatory
      # Type=oneshot systemd override from platform/podman.nix. The
      # exporter shares the owner's netns and needs the same.
      fleet.bridgeMemberships.${name} = [ ];
      fleet.bridgeMemberships.${exporterName} = [ ];

      # Host-loaded kernel modules gluetun needs (rootless can't load
      # them). Instances merge to the same set.
      boot.kernelModules = [
        "wireguard"
        "iptable_nat"
        "iptable_filter"
        "tun"
      ];

      fleet.statePaths = {
        "${stateRoot}/gluetun" = { };
        "${stateRoot}/gluetun/auth" = { };
        "${stateRoot}/gluetun/wireguard".mode = "0700";
      };

      fleet.prometheusScrapes = [
        {
          job_name = scrapeJob;
          static_configs = [ { targets = [ scrapeTarget ]; } ];
        }
      ];

      fleet.webApps = lib.listToAttrs (
        map (
          u:
          lib.nameValuePair u.name (
            {
              inherit (u) healthPath;
              serviceUrl = "http://host.containers.internal:${toString u.port}";
              auth = "oidc";
            }
            // lib.optionalAttrs (u ? authBypassRule) { inherit (u) authBypassRule; }
            // lib.optionalAttrs (u ? healthHeaders) { inherit (u) healthHeaders; }
            # Pocket ID groups allowed on the derived client. Omitted =
            # admins only, which is right for the whole TV stack.
            // lib.optionalAttrs (u ? authGroups) { inherit (u) authGroups; }
          )
        ) webUis
      );

      virtualisation.oci-containers.containers.${name} = mkRootlessContainer {
        image = gluetunImage;
        inherit ports;

        volumes = [
          "${stateRoot}/gluetun:/gluetun"
          "${config.sops.secrets.${secretName}.path}:/gluetun/wireguard/wg0.conf:ro"
          # Control-server auth policy is config, not state — tracked in
          # the repo so a fresh restore keeps the exporter (and the VPN
          # alerts behind it) working.
          "${authConfig}:/gluetun/auth/config.toml:ro"
        ];

        environment = {
          VPN_SERVICE_PROVIDER = "custom";
          VPN_TYPE = "wireguard";
        }
        // (lib.optionalAttrs hostEgress { FIREWALL_OUTBOUND_SUBNETS = "${pastaHostAlias}/32"; })
        // environment;

        extraOptions = [
          "--cap-add=NET_ADMIN"
          "--device=/dev/net/tun"
        ];
      };

      virtualisation.oci-containers.containers.${exporterName} = mkGluetunExporter name;
    };
}
