# homepage — single-pane dashboard for the whole fleet (gethomepage.dev).
#
# Each stack contributes tiles via `fleet.homepageServices`; this
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
  mkSecretRender,
  ...
}:

let
  # Render fleet.homepageServices into homepage's services.yaml shape:
  # a list of single-key attrsets (group → [service]), each service a
  # single-key attrset (name → properties). YAML is JSON-superset, so
  # toJSON suffices.
  servicesYaml = pkgs.writeText "services.yaml" (
    builtins.toJSON (
      lib.mapAttrsToList (groupName: services: {
        "${groupName}" = map (svc: { "${svc.name}" = removeAttrs svc [ "name" ]; }) services;
      }) config.fleet.homepageServices
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
  # Within a tab, groups sort by an optional `order` and then by name, so
  # a group can be placed deliberately instead of alphabetically. `order`
  # is OURS, not a homepage layout key — stripped before serialization.
  groupOrder = n: config.fleet.homepageLayout.${n}.order or 500;
  sortedGroupNames = lib.sort (
    a: b:
    let
      tA = tabIdx (config.fleet.homepageLayout.${a}.tab or "");
      tB = tabIdx (config.fleet.homepageLayout.${b}.tab or "");
      oA = groupOrder a;
      oB = groupOrder b;
    in
    if tA != tB then
      tA < tB
    else if oA != oB then
      oA < oB
    else
      a < b
  ) (lib.attrNames config.fleet.homepageLayout);
  layoutList = map (n: {
    "${n}" = removeAttrs config.fleet.homepageLayout.${n} [ "order" ];
  }) sortedGroupNames;
  settingsYaml = pkgs.writeText "settings.yaml" (
    builtins.readFile ./assets/settings.yaml + "\nlayout: " + builtins.toJSON layoutList + "\n"
  );
in

{
  # HOMEPAGE_VAR_* widget keys: sops-encrypted env.sops, decrypted to
  # /run/secrets/homepage-env at activation. Edit with `sops env.sops`.
  sops.secrets."homepage-env" = mkDotenvSecret ./env.sops;

  # homepage only substitutes {{HOMEPAGE_VAR_*}} from its own env, so
  # keys owned by other stacks are appended to the decrypted env at
  # boot — rendered from each stack's sops secret, the single source of
  # truth (no second copy to sync on rotation).
  #
  # PLANE_API_KEY is a workspace token minted in Plane's UI, so it is
  # empty until someone creates one; the grep still matches (the line
  # exists in plane/env.sops) and the widgets that use it stay off
  # until stacks/plane sets workspaceSlug.
  systemd.services.homepage-env = mkSecretRender {
    description = "Render homepage env (sops env + per-stack API keys)";
    gates = [ "podman-homepage.service" ];
    dir = "/run/homepage-env";
    file = "/run/homepage-env/env";
    prep = ''
      LITELLM_KEY=$(grep '^LITELLM_MASTER_KEY=' ${config.sops.secrets."litellm-env".path} | cut -d= -f2-)
      POCKETID_KEY=$(grep '^STATIC_API_KEY=' ${config.sops.secrets."pocket-id-env".path} | cut -d= -f2-)
      PLANE_KEY=$(grep '^PLANE_API_KEY=' ${config.sops.secrets."plane-env".path} | cut -d= -f2-)
    '';
    content = ''
      $(cat ${config.sops.secrets."homepage-env".path})
      HOMEPAGE_VAR_LITELLM_KEY=''${LITELLM_KEY}
      HOMEPAGE_VAR_POCKETID_KEY=''${POCKETID_KEY}
      HOMEPAGE_VAR_PLANE_KEY=''${PLANE_KEY}
    '';
  };
  systemd.services.podman-homepage = {
    after = [ "homepage-env.service" ];
    wants = [ "homepage-env.service" ];
  };

  fleet.bridgeMemberships.homepage = [
    "traefik"
    "monitoring"
  ]; # monitoring: the per-app log widget queries loki:3100 directly

  fleet.webApps.homepage = {
    serviceName = "homepage";
    port = 3000;
    # No auth of its own (upstream: none planned) — Pocket ID gate is
    # the only login. Pilot service for the oidc-auth middleware.
    auth = "oidc";
    # Household app: santi + sofi, not admins-only.
    authGroups = [ "admins" "family" ];
    healthPath = "/api/healthcheck";
  };

  # Per-group layout — keyed on the same group names contributed via
  # `fleet.homepageServices` (e.g. "Media", "Cloud & AI"). Each stack
  # that introduces a NEW group is responsible for adding its own
  # layout entry — apps.nix does this dynamically per-app.
  fleet.homepageLayout = {
    Media = {
      style = "row";
      columns = 4;
      icon = "mdi-play-circle-#94a3b8";
      useEqualHeights = true;
      tab = "Home";
      order = 30;
    };
    "AI & Automation" = {
      style = "row";
      columns = 4;
      icon = "mdi-robot-#94a3b8";
      useEqualHeights = true;
      tab = "Home";
      order = 10;
    };
    # Reading stack: the library (calibre-web) + its downloader
    # (shelfmark), split out of Media so books aren't buried under the
    # video pipeline.
    Books = {
      style = "row";
      columns = 4;
      icon = "mdi-bookshelf-#94a3b8";
      useEqualHeights = true;
      tab = "Home";
      order = 40;
    };
    # Household services — identity, files, photos, automation, the
    # day-to-day apps. Named for what it serves, not where it runs.
    Home = {
      style = "row";
      columns = 4;
      icon = "mdi-home-heart-#94a3b8";
      useEqualHeights = true;
      tab = "Home";
      order = 20;
    };
    Gaming = {
      style = "row";
      columns = 4;
      icon = "mdi-gamepad-variant-#94a3b8";
      useEqualHeights = true;
      tab = "Home";
      order = 50;
    };
    # zot (OCI images) + verdaccio (npm) — both exist to serve the apps
    # platform's build/deploy loop, so they live on the Apps tab.
    Registries = {
      style = "row";
      columns = 4;
      icon = "mdi-package-variant-closed-#94a3b8";
      useEqualHeights = true;
      tab = "Apps";
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
      columns = 5;
      icon = "mdi-chart-areaspline-#94a3b8";
      useEqualHeights = true;
      tab = "Infra";
    };
  };

  # External / ambient network links — not tied to any container, so
  # they live here rather than in a stack module.
  fleet.homepageServices."Network" = [
    {
      name = "Router";
      weight = 80;
      href = "http://192.168.0.1/webpages/index.html?t=eb9856ea#networkMap";
      description = "LAN router admin (192.168.0.1)";
      icon = "/icons/tp-link.png";
      siteMonitor = "http://192.168.0.1/";
    }
    {
      name = "Cloudflare DNS";
      weight = 70;
      href = "https://dash.cloudflare.com/c08bf36c41d7bc5db11d6b35e0b4e721/toscanini.me/dns/records";
      description = "DNS records for toscanini.me";
      icon = "cloudflare.png";
    }
    {
      name = "Namecheap";
      weight = 60;
      href = "https://ap.www.namecheap.com/Domains/DomainControlPanel/toscanini.me/advancedns";
      description = "Domain registrar — toscanini.me";
      icon = "namecheap.png";
    }
    {
      name = "ProtonVPN";
      weight = 90;
      href = "https://account.protonvpn.com/downloads";
      description = "Re-export WireGuard config when gluetun peers fail";
      icon = "proton-vpn.png";
    }
  ];

  # Homepage auto-seeds the unpinned defaults (bookmarks fallback,
  # docker.yaml, kubernetes.yaml, etc.) into this dir on first run.
  fleet.statePaths."/home/santiago/selfhost/homepage/config" = { };

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
      # by host). Derived from the webApp so a hostname change can't
      # silently 400 every request. localhost always allowed.
      HOMEPAGE_ALLOWED_HOSTS = config.fleet.webApps.homepage.hostname;
    };

    extraOptions = [
      # --add-host workarounds for widgets that can't reach a service
      # by raw bridge name:
      #  - nextcloud: NC_overwriteprotocol="https" 30x-redirects every
      #    plain-HTTP request, and homepage's proxy can't follow http→https.
      #  - nzbget / qbittorrent / pihole: homepage's undici client trips
      #    on their (FTL's) `Connection: close` framing → ECONNRESET /
      #    HPE_CLOSED_CONNECTION. Going through traefik gets keep-alive
      #    and sidesteps the bug (pihole rides a scoped OIDC bypass for
      #    the widget's read-only calls — see stacks/pihole).
      # (The pinned entries also keep these widgets working while
      # pi-hole is down — container DNS otherwise resolves the public
      # hostnames through it.)
      "--add-host=nextcloud.toscanini.me:host-gateway"
      "--add-host=nzbget.toscanini.me:host-gateway"
      "--add-host=qbittorrent.toscanini.me:host-gateway"
      "--add-host=pihole.toscanini.me:host-gateway"
    ];

    environmentFiles = [ "/run/homepage-env/env" ];
  };
}
