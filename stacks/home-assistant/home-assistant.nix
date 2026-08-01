# home-assistant — the home-automation hub. One container, host netns,
# recorder on the shared app-db cluster, Pocket ID SSO via a vendored
# custom component. Published on LAN + the Cloudflare tunnel.
#
# ── Why --network=host (and not traefik-net) ────────────────────────────
# Upstream's documented shape, and structural here: every local-push
# integration worth having (ESPHome, Shelly, Sonos, Chromecast, WLED,
# Apple TV, HomeKit Bridge, Matter) is discovered over mDNS/zeroconf or
# SSDP, which are multicast on the LAN segment. A bridge netns sees
# none of that — devices would all have to be added by hand-typed IP and
# HomeKit Bridge could not advertise at all.
#
# Consequences, each handled below:
#   - No traefik-net, so no `serviceName`. Traefik dials the escape
#     hatch `http://host.containers.internal:8123`, the same shape the
#     gluetun-netns TV stack uses.
#   - 8123 binds on the host but is NOT opened in the firewall: LAN
#     clients reach Home Assistant only through traefik's HTTPS, which
#     is also what makes the wildcard cert and the access log useful.
#   - Multicast discovery DOES need the kernel to accept inbound
#     224.0.0.251:5353 / 239.255.255.250:1900, so those two UDP ports
#     are opened on enp3s0 only (see the firewall block).
#   - The `dhcp` discovery integration (part of default_config) needs a
#     CAP_NET_RAW packet socket in the host netns, which rootless podman
#     cannot grant. It logs a warning and stays inert; zeroconf/SSDP
#     cover the same devices. Bluetooth is out for the same reason —
#     an ESPHome Bluetooth proxy is the supported answer anyway.
#
# ── Trusted proxy is the HOST address, not the bridge subnet ────────────
# Measured, not assumed: a container on traefik-net dialing
# `host.containers.internal` arrives at a host-netns listener with source
# 192.168.0.2 — pasta SNATs to the host's own LAN address, so the
# 10.89.7.0/24 traefik-net subnet never appears. `trusted_proxies` must
# therefore name the host, and the trust boundary is "anything already
# running on this box", which is exactly who can reach the closed port.
#
# ── Recorder lives on the shared Postgres cluster ───────────────────────
# `fleet.appDatabases.home_assistant`. The official image already ships
# psycopg2 (2.9.12), so no derived image is needed — but that dependency
# is transitive, not declared in recorder's manifest, so a version bump
# should re-check it (`podman run --rm --entrypoint /bin/sh <image> -c
# 'python3 -c "import psycopg2"'`). The bootstrap's DATABASE_URL points
# at `pg:5432`, a bridge name this container cannot resolve, so
# home-assistant-db-env below re-renders it against the cluster's
# plain-TCP host port on loopback.
#
# Long-term statistics (the 5-minute/hourly rollups the Energy and
# History dashboards read) are kept for years regardless of recorder's
# 10-day `purge_keep_days` default, so the default is left alone.
#
# ── configuration.yaml is generated; UI-authored YAML is not ────────────
# The file below is a read-only /nix/store bind mount: changing Home
# Assistant's core config means editing this module and rebuilding. The
# three `!include`s point at writable files in /config that the UI
# automation/script/scene editors own — pre-created by fleet.statePaths
# so a fresh restore starts with valid includes.
#
# Secrets never land in the config file: Home Assistant's YAML loader
# supports `!env_var`, so the recorder URL and the OIDC client secret
# come in through environmentFiles and stay out of the store.
#
# ── SSO ─────────────────────────────────────────────────────────────────
# hass-oidc-auth, vendored from a pinned tag as a read-only bind mount
# instead of installed through HACS — the component is pure Python and
# all three of its requirements (aiofiles, jinja2, joserfc) are already
# in the image, so nothing is fetched or pip-installed at runtime.
# Home Assistant's own login stays enabled. That is not a preference —
# `POST /api/onboarding/users` has `vol.Required("password")`, so a
# local owner MUST exist before any OIDC login can happen. The owner is
# `santito`, matching the Pocket ID preferred_username; its password is
# in owner-password.sops, read by nothing, kept only so the break-glass
# survives a restore-from-repo.
#
# Going SSO-only later means `homeassistant.auth_providers: []` — which
# works, because auth_oidc registers by mutating `hass.auth._providers`
# directly rather than through that option. Upstream advises against it
# and there is an unresolved report of the login flows degrading under
# it (discussion #67), so verify against this HA version before taking
# it. See AUTH.md for the ordering.
#
# Deliberately NOT in `fleet.sso.discoveryConsumers`: the component
# fetches discovery lazily at first login, and gating a house's
# automation on the IdP being up would be the wrong failure mode.

