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
#   - The `dhcp` integration logs `aiodhcpwatcher: Cannot watch for dhcp
#     packets: Operation not permitted` at every start. That is ONE of
#     its five watchers — the passive sniffer, which needs a CAP_NET_RAW
#     packet socket rootless podman cannot grant. DHCP discovery still
#     works: `NetworkWatcher` uses aiodiscover, which sweeps the ARP
#     neighbour table for MAC/IP and resolves hostnames by PTR against
#     the box's resolver, i.e. pi-hole — which is also the LAN's DHCP
#     server, so its leases come back as `<host>.lan`. Being in the host
#     netns is what makes that possible; a bridge netns has no LAN ARP
#     visibility. Losing the sniffer only costs immediacy (discovery on
#     ARP refresh instead of the instant a lease is issued) and devices
#     whose ARP entry has gone stale.
#   - Bluetooth WORKS, via platform/bluetooth's uid-rewriting D-Bus
#     relay — see there for why the obvious approaches do not. The
#     `habluetooth` NET_ADMIN/NET_RAW error still appears at startup and
#     is cosmetic: it disables adapter auto-recovery, not scanning or
#     connecting.
#
# ── Trusted proxy is the HOST address, not the bridge subnet ────────────
# Measured, not assumed: a container on traefik-net dialing
# `host.containers.internal` arrives at a host-netns listener with source
# 192.168.0.2 — pasta SNATs to the host's own LAN address, so the
# 10.89.7.0/24 traefik-net subnet never appears. `trusted_proxies` must
# therefore name the host, and the trust boundary is "anything already
# running on this box", which is exactly who can reach the closed port.
#
# ── The image is built here, not pulled ─────────────────────────────────
# `mkLocalImage` on top of the digest-pinned upstream image, adding the
# Python dependencies the vendored components need that upstream omits
# (`demoji` for local_openai, `python-ember-mug` for ember_mug).
# Everything else they and auth_oidc want — openai, psycopg2, aiofiles,
# jinja2, joserfc — is already in the base. The alternative is
# letting Home Assistant pip-install into /config/deps at startup, which
# works but leaves a version-keyed tree that drifts across Python bumps
# and never appears in the rebuild trail.
#
# Trade-off accepted: the image build now gates container start. Layer
# cache makes an unchanged rebuild ~instant, and the digest-pinned FROM
# resolves locally once pulled, so this does not make boot depend on
# the registry being reachable.
#
# ── Recorder lives on the shared Postgres cluster ───────────────────────
# `fleet.appDatabases.home_assistant`. psycopg2 (2.9.12) comes from the
# upstream image — but transitively, not declared in recorder's
# manifest, so a version bump should re-check it (`podman run --rm
# --entrypoint /bin/sh <image> -c 'python3 -c "import psycopg2"'`).
# The bootstrap's DATABASE_URL points
# at `pg:5432`, a bridge name this container cannot resolve, so
# home-assistant-db-env below re-renders it against the cluster's
# plain-TCP host port on loopback.
#
# Long-term statistics (the 5-minute/hourly rollups the Energy and
# History dashboards read) are kept for years regardless of recorder's
# 10-day `purge_keep_days` default, so the default is left alone.
#
# ── configuration.yaml is an asset; UI-authored YAML is not ─────────────
# The core config lives at assets/configuration.yaml — a real file, like
# every other config on the box (litellm, traefik, registry). Nix only
# substitutes the handful of `@name@` placeholders whose values it
# already knows (timezone, URL, LAN IP, traefik subnet, issuer), then
# parses the result before the container can see it. Changing Home
# Assistant's core config means editing that file and rebuilding; it is
# bind-mounted read-only from the store.
#
# The three `!include`s point at writable files in /config that the UI
# automation/script/scene editors own — pre-created by fleet.statePaths
# so a fresh restore starts with valid includes.
#
# Secrets never land in the config file: Home Assistant's YAML loader
# supports `!env_var`, so the recorder URL and the OIDC client secret
# come in through environmentFiles and stay out of the store.
#
# ── Custom components are vendored, not installed ───────────────────────
# All live-mounted read-only from pinned fetchFromGitHub trees rather
# than through HACS, which is a runtime package manager and the opposite
# of the rest of this repo. Nothing is fetched or pip-installed at
# runtime; their dependencies are in the image (see above).
#   auth_oidc      — Pocket ID SSO (below)
#   local_openai   — Assist against the LiteLLM gateway
#   ember_mug      — BLE mug; needs an ACTIVE connection, so it is the
#                    reason the D-Bus relay forwards file descriptors
#
# ── SSO ─────────────────────────────────────────────────────────────────
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
  mkLocalImage,
  mkRootlessContainer,
  mkSecretRender,
  ...
}:

