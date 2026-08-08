# downloads stack — the shared VPN egress + Cloudflare solver that the
# content stacks (tv, shelfmark) hang their download tenants off of.
#
# Architecture:
#   - gluetun holds a ProtonVPN WireGuard tunnel and OWNS the netns. Only
#     the netns owner can publish ports, so every tenant's UI port lives
#     on gluetun's container block — assembled here from the merged
#     `fleet.gluetunTenants.gluetun` registry that tv + shelfmark
#     contribute to. Each content stack declares its OWN tenants; this
#     module just publishes the sorted union and turns the UI entries into
#     Pocket-ID-gated webApps.
#   - flaresolverr is the shared Cloudflare-challenge solver in the same
#     netns: prowlarr dials 127.0.0.1:8191, and the shelfmark book
#     downloader reuses it via EXT_BYPASSER_URL (no second headless
#     browser).
#
# On-disk gluetun state stays at /home/santiago/selfhost/tv/gluetun
# (historical): the module moved here but moving a live tunnel's state
# dir buys nothing and risks the running VPN.
#
# WireGuard key: sops-encrypted (downloads-wg0), bind-mounted over
# wg0.conf inside the /gluetun mount. ProtonVPN shows the private key
# ONCE at export — a lost key means a fresh export, not recovery. The
# current key EXPIRES 2027-04-03 (reminder emails fire 30/7 days ahead).
# Renewal: re-export from https://account.protonvpn.com/downloads, then
#   sops -e --input-type binary --output-type binary wg0.conf \
#     > stacks/downloads/wg0.conf.sops
# and bump the reminder dates below.

{
  config,
  lib,
  pkgs,
  mkRootlessContainer,
  ...
}:

let
  inherit
    (import ../../platform/gluetun-lib.nix {
      inherit
        config
        lib
        pkgs
        mkRootlessContainer
        ;
    })
    mkGluetunInstance
    mkNetnsTenant
    ;

  # The netns tenants that content stacks contribute. Sort by port so the
  # generated `ports` list (hence gluetun's ExecStart) is deterministic
  # regardless of module contribution order — a reorder would recreate
  # gluetun and bounce every tenant.
  tenants = config.fleet.gluetunTenants.gluetun or [ ];
  sortedTenants = lib.sort (a: b: a.port < b.port) tenants;

  # UI tenants become Pocket-ID-gated webApps (serviceUrl dials the
  # host-published port); publish-only tenants (ui = false, e.g. subgen's
  # OpenAI endpoint) just get their port opened.
  webUis = map (
    t:
    {
      inherit (t)
        name
        port
        healthPath
        ;
    }
    // lib.optionalAttrs (t.authBypassRule != null) { inherit (t) authBypassRule; }
    // lib.optionalAttrs (t.healthHeaders != null) { inherit (t) healthHeaders; }
    // lib.optionalAttrs (t.authGroups != null) { inherit (t) authGroups; }
  ) (lib.filter (t: t.ui) sortedTenants);
