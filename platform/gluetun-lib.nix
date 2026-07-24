# gluetun-lib — shared plumbing for the box's gluetun (VPN netns owner)
# instances, as a PLAIN LIBRARY (`*-lib.nix` files are excluded from the
# auto-import in configuration.nix; consumers import this by path).
#
# Why not a module exporting _module.args: the consumers build their
# whole `config` with `lib.mkMerge [ (mkGluetunInstance {...}) {...} ]`,
# and forcing a custom module arg inside a top-level mkMerge recurses
# through the `_module.args` option evaluation. A by-path import has no
# such round-trip.
#
# Two instances live today, deliberately separate tunnels: stacks/downloads
# (torrent + book-downloader egress, with ProtonVPN port forwarding) and
# stacks/ipcrawl-vpn (scanner egress). One WireGuard key cannot run two live
# sessions, and their traffic must not mix.
#
# Host-port convention: the TV instance owns host 8000 (control API) +
# 8001 (exporter); each further instance publishes the same in-netns
# ports at +2 (ipcrawl: 8002/8003; a third takes 8004/8005).
#
# Usage (in a stack module):
#   inherit (import ../../platform/gluetun-lib.nix {
#     inherit config lib pkgs mkRootlessContainer;
#   }) mkGluetunInstance;
#   ...
#   config = lib.mkMerge [ (mkGluetunInstance { ... }) { ... } ];

{
  config,
  lib,
  pkgs,
  mkRootlessContainer,
}:

rec {
  gluetunImage = "docker.io/qmcgaw/gluetun:latest@sha256:b0ee2135e6ba52ad3f102aae9663707cd1c9531485117067a380d3b2b6dd991d";

  # One exporter shape for every instance: polls the netns owner's
  # control API (localhost:8000 inside the shared netns) and serves
  # metrics on :8001, host-published by the owner.
  mkGluetunExporter =
    netnsOwner:
    mkRootlessContainer {
      image = "ghcr.io/thecfu/gluetun-exporter:latest@sha256:bafeabb2a9638bf6b0800c2d3d47d49c6236d879bd01eec8caea45dfca2b50c5";
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
  # podman maps container root -> host santiago, so PUID/PGID=0 means "run
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

  # The gluetun homepage widget as a customapi over /v1/publicip/ip.
  # The native `type=gluetun` widget prints the full country NAME, which
  # clips in the narrow Network tiles; this keeps the live public IP +
  # region and remaps the country to a flag emoji. `url` is the control
  # API base (same value the native widget took); the endpoint is
  # appended. Each instance's exit is effectively pinned by its wg
  # config, so the table only needs the countries the box uses — any
  # other exit falls back to a globe.
  mkGluetunWidget =
    { url }:
    {
      type = "customapi";
      url = "${url}/v1/publicip/ip";
      refreshInterval = 30000;
      display = "block";
      mappings = [
        {
          field = "public_ip";
          label = "Public IP";
        }
        {
          field = "region";
          label = "Region";
        }
        {
          field = "country";
          label = "Country";
          remap = [
            { value = "Switzerland"; to = "🇨🇭"; }
            { value = "United States"; to = "🇺🇸"; }
            { value = "United Kingdom"; to = "🇬🇧"; }
            { value = "Netherlands"; to = "🇳🇱"; }
            { value = "Germany"; to = "🇩🇪"; }
            { value = "France"; to = "🇫🇷"; }
            { value = "Spain"; to = "🇪🇸"; }
            { value = "Italy"; to = "🇮🇹"; }
            { value = "Sweden"; to = "🇸🇪"; }
            { value = "Norway"; to = "🇳🇴"; }
            { value = "Finland"; to = "🇫🇮"; }
            { value = "Denmark"; to = "🇩🇰"; }
            { value = "Iceland"; to = "🇮🇸"; }
            { value = "Ireland"; to = "🇮🇪"; }
            { value = "Austria"; to = "🇦🇹"; }
            { value = "Belgium"; to = "🇧🇪"; }
            { value = "Poland"; to = "🇵🇱"; }
            { value = "Romania"; to = "🇷🇴"; }
            { value = "Portugal"; to = "🇵🇹"; }
            { value = "Canada"; to = "🇨🇦"; }
            { value = "Japan"; to = "🇯🇵"; }
            { value = "Singapore"; to = "🇸🇬"; }
            { value = "Hong Kong"; to = "🇭🇰"; }
            { value = "Australia"; to = "🇦🇺"; }
            { value = "Argentina"; to = "🇦🇷"; }
            { value = "Brazil"; to = "🇧🇷"; }
            { any = true; to = "🌐"; }
          ];
        }
      ];
    };

  # Everything a gluetun instance needs, as one config fragment: the
  # sops-encrypted WireGuard key + its expiry-reminder timer, the
  # kernel modules, statePaths (wireguard/ 0700, auth/ for the tracked
  # control-API policy), the fail-closed gluetun container + its
  # exporter sibling, the prometheus scrape, and the homepage tile.
  # A third VPN netns is one call plus a wg0.conf.sops + auth asset.
  mkGluetunInstance =
    {
      name, # netns-owner container name ("gluetun", "gluetun-ipcrawl")
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
      scrapeJob ? name, # prometheus job_name for the exporter
      scrapeTarget, # exporter target ("host.containers.internal:<port>")
      homepage ? null, # tile attrset for homepageServices."Network", or null
      # In-netns web UIs published on this gluetun, each
      # { name, port, healthPath, homepage, authBypassRule?, healthHeaders? }.
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
    {
      # ProtonVPN shows the private key ONCE at export — the sops copy
      # IS the recovery path. Renewal: re-export from
      # account.protonvpn.com/downloads, `sops -e --input-type binary
      # --output-type binary wg0.conf > <wgConfSops>`, bump keyExpiry +
      # reminderDates.
      sops.secrets.${secretName} = {
        sopsFile = wgConfSops;
        format = "binary";
        owner = "santiago";
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
            echo "Subject: [s2-server] ${subject} WireGuard key expires ${keyExpiry}"
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

      fleet.homepageServices."Network" = lib.optional (homepage != null) homepage;

      fleet.webApps = lib.listToAttrs (
        map (
          u:
          lib.nameValuePair u.name (
            {
              inherit (u) homepage healthPath;
              serviceUrl = "http://host.containers.internal:${toString u.port}";
              auth = "oidc";
            }
            // lib.optionalAttrs (u ? authBypassRule) { inherit (u) authBypassRule; }
            // lib.optionalAttrs (u ? healthHeaders) { inherit (u) healthHeaders; }
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
        // environment;

        extraOptions = [
          "--cap-add=NET_ADMIN"
          "--device=/dev/net/tun"
        ];
      };

      virtualisation.oci-containers.containers.${exporterName} = mkGluetunExporter name;
    };
}