let
  hostname = "homeassistant.${config.fleet.baseDomain}";
  url = "https://${hostname}";

  configDir = "/home/santiago/selfhost/home-assistant/config";

  # Derived image — see assets/image/Containerfile, which is where the
  # upstream version + digest are pinned. `tagPrefix` only makes the
  # built tag readable; keep it in step with the FROM there.
  haImage = mkLocalImage {
    name = "home-assistant-llm";
    tagPrefix = "2026.7.4";
    contextDir = ./assets/image;
    gates = [ "podman-home-assistant.service" ];
  };

  # Pocket ID OIDC client/RP. Pinned tag; the hash covers the unpacked
  # tree, so bumping the rev without the hash fails the build.
  oidcAuth = pkgs.fetchFromGitHub {
    owner = "christiaangoossens";
    repo = "hass-oidc-auth";
    rev = "v1.1.1";
    hash = "sha256-d1nRSAR4HAoW+gpAtyb0s6bh40CcoT59dgVOkwKHavU=";
  };

  # Conversation agent against an OpenAI-compatible endpoint — here the
  # LiteLLM gateway, so Assist rides the same cost tracking, key auth
  # and model routing as everything else on the box. Home Assistant's
  # BUILT-IN openai_conversation cannot do this: it has no base_url
  # option at all (grep the component — hence upstream discussion
  # #3398), so a third-party client is the only path to a local model
  # through the gateway.
  #
  # Vendored from a pinned tag, same as auth_oidc: no HACS, nothing
  # fetched at runtime.
  localOpenai = pkgs.fetchFromGitHub {
    owner = "skye-harris";
    repo = "hass_local_openai_llm";
    rev = "1.9.0";
    hash = "sha256-z5O+G5OtsC82rRjf3hAbfD5MON62AajBolCKfbo31X0=";
  };

  # Ember mug — a BLE device that must be CONNECTED to, not merely
  # listened for (iot_class local_polling). It therefore depends on the
  # fd-passing half of platform/bluetooth's relay: BlueZ hands out a
  # descriptor for GATT notifications, and dbus-fast raises rather than
  # falling back if that cannot be negotiated.
  #
  # ── If the mug will not connect, read this before debugging ──────────
  # Two upstream quirks, both documented in the component's README, both
  # of which cost hours here on 2026-08-01:
  #
  # 1. The mug serves exactly ONE central. While a phone has it, every
  #    connection attempt from here fails with a bare TimeoutError that
  #    looks like a range or driver problem and is not. Turn off the
  #    phone's Bluetooth (the README says forget the device entirely).
  #    Note the mug still advertises as CONNECTABLE (PDU 0x0013) while
  #    the slot is taken, so the advertising flags prove nothing.
  #
  # 2. Once the slot is free, the first connection still fails with
  #    `GATT Protocol Error: Unlikely Error` (ATT 0x0e) and the mug
  #    hanging up — `org.bluez.Reason.Remote`. The README's fix is
  #    literal and strange: leave an IDLE `bluetoothctl` session open
  #    while the mug is in pairing mode, type nothing, and wait. It
  #    registers a BlueZ agent and takes the adapter out of a passive
  #    mode the author never found a programmatic way to leave.
  #    Piping commands into bluetoothctl does NOT work — the session
  #    must stay open:
  #
  #      sleep 150 | sudo bluetoothctl
  #
  # After that the integration polls happily on its own. Expect to
  # repeat step 2 if the mug is ever fully reset or re-paired to a
  # phone.
  emberMug = pkgs.fetchFromGitHub {
    owner = "sopelj";
    repo = "hass-ember-mug-component";
    rev = "1.5.0";
    hash = "sha256-mLQ9rtGqO5plIZOlEJ4RlHmaMHy46Mr+l3USDB3SlNw=";
  };

  # Not /run/home-assistant: systemd wipes a RuntimeDirectory named
  # after a unit when that unit stops, which would silently empty the
  # rendered file underneath the running container.
  dbEnvDir = "/run/home-assistant-db";
  dbEnvFile = "${dbEnvDir}/env";
  promTokenDir = "/run/home-assistant-prom-token";

  # The YAML itself lives at assets/configuration.yaml — the fleet
  # convention for a real config file (litellm, traefik, registry all do
  # this). `writeText` is reserved here for configs COMPUTED from nix
  # data, which this is not: it is a static document with five values
  # substituted in, each of which is already a fact nix knows.
  substitutedConfigurationYaml = pkgs.replaceVars ./assets/configuration.yaml {
    inherit (config.time) timeZone;
    inherit url;
    inherit (config.fleet) lanIp;
    traefikSubnet = config.fleet.bridgeSubnets.traefik;
    inherit (config.fleet.sso) issuerUrl;
  };

  # The file the container actually mounts: byte-identical to the
  # substituted asset, but only produced if it parses. Schema validation
  # is out of reach in a nix build (it needs a live Home Assistant with
  # every integration importable) — this is the syntax half, which is
  # the half an edited-and-substituted file gets wrong.
  configurationYaml =
    pkgs.runCommand "home-assistant-configuration-checked.yaml"
      {
        nativeBuildInputs = [ (pkgs.python3.withPackages (ps: [ ps.pyyaml ])) ];
      }
      ''
        python3 ${./assets/check-config-yaml.py} ${substitutedConfigurationYaml}
        cp ${substitutedConfigurationYaml} $out
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
    # Mountpoints for the vendored components below — declared so a
    # fresh restore has them santiago-owned rather than podman-created.
    "${configDir}/custom_components" = { };
    "${configDir}/custom_components/auth_oidc" = { };
    "${configDir}/custom_components/local_openai" = { };
    "${configDir}/custom_components/ember_mug" = { };
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
  systemd.services.home-assistant-image-build = haImage.service;

  # The Bluetooth integration probes the bus during startup; without
  # this the relay may not be listening yet and Bluetooth comes up
  # disabled until something restarts the container.
  systemd.services.podman-home-assistant = {
    after = [ "ha-dbus-relay.service" ];
    wants = [ "ha-dbus-relay.service" ];
  };

  systemd.services.home-assistant-db-env = mkSecretRender {
    description = "Render the Home Assistant recorder DB URL for the host netns";
    gates = [ "podman-home-assistant.service" ];
    after = [ "app-db-home_assistant-bootstrap.service" ];
    wants = [ "app-db-home_assistant-bootstrap.service" ];
    dir = dbEnvDir;
    file = dbEnvFile;
    prep = ''
      DB_PWD=$(grep '^POSTGRES_PASSWORD=' ${config.fleet.appDatabases.home_assistant.envFile} | head -1 | cut -d= -f2-)
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

  # Pocket ID client — id `home-assistant`, secret generated on the box,
  # rendered
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
    # Built by home-assistant-image-build below; the tag carries the
    # build-context hash, so changing the base digest or the pinned
    # demoji version produces a new tag and restarts this container.
    # Upstream's digest lives in haBaseDigest, not here.
    inherit (haImage) image;

    volumes = [
      "${configDir}:/config"
      "${configurationYaml}:/config/configuration.yaml:ro"
      "${oidcAuth}/custom_components/auth_oidc:/config/custom_components/auth_oidc:ro"
      "${localOpenai}/custom_components/local_openai:/config/custom_components/local_openai:ro"
      "${emberMug}/custom_components/ember_mug:/config/custom_components/ember_mug:ro"
      # BlueZ lives on the D-Bus SYSTEM bus, so Bluetooth needs a socket
      # rather than a device node. NOT the real /run/dbus: this
      # container claims uid 0 while the bus sees santiago, and D-Bus
      # rejects that mismatch outright. ha-dbus-relay (platform/bluetooth)
      # re-presents the bus with a matching uid. Mounted rw — connecting
      # to a unix socket needs write permission on the socket inode.
      "/run/ha-dbus:/run/ha-dbus"
    ];

    environment = {
      # Point every D-Bus client in the container at the uid-rewriting
      # relay instead of the real bus (see the volume above).
      DBUS_SYSTEM_BUS_ADDRESS = "unix:path=/run/ha-dbus/bus";
    };

    # HA_DB_URL. HA_OIDC_CLIENT_SECRET is appended by
    # stacks/pocket-id/clients.nix from the `consumers` list above.
    environmentFiles = [ dbEnvFile ];

    extraOptions = [
      "--network=host"
      # NOT --cap-add=NET_ADMIN/NET_RAW, though Home Assistant's repair
      # notification asks for exactly that. Tried and reverted:
      # --cap-add really does set the bits (CapEff 0x800405fb ->
      # 0x800435fb, bits 12/13) and the mgmt socket then binds — but the
      # error is unchanged, because the kernel's Bluetooth mgmt handlers
      # test capable(CAP_NET_ADMIN) against the INITIAL user namespace,
      # which a rootless container can never satisfy. habluetooth
      # detects this from the MGMT reply status (0x14 permission denied),
      # not by reading the capability bits, so setting them only adds
      # privilege without changing behaviour.
      #
      # What it costs: adapter auto-recovery (resetting a wedged
      # controller). NOT scanning and NOT connecting — both go through
      # BlueZ's D-Bus API and demonstrably work. The repair is safe to
      # Ignore in the UI; it is unfixable under rootless podman.
      # Home Assistant's own s6 gracetime is 240s; give it room to flush
      # the recorder queue and close its DB connections rather than
      # being SIGKILLed 10s into a reboot.
      "--stop-timeout=120"
    ];
  };
}