{
  config,
  pkgs,
  mkDotenvSecret,
  mkRootlessContainer,
  mkSecretRender,
  ...
}:

let
  hostname = "homeassistant.${config.fleet.baseDomain}";
  url = "https://${hostname}";

  configDir = "/home/santiago/selfhost/home-assistant/config";

  # Pocket ID OIDC client/RP. Pinned tag; the hash covers the unpacked
  # tree, so bumping the rev without the hash fails the build.
  oidcAuth = pkgs.fetchFromGitHub {
    owner = "christiaangoossens";
    repo = "hass-oidc-auth";
    rev = "v1.1.1";
    hash = "sha256-d1nRSAR4HAoW+gpAtyb0s6bh40CcoT59dgVOkwKHavU=";
  };

  # Not /run/home-assistant: systemd wipes a RuntimeDirectory named
  # after a unit when that unit stops, which would silently empty the
  # rendered file underneath the running container.
  dbEnvDir = "/run/home-assistant-db";
  dbEnvFile = "${dbEnvDir}/env";
  promTokenDir = "/run/home-assistant-prom-token";

  # Parsed at BUILD time (see the wrapper below) so a templating slip
  # fails `nixos-rebuild` instead of restarting the container into a
  # Home Assistant that dies on startup.
  rawConfigurationYaml = pkgs.writeText "home-assistant-configuration.yaml" ''
    # Generated by /etc/nixos/stacks/home-assistant/home-assistant.nix.
    # Read-only bind mount — edit the module, not this file.

    homeassistant:
      # Single source of truth with the host's own clock.
      time_zone: ${config.time.timeZone}
      # Same name on the LAN and through the tunnel, so both resolve to
      # the wildcard cert. Setting these here makes the UI fields
      # read-only, which is the point.
      internal_url: "${url}"
      external_url: "${url}"

    # The recommended meta-integration: frontend, history, logbook,
    # mobile_app, zeroconf, ssdp, backup, energy, media_source, ...
    # Kept whole rather than enumerated — upstream adds to it every
    # release and an explicit list silently rots.
    default_config:

    http:
      # Traefik is the only way in; honour its forwarded client IP.
      # 192.168.0.2 (not the traefik-net subnet) is what a bridge
      # container's connection actually presents here — see the header.
      use_x_forwarded_for: true
      trusted_proxies:
        # The peer address a bridge container presents (pasta SNATs to
        # the host's own LAN address).
        - ${config.fleet.lanIp}/32
        # Traefik's address inside traefik-net, which is what it appends
        # to X-Forwarded-For. Without this Home Assistant stops walking
        # the chain at traefik and treats the PROXY as the client, so
        # every request through the tunnel is attributed to 10.89.7.x
        # instead of the real remote IP.
        - ${config.fleet.bridgeSubnets.traefik}
      # ip_ban is OFF, and this is not laziness — in this topology it can
      # only ever fire on shared infrastructure. Every request reaches
      # Home Assistant from one of two addresses: 192.168.0.2 (anything
      # on the box dialing host.containers.internal) or traefik's bridge
      # IP. LAN client IPs are additionally collapsed by rootlessport
      # before traefik ever sees them. So a ban never isolates one bad
      # actor — it takes the whole instance offline for everyone.
      #
      # Demonstrated the hard way on 2026-07-31: a homepage widget
      # configured with an empty token polled the API every few seconds,
      # crossed the threshold, and got 192.168.0.2 + 10.89.7.71 banned —
      # after which Home Assistant returned 403 to LAN and tunnel alike.
      #
      # What actually guards this surface: Pocket ID (passkey-only) for
      # browser logins, and long-lived bearer tokens for the API.
      ip_ban_enabled: false

    recorder:
      # Rendered by home-assistant-db-env.service from the app-db
      # bootstrap's password — never written to the store.
      db_url: !env_var HA_DB_URL

    # /api/prometheus, bearer-authenticated. `requires_auth: false` would
    # be simpler but publishes every entity's state to anything that can
    # reach :8123, which on a host-netns container is every process on
    # the box — the token is cheap by comparison.
    prometheus:

    # Pocket ID (AUTH.md tier 1). Confidential client: the secret is
    # handed over by fleet.ssoClients, PKCE stays on top of it.
    auth_oidc:
      client_id: home-assistant
      client_secret: !env_var HA_OIDC_CLIENT_SECRET
      discovery_url: "${config.fleet.sso.issuerUrl}/.well-known/openid-configuration"
      display_name: "Pocket ID"
      roles:
        # Pocket ID's `admins` group maps to Home Assistant's admin
        # role. Members of `family` (once the client allows them) land
        # as ordinary users.
        admin: admins
      features:
        # Left off on purpose: the welcome screen still offers the
        # local login, which onboarding needs and which is the
        # break-glass. Flip to `default_redirect: true` once SSO is
        # verified from both LAN and tunnel.
        default_redirect: false
        # `automatic_user_linking` is deliberately absent (defaults to
        # false). It was on for exactly one login: onboarding must
        # create a local owner (the onboarding API requires a
        # password), so the owner was created as `santito` to match the
        # Pocket ID preferred_username, and linking attached the OIDC
        # credential to that owner instead of minting a second,
        # non-owner user. The link is stored in .storage/auth and
        # survives — turning the feature off does NOT unlink it; it
        # only stops NEW links being made.
        #
        # Do not re-enable casually: while on, any Pocket ID account
        # whose username matches an HA username takes that account
        # over, and HA-side MFA is skipped.

    # UI-owned, writable (pre-created by fleet.statePaths).
    automation: !include automations.yaml
    script: !include scripts.yaml
    scene: !include scenes.yaml
  '';

  # The file the container actually mounts: byte-identical to the above,
  # but only produced if it parses. Schema validation is out of reach in
  # a nix build (it needs a live Home Assistant with every integration
  # importable) — this is the syntax half, which is the half a generated
  # file gets wrong.
  configurationYaml =
    pkgs.runCommand "home-assistant-configuration-checked.yaml"
      {
        nativeBuildInputs = [ (pkgs.python3.withPackages (ps: [ ps.pyyaml ])) ];
      }
      ''
        python3 ${./assets/check-config-yaml.py} ${rawConfigurationYaml}
        cp ${rawConfigurationYaml} $out
      '';