in
{
  options.fleet.gluetunTenants = lib.mkOption {
    type = lib.types.attrsOf (
      lib.types.listOf (
        lib.types.submodule (_: {
          options = {
            name = lib.mkOption {
              type = lib.types.nullOr lib.types.str;
              default = null;
              description = "Container name — the webApp key (UI tenants only).";
            };
            port = lib.mkOption {
              type = lib.types.port;
              description = "In-netns port, published host:host on the gluetun owner.";
            };
            ui = lib.mkOption {
              type = lib.types.bool;
              default = true;
              description = "Emit a Pocket-ID-gated webApp. false = publish the port only.";
            };
            healthPath = lib.mkOption {
              type = lib.types.nullOr lib.types.str;
              default = null;
            };
            authBypassRule = lib.mkOption {
              type = lib.types.nullOr lib.types.str;
              default = null;
            };
            healthHeaders = lib.mkOption {
              type = lib.types.nullOr (lib.types.attrsOf lib.types.str);
              default = null;
            };
            authGroups = lib.mkOption {
              type = lib.types.nullOr (lib.types.listOf lib.types.str);
              default = null;
              description = ''
                Pocket ID groups allowed on the derived client. null
                keeps the webApp default (admins only), which is right
                for the whole TV stack; shelfmark is the household
                exception.
              '';
            };
          };
        })
      )
    );
    default = { };
    description = ''
      Per-gluetun-instance netns tenants. Content stacks contribute their
      own tenants; the downloads stack publishes the sorted union on the
      netns owner and turns UI entries into webApps.
    '';
  };

  config = lib.mkMerge [
    # The VPN netns kit — sops wg key + expiry reminder, kernel modules,
    # gluetun + exporter containers and scrape — comes from
    # platform/gluetun-lib.nix. Ports + webApps are derived from the
    # merged tenant registry above.
    (mkGluetunInstance {
      name = "gluetun";
      secretName = "downloads-wg0";
      wgConfSops = ./wg0.conf.sops;
      authConfig = ./assets/config.toml;
      stateRoot = "/home/santiago/selfhost/tv";
      keyExpiry = "2027-04-03";
      reminderDates = [
        "2027-03-04" # 30 days out
        "2027-03-27" # 7 days out
      ];
      reminderPrefix = "downloads";
      subject = "Downloads VPN (gluetun)";
      inherit webUis;
      runbookPath = "/etc/nixos/stacks/downloads/downloads.nix";

      # ALL netns tenants' ports (sorted union of the registry) plus the
      # instance's own control API (8000) and exporter (8001). None are
      # firewall-opened — traefik dials them via host.containers.internal.
      ports = (map (t: "${toString t.port}:${toString t.port}") sortedTenants) ++ [
        "8000:8000" # gluetun HTTP control server
        "8001:8001" # gluetun-exporter (shares this netns)
      ];

      # Direct (non-VPN) egress to the host ONLY — the *arrs dial the
      # shared app-db cluster at host.containers.internal:5433, which no
      # netns tenant can reach over a bridge. The address itself lives in
      # gluetun-lib; see `hostEgress` there for why it is pasta's alias
      # and not the LAN IP.
      hostEgress = true;

      environment = {
        # gluetun's DNS-over-TLS blocklist (BLOCK_MALICIOUS) flags shadow-
        # library domains (Anna's Archive) as "malicious" and NXDOMAINs
        # them, breaking shelfmark's release search. AA rotates domains
        # constantly (.org/.se went dark, .li got parked, .gs is live),
        # so an unblock allow-list is unmaintainable — turn the blocklist
        # off for this download-only netns instead. The VPN egress is the
        # protection here, not a DNS filter.
        BLOCK_MALICIOUS = "off";
        VPN_PORT_FORWARDING = "on";
        VPN_PORT_FORWARDING_PROVIDER = "protonvpn";
        # When ProtonVPN hands out a new forwarded port, push it to
        # qBittorrent so qBT listens there. Requires "Bypass auth for
        # localhost clients" in qBT. {{PORTS}} is gluetun's template.
        VPN_PORT_FORWARDING_UP_COMMAND = "/bin/sh -c 'wget -O- --retry-connrefused --post-data \"json={\\\"listen_port\\\":{{PORTS}}}\" http://127.0.0.1:8090/api/v2/app/setPreferences 2>&1'";
      };

      scrapeTarget = "host.containers.internal:8001";

    })
    {
      # Shared Cloudflare-challenge solver in gluetun's netns. prowlarr
      # dials 127.0.0.1:8191; shelfmark reuses it (EXT_BYPASSER_URL).
      # Internal only — not in the ports registry.
      virtualisation.oci-containers.containers.flaresolverr = mkNetnsTenant "gluetun" {
        image = "docker.io/flaresolverr/flaresolverr:v3.5.0@sha256:139dfee1c6f89249c8d665d1333a42e8ec74ec0a86bc6bb1c8461e10d3a66a47";

        environment = {
          LOG_LEVEL = "info";
          LOG_HTML = "false";
          CAPTCHA_SOLVER = "none";
        };
      };

      # netns tenant → no bridge (still earns the Type=oneshot override).
      fleet.bridgeMemberships.flaresolverr = [ ];

      # Loki stack label for the shared plumbing.
      fleet.logStacks.downloads = [
        "gluetun"
        "gluetun-exporter"
        "flaresolverr"
      ];
    }
  ];
}
