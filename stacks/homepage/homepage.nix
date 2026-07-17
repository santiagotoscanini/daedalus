# homepage — single-pane dashboard for the whole fleet (gethomepage.dev).
#
# Each stack contributes tiles via `myStack.homepageServices`; this
# module renders them into `/app/config/services.yaml`. `/app/config`
# is a writable host dir overlaid with per-file RO mounts for the
# configs we own. Single RO bind would break homepage's startup
# auto-seed (it writes missing defaults and trips EROFS).
#
# Secrets (per-service API keys, admin passwords) live in
# `env.sops` (sops) as HOMEPAGE_VAR_* keys — homepage substitutes
# `{{HOMEPAGE_VAR_FOO}}` placeholders in any rendered YAML at read time.

{
  config,
  lib,
  pkgs,
  mkRootlessContainer,
  mkDotenvSecret,
  ...
}:

let
  # Render myStack.homepageServices into homepage's services.yaml shape:
  # a list of single-key attrsets (group → [service]), each service a
  # single-key attrset (name → properties). YAML is JSON-superset, so
  # toJSON suffices.
  servicesYaml = pkgs.writeText "services.yaml" (
    builtins.toJSON (
      lib.mapAttrsToList (groupName: services: {
        "${groupName}" = map (svc: { "${svc.name}" = removeAttrs svc [ "name" ]; }) services;
      }) config.myStack.homepageServices
    )
  );

  # Tabs render in the order tab names FIRST appear in `layout:`. Since
  # nix `toJSON` of an attrset sorts keys alphabetically, we instead
  # serialize layout as a YAML LIST (still a homepage-supported shape)
  # with groups sorted by (tab position in `tabOrder`, group name).
  # That way the first tab visible to the user is `tabOrder[0]`
  # regardless of which group introduces it.
  tabOrder = [
    "Home"
    "Apps"
    "Infra"
  ];
  tabIdx =
    tab:
    let
      i = lib.lists.findFirstIndex (t: t == tab) null tabOrder;
    in
    if i == null then 999 else i;
  sortedGroupNames = lib.sort (
    a: b:
    let
      tA = tabIdx (config.myStack.homepageLayout.${a}.tab or "");
      tB = tabIdx (config.myStack.homepageLayout.${b}.tab or "");
    in
    if tA != tB then tA < tB else a < b
  ) (lib.attrNames config.myStack.homepageLayout);
  layoutList = map (n: { "${n}" = config.myStack.homepageLayout.${n}; }) sortedGroupNames;
  settingsYaml = pkgs.writeText "settings.yaml" (
    builtins.readFile ./assets/settings.yaml + "\nlayout: " + builtins.toJSON layoutList + "\n"
  );
in