in
{
  # Host netns — the `--network=host` flag lives in extraOptions, and
  # this empty list is its mandatory registry entry.
  fleet.bridgeMemberships.home-assistant = [ ];

  fleet.logStacks.home-assistant = [ "home-assistant" ];

  # Container runs as root (s6-overlay), so uid 0 → host santiago.
  fleet.statePaths = {
    "${configDir}" = { };
    # Mountpoint for the vendored component below — declared so a fresh
    # restore has it santiago-owned rather than podman-created.
    "${configDir}/custom_components" = { };
    "${configDir}/custom_components/auth_oidc" = { };
    # `!include` targets. Empty is valid YAML here (parses as null),
    # which is exactly what stock Home Assistant ships.
    "${configDir}/automations.yaml".type = "f";
    "${configDir}/scripts.yaml".type = "f";
    "${configDir}/scenes.yaml".type = "f";
  };

  # Recorder's database on the shared cluster. `consumers` orders this
  # container after the bootstrap AND after pg itself.
  fleet.appDatabases.home_assistant.consumers = [ "home-assistant" ];

  # The bootstrap writes DATABASE_URL against `pg:5432`, a bridge name
  # the host netns cannot resolve. Re-point it at the cluster's
  # plain-TCP host port on loopback — the same escape hatch the
  # gluetun-netns *arrs use, one hop shorter because we are already on
  # the host. Password is `openssl rand -hex 32`, so no URL-encoding.
  systemd.services.home-assistant-db-env = mkSecretRender {
    description = "Render the Home Assistant recorder DB URL for the host netns";
    gates = [ "podman-home-assistant.service" ];
    after = [ "app-db-home_assistant-bootstrap.service" ];
    wants = [ "app-db-home_assistant-bootstrap.service" ];
    dir = dbEnvDir;
    file = dbEnvFile;
    prep = ''
      DB_PWD=$(grep '^POSTGRES_PASSWORD=' ${
        config.fleet.appDatabases.home_assistant.envFile
      } | head -1 | cut -d= -f2-)
      [ -n "$DB_PWD" ] || { echo "POSTGRES_PASSWORD missing from the app-db env file" >&2; exit 1; }
    '';
    content = "HA_DB_URL=postgresql://home_assistant:$DB_PWD@127.0.0.1:5433/home_assistant";
  };

  # HA_PROMETHEUS_TOKEN — a long-lived access token minted against the
  # owner account. Edit with `sops env.sops`.
  sops.secrets."home-assistant-env" = mkDotenvSecret ./env.sops;

  # prometheus `credentials_file` wants a file holding ONLY the token,
  # but env.sops is a full dotenv — same extract-at-boot idiom litellm
  # uses for its master key.
  systemd.services.home-assistant-prom-token = mkSecretRender {
    description = "Render the Home Assistant long-lived token as a bare bearer token";
    gates = [ "podman-prometheus.service" ];
    dir = promTokenDir;
    file = "${promTokenDir}/token";
    prep = ''
      TOKEN=$(grep '^HA_PROMETHEUS_TOKEN=' ${
        config.sops.secrets."home-assistant-env".path
      } | head -1 | cut -d= -f2-)
    '';
    content = "$TOKEN";
  };

  # This stack owns the token, so it contributes the mount rather than
  # monitoring.nix reaching into another stack's /run dir. The DIR is
  # mounted, not the file: a single-file bind pins the old inode, so a
  # rotation would not be seen until prometheus restarted.
  virtualisation.oci-containers.containers.prometheus.volumes = [
    "${promTokenDir}:/run/secrets/home-assistant-prom-token:ro"
  ];

  # Not `webApps.metrics.enable` — that shortcut scrapes
  # `<serviceName>:<port>` over traefik-net, and this stack is host-netns
  # with no container DNS name. Prometheus reaches it the same way it
  # reaches node-exporter.
  fleet.prometheusScrapes = [
    {
      job_name = "home-assistant";
      metrics_path = "/api/prometheus";
      # Home Assistant re-derives every entity's metrics per scrape;
      # 60s keeps that off the critical path (the default 15s buys
      # nothing for state that changes on device events, not on a timer).
      scrape_interval = "60s";
      authorization = {
        type = "Bearer";
        credentials_file = "/run/secrets/home-assistant-prom-token/token";
      };
      static_configs = [ { targets = [ "host.containers.internal:8123" ]; } ];
    }
  ];

  fleet.grafanaDashboardsByFolder."Services".home-assistant =
    builtins.readFile ./assets/dashboard.json;

  # Pocket ID client — id `home-assistant`, secret
  # SSO_SECRET_HOME_ASSISTANT in stacks/pocket-id/clients.sops, rendered
  # into the container as HA_OIDC_CLIENT_SECRET (the name the generated
  # configuration.yaml reads via !env_var). Admin-only for now: there is
  # nothing for the household to see until the phase-2 dashboards land,
  # and `allowedGroups` is a one-line widening then.
  fleet.ssoClients.home-assistant = {
    displayName = "Home Assistant";
    description = "Home automation";
    launchURL = url;
    callbackURLs = [ "${url}/auth/oidc/callback" ];
    logoutCallbackURLs = [ url ];
    consumers = [ "home-assistant" ];
    consumerEnv.secret = "HA_OIDC_CLIENT_SECRET";
  };

  fleet.webApps.home-assistant = {
    inherit hostname;
    # Host netns — no container DNS name to dial. See the header.
    serviceUrl = "http://host.containers.internal:8123";
    exposeRemotely = true;
    # Static, unauthenticated, and cheap — a crisper gatus assertion
    # than "/" (which is a 200 shell regardless of app health).
    healthPath = "/manifest.json";
    homepage = {
      group = "Smart Home";
      name = "Home Assistant";
      description = "Home automation hub";
      icon = "home-assistant.png";
      # Dials the host netns directly rather than through traefik — the
      # widget is machine-to-machine, so it skips ingress like every
      # other widget on the box.
      #
      # No `fields`/`custom`: the defaults (people_home, lights_on,
      # switches_on) are the right three for an install with no devices
      # yet. Phase 2 can name real entities via `custom` — but note that
      # `custom` is ignored while `fields` is set, so use one or the other.
      #
      # HOMEPAGE_VAR_HASS_API_KEY is an empty slot in
      # stacks/homepage/env.sops until Home Assistant has an owner
      # account to mint a long-lived token from; the tile reports an API
      # error until then. Filling it needs no rebuild — `sops` the file
      # and `systemctl restart podman-homepage`.
      widget = {
        type = "homeassistant";
        url = "http://host.containers.internal:8123";
        key = "{{HOMEPAGE_VAR_HASS_API_KEY}}";
      };
    };
  };

  fleet.homepageLayout."Smart Home" = {
    style = "row";
    columns = 4;
    icon = "mdi-home-automation-#94a3b8";
    useEqualHeights = true;
    tab = "Home";
  };

  # Multicast discovery, LAN interface only. Without these the kernel
  # drops mDNS responses and SSDP announcements and zeroconf/ssdp find
  # nothing — see the header. Both are link-local by design; neither is
  # routable off the segment.
  networking.firewall.interfaces.enp3s0.allowedUDPPorts = [
    5353 # mDNS / zeroconf
    1900 # SSDP / UPnP
  ];

  virtualisation.oci-containers.containers.home-assistant = mkRootlessContainer {
    image = "ghcr.io/home-assistant/home-assistant:2026.7.4@sha256:5a531753cea96444200158fc2b0ac7ccd739291ec50414877b396de6e0bb29b3";

    volumes = [
      "${configDir}:/config"
      "${configurationYaml}:/config/configuration.yaml:ro"
      "${oidcAuth}/custom_components/auth_oidc:/config/custom_components/auth_oidc:ro"
    ];

    # HA_DB_URL. HA_OIDC_CLIENT_SECRET is appended by
    # stacks/pocket-id/clients.nix from the `consumers` list above.
    environmentFiles = [ dbEnvFile ];

    extraOptions = [
      "--network=host"
      # Home Assistant's own s6 gracetime is 240s; give it room to flush
      # the recorder queue and close its DB connections rather than
      # being SIGKILLed 10s into a reboot.
      "--stop-timeout=120"
    ];
  };
}
