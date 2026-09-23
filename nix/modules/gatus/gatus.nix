# gatus — outside-in uptime + TLS-expiry probing.
#
# Everything else on this box watches from the INSIDE (node-exporter,
# container_up). gatus is the one component that probes the
# published HTTPS surface the way a client on the LAN would: DNS →
# traefik → cert → upstream. If traefik wedges, a cert fails to renew,
# or a router breaks, the internal metrics can still look green while
# every browser gets an error — gatus is what catches that.
#
# ── Endpoint list is generated, never hand-maintained ───────────────────
# The probe set is built from `config.fleet.webApps` at eval time (same
# drift-proofing idea as the container_up exporter): every published web
# app is probed automatically the moment its stack adds a webApps entry.
# Each endpoint asserts two things:
#   [STATUS] < 500            — traefik routed us to a live upstream
#                               (lenient on 2xx/3xx/4xx: many apps redirect
#                               to a login or 401 without being "down").
#   [CERTIFICATE_EXPIRATION] > 168h — the wildcard cert has >7 days left,
#                               so a stalled ACME renewal pages before expiry.
#
# ── DNS: default aardvark path resolves the public hostnames ────────────
# gatus is on traefik-net, so podman gives it aardvark-dns as its resolver.
# aardvark runs in the HOST netns and forwards non-container queries to the
# host's resolv.conf (127.0.0.1 = pi-hole on this box), so `*.<baseDomain>`
# resolves to the LAN address via the same dnsHosts short-circuit every LAN
# client uses — gatus then hits traefik at <lanIp>:443. (Do NOT force
# --dns=<lanIp>: that bypasses aardvark and dials pi-hole straight from
# the bridge subnet — probes were observed timing out that way; the
# resolv.conf chain is the supported path.)
#
# ── Alerting deliberately left unconfigured ─────────────────────────────
# gatus can alert on its own (email/slack/etc.), but Grafana owns
# alerting on this box — the prometheus scrape below feeds gatus
# results into the same rules + email contact point as everything
# else: one alert path instead of two. Add `alerting:` + per-endpoint
# `alerts:` only if gatus must page independently of Grafana.
#
# Uptime history lives in the `gatus` database on the shared app-db
# cluster (modules/app-db) so restarts don't wipe it. LAN-only
# (`status.<baseDomain>` by default); no exposeRemotely.
#
# The host brings:
#   fleet.modules.gatus.enable            the switch (default off, as every catalog module)
#   fleet.modules.gatus.allowedSubjects   who may open the dashboard: IdP subject ids (required)
#   fleet.modules.gatus.envSopsFile       credentials the probes' healthHeaders expand (optional)
#   fleet.images.gatus                    the digest-pinned image

{
  config,
  lib,
  pkgs,
  mkDotenvSecret,
  mkRootlessContainer,
  pinnedImage,
  ...
}:

let
  cfg = config.fleet.modules.gatus;

  haveEnv = cfg.envSopsFile != null;

  # One probe per published web app, derived from the merged webApps
  # set. oidc-gated apps declare `healthPath` (bypassed from the auth
  # middleware) so the probe reaches the real upstream — a bare "/"
  # would be 302'd to Pocket ID and certify the IdP instead.
  webAppEndpoints = lib.mapAttrsToList (
    name: w:
    {
      inherit name;
      group = "web-apps";
      url = "https://${w.hostname}${if w.healthPath != null then w.healthPath else "/"}";
      interval = "60s";
      conditions = [
        "[STATUS] < 500"
        "[CERTIFICATE_EXPIRATION] > 168h"
      ];
    }
    // lib.optionalAttrs (w.healthHeaders != { }) { headers = w.healthHeaders; }
  ) config.fleet.webApps;

  # Services this box DEPENDS on that are not published by it, so there is no
  # webApps entry to derive a probe from. Hand-written, and short on purpose:
  # the generated list above is the rule and this is the documented exception.
  #
  # No CERTIFICATE_EXPIRATION condition — these are plain HTTP on the LAN, and
  # gatus reports a failed condition rather than skipping an inapplicable one.
  #
  # One per node that offers a model server (platform/nodes.nix, from
  # site/nodes.json): a host with none has an empty list rather than a probe
  # of nowhere. The first keeps the name the probe has always had, so the
  # rule and the dot on daedalus's AI → Lemonade tab keep their series; a
  # second node's probe is named after the node.
  offBoxEndpoints = lib.imap0 (i: node: {
    # The model server on a node (lemonade.md in the configuration repo).
    # Every AI workload on this box terminates there, and until this probe
    # nothing watched it: LiteLLM stays green while returning errors, so a
    # Lemonade outage surfaced as "the chat is broken" rather than as an
    # alert. Feeds the same gatus_results_endpoint_success rule as everything
    # else.
    name = if i == 0 then "lemonade" else "lemonade-${node.name}";
    group = "off-box";
    url = "http://${config.fleet.nodeHost node}:${toString node.providers.lemonade.port}/api/v1/health";
    interval = "60s";
    conditions = [
      "[STATUS] == 200"
      # Not just "it answered": the health document reports per-model backend
      # state, and a server whose backends have all died still returns 200.
      "[BODY].status == ok"
    ];
  }) config.fleet.lemonadeNodes;

  endpoints = webAppEndpoints ++ offBoxEndpoints;

  # gatus reads YAML; JSON is a valid subset, so toJSON avoids quoting pain.
  gatusConfig = pkgs.writeText "gatus.yaml" (
    builtins.toJSON {
      web.port = 8080;
      # Uptime history on the shared app-db cluster; the password
      # placeholder expands from the app-db bootstrap env file.
      storage = {
        type = "postgres";
        path = "postgres://gatus:\${POSTGRES_PASSWORD}@pg:5432/gatus?sslmode=disable";
      };
      metrics = true;
      ui.title = "${config.networking.hostName} · status";
      # Pocket ID SSO (AUTH.md). gatus expands ''${VAR} from its env at
      # load — creds come from env.sops, never the /nix/store YAML.
      # allowed-subjects is MANDATORY: without it any account at the IdP
      # gets in. The host names them (fleet.modules.gatus.allowedSubjects).
      security.oidc = {
        issuer-url = config.fleet.sso.issuerUrl;
        client-id = "\${GATUS_OIDC_CLIENT_ID}";
        client-secret = "\${GATUS_OIDC_CLIENT_SECRET}";
        redirect-url = "https://${config.fleet.webApps.gatus.hostname}/authorization-code/callback";
        scopes = [ "openid" ];
        allowed-subjects = cfg.allowedSubjects;
      };
      inherit endpoints;
    }
  );