{
  # HOMEPAGE_VAR_* widget keys: sops-encrypted env.sops, decrypted to
  # /run/secrets/homepage-env at activation. Edit with `sops env.sops`.
  sops.secrets."homepage-env" = mkDotenvSecret ./env.sops;

  myStack.containerNetworks.homepage = "traefik";

  myStack.webApps.homepage = {
    serviceName = "homepage";
    port = 3000;
  };

  # Per-group layout — keyed on the same group names contributed via
  # `myStack.homepageServices` (e.g. "Media", "Cloud & AI"). Each stack
  # that introduces a NEW group is responsible for adding its own
  # layout entry — apps.nix does this dynamically per-app.
  myStack.homepageLayout = {
    Media = {
      style = "row";
      columns = 4;
      icon = "mdi-play-circle-#94a3b8";
      useEqualHeights = true;
      tab = "Home";
    };
    "Cloud & AI" = {
      style = "row";
      columns = 4;
      icon = "mdi-cloud-#94a3b8";
      useEqualHeights = true;
      tab = "Home";
    };
    Productivity = {
      style = "row";
      columns = 4;
      icon = "mdi-briefcase-#94a3b8";
      useEqualHeights = true;
      tab = "Home";
    };
    Backend = {
      style = "row";
      columns = 4;
      icon = "mdi-database-cog-#94a3b8";
      useEqualHeights = true;
      tab = "Apps";
    };
    Network = {
      style = "row";
      columns = 5;
      icon = "mdi-lan-#94a3b8";
      useEqualHeights = true;
      tab = "Infra";
    };
    Monitoring = {
      style = "row";
      columns = 4;
      icon = "mdi-chart-areaspline-#94a3b8";
      useEqualHeights = true;
      tab = "Infra";
    };
  };

  # External / ambient network links — not tied to any container, so
  # they live here rather than in a stack module.
  myStack.homepageServices."Network" = [
    {
      name = "Router";
      href = "http://192.168.0.1/webpages/index.html?t=eb9856ea#networkMap";
      description = "LAN router admin (192.168.0.1)";
      icon = "/icons/tp-link.png";
      siteMonitor = "http://192.168.0.1/";
    }
    {
      name = "Cloudflare DNS";
      href = "https://dash.cloudflare.com/c08bf36c41d7bc5db11d6b35e0b4e721/toscanini.me/dns/records";
      description = "DNS records for toscanini.me";
      icon = "cloudflare.png";
    }
    {
      name = "Namecheap";
      href = "https://ap.www.namecheap.com/Domains/DomainControlPanel/toscanini.me/advancedns";
      description = "Domain registrar — toscanini.me";
      icon = "namecheap.png";
    }
    {
      name = "ProtonVPN";
      href = "https://account.protonvpn.com/downloads";
      description = "Re-export WireGuard config when gluetun peers fail";
      icon = "proton-vpn.png";
    }
  ];

  # Homepage auto-seeds the unpinned defaults (bookmarks fallback,
  # docker.yaml, kubernetes.yaml, etc.) into this dir on first run.
  systemd.tmpfiles.rules = [
    "d /home/santiago/selfhost/homepage/config 0755 santiago users -"
  ];

  virtualisation.oci-containers.containers.homepage = mkRootlessContainer {
    # Bump intentionally — the YAML schema has occasionally added
    # required fields (e.g. widget `version:` keys for pihole v6 /
    # immich v2 / wgeasy v2).
    image = "ghcr.io/gethomepage/homepage:v1.13.2@sha256:a0b71c8e757298d02560186bab9fbe3fc2d375c523a62cc1019177b37e48aa28";

    volumes = [
      "/home/santiago/selfhost/homepage/config:/app/config:rw"
      # Per-file RO overlays — the bits WE keep declarative.
      "${servicesYaml}:/app/config/services.yaml:ro"
      "${settingsYaml}:/app/config/settings.yaml:ro"
      "${./assets/widgets.yaml}:/app/config/widgets.yaml:ro"
      "${./assets/bookmarks.yaml}:/app/config/bookmarks.yaml:ro"
      "${./assets/custom.css}:/app/config/custom.css:ro"
      "${./assets/icons}:/app/public/icons:ro"
    ];

    environment = {
      # Host-header allow-list (defense in depth; traefik already routes
      # by host). Comma-separated, no spaces. localhost always allowed.
      HOMEPAGE_ALLOWED_HOSTS = "homepage.toscanini.me";
    };

    extraOptions = [
      # --add-host workarounds for widgets that can't reach a service
      # by raw bridge name:
      #  - traefik: api@internal only serves on websecure with the right
      #    Host header, so we route through the public FQDN.
      #  - nextcloud: NC_overwriteprotocol="https" 30x-redirects every
      #    plain-HTTP request, and homepage's proxy can't follow http→https.
      #  - nzbget / pihole / qbittorrent: homepage's undici client trips
      #    on their `Connection: close` responses → ECONNRESET. Going
      #    through traefik gets keep-alive and sidesteps the bug.
      "--add-host=traefik.toscanini.me:host-gateway"
      "--add-host=nextcloud.toscanini.me:host-gateway"
      "--add-host=nzbget.toscanini.me:host-gateway"
      "--add-host=pihole.toscanini.me:host-gateway"
      "--add-host=qbittorrent.toscanini.me:host-gateway"
      # traefik-net is the primary bridge so siteMonitor / widget URLs
      # targeting migrated stacks resolve via aardvark-dns
      # (e.g. http://grafana:3000). Non-migrated stacks need
      # host.containers.internal or --add-host above.
      "--network=traefik-net"
      # monitoring-net: homepage's per-app log widget queries loki:3100
      # directly (loki left traefik-net), so homepage must share its bridge.
      "--network=monitoring-net"
    ];

    environmentFiles = [
      config.sops.secrets."homepage-env".path
    ];
  };
}