in
{
  options.fleet.modules.gatus = {
    enable = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Gatus — outside-in uptime and TLS-expiry probing of every published hostname.";
    };

    allowedSubjects = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      example = [ "1ae66034-d627-46f7-9c04-1d8c05639a1a" ];
      description = ''
        Identity-provider subject ids (the `sub` claim, a UUID at Pocket ID)
        allowed to open the dashboard. Policy, and the host's: gatus's own OIDC
        gate admits ANY account at the provider without this list, so there
        is no default — a host names its operator, and the id is on the
        account's page at the provider.
      '';
    };

    envSopsFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      example = lib.literalExpression "./host/sops/gatus/env.sops";
      description = ''
        sops-encrypted dotenv of credentials that probes need: a
        `fleet.webApps.<n>.healthHeaders` value may name a variable, expanded
        by gatus from its environment, and this file is where such a VAR
        lives (an API key a health endpoint demands, say). Null when no
        probe needs one.
      '';
    };
  };

  config = lib.mkIf config.fleet.modules.gatus.enable {
    fleet.bridgeMemberships.gatus = [
      "traefik"
      "app-db"
    ];

    # Database on the shared app-db cluster (modules/app-db).
    fleet.appDatabases.gatus.consumers = [ "gatus" ];
    # gatus PANICS if OIDC discovery fails at startup, taking the whole
    # probe layer down behind a green oneshot unit.
    fleet.sso.discoveryConsumers = [ "gatus" ];

    sops.secrets."gatus-env" = lib.mkIf haveEnv (mkDotenvSecret cfg.envSopsFile);

    # Pocket ID client — id `gatus`, secret generated on the box,
    # rendered into the container as the
    # GATUS_OIDC_* pair that config.yaml interpolates. PKCE stays off:
    # gatus's built-in OIDC client doesn't send a code verifier.
    fleet.ssoClients.gatus = {
      description = "Outside-in uptime + cert expiry";
      launchURL = "https://${config.fleet.webApps.gatus.hostname}/oidc/login";
      callbackURLs = [ "https://${config.fleet.webApps.gatus.hostname}/authorization-code/callback" ];
      logoutCallbackURLs = [
        "https://${config.fleet.webApps.gatus.hostname}/authorization-code/callback"
      ];
      pkce = false;
      consumers = [ "gatus" ];
      consumerEnv = {
        id = "GATUS_OIDC_CLIENT_ID";
        secret = "GATUS_OIDC_CLIENT_SECRET";
      };
    };

    fleet.webApps.gatus = {
      # `status` is the conventional label; a host that wants another defines
      # `fleet.webApps.gatus.hostname` itself.
      hostname = lib.mkDefault "status.${config.fleet.baseDomain}";
      serviceName = "gatus";
      port = 8080;
      # LAN-only: uptime dashboard is operator-facing.
      # gatus exports results_* series (per-endpoint success, response
      # time, cert expiry).
      metrics.enable = true;
    };

    virtualisation.oci-containers.containers.gatus = mkRootlessContainer {
      image = pinnedImage "gatus" "docker.io/twinproduction/gatus";

      environment = {
        GATUS_CONFIG_PATH = "/config/config.yaml";
      };

      # The probe credentials (envSopsFile), when the host has any; the OIDC
      # client pair arrives from the identity provider's render (consumers).
      environmentFiles = lib.optional haveEnv config.sops.secrets."gatus-env".path ++ [
        config.fleet.appDatabases.gatus.envFile
      ];

      volumes = [
        "${gatusConfig}:/config/config.yaml:ro"
      ];
    };
  };
}
