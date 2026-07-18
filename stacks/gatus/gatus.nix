# gatus — outside-in uptime + TLS-expiry probing.
#
# Everything else on this box watches from the INSIDE (node-exporter,
# container_up, cadvisor). gatus is the one component that probes the
# published HTTPS surface the way a client on the LAN would: DNS →
# traefik → cert → upstream. If traefik wedges, a cert fails to renew,
# or a router breaks, the internal metrics can still look green while
# every browser gets an error — gatus is what catches that.
#
# ── Endpoint list is generated, never hand-maintained ───────────────────
# The probe set is built from `config.myStack.webApps` at eval time (same
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
# host's resolv.conf (127.0.0.1 = pi-hole on this box), so `*.toscanini.me`
# resolves to 192.168.0.2 via the same dnsHosts short-circuit every LAN
# client uses — gatus then hits traefik at 192.168.0.2:443. (Do NOT force
# --dns=192.168.0.2: that bypasses aardvark and hits pi-hole from the bridge
# subnet, which pi-hole's LOCAL listening mode drops → every probe times out.)
#
# ── Alerting deliberately left unconfigured ─────────────────────────────
# gatus can alert on its own (email/slack/etc.), but Grafana owns
# alerting on this box — the prometheus scrape below feeds gatus
# results into the same rules + email contact point as everything
# else: one alert path instead of two. Add `alerting:` + per-endpoint
# `alerts:` only if gatus must page independently of Grafana.
#
# Uptime history lives in the `gatus` database on the shared app-db
# cluster (stacks/app-db) so restarts don't wipe it. LAN-only
# (status.toscanini.me); no exposeRemotely.

{
  config,
  lib,
  pkgs,
  mkDotenvSecret,
  mkRootlessContainer,
  ...
}:

let
  # One probe per published web app, derived from the merged webApps
  # set. oidc-gated apps declare `healthPath` (bypassed from the auth
  # middleware) so the probe reaches the real upstream — a bare "/"
  # would be 302'd to Pocket ID and certify the IdP instead.
  endpoints = lib.mapAttrsToList (
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
  ) config.myStack.webApps;

  # gatus reads YAML; JSON is a valid subset, so toJSON avoids quoting pain.
  gatusConfig = pkgs.writeText "gatus.yaml" (
    builtins.toJSON {
      web.port = 8080;
      # Uptime history on the shared app-db cluster; the password
      # placeholder expands from the app-db bootstrap env file. Fresh
      # history at migration (2026-07-18) — gatus has no sqlite->pg
      # migration path; config regenerates from nix either way.
      storage = {
        type = "postgres";
        path = "postgres://gatus:\${POSTGRES_PASSWORD}@pg:5432/gatus?sslmode=disable";
      };
      metrics = true;
      ui.title = "s2-server · status";
      # Pocket ID SSO (AUTH.md). gatus expands ''${VAR} from its env at
      # load — creds come from env.sops, never the /nix/store YAML.
      # allowed-subjects is MANDATORY: without it any Pocket ID account
      # gets in. Value = santito's sub UUID.
      security.oidc = {
        issuer-url = "https://id.toscanini.me";
        client-id = "\${GATUS_OIDC_CLIENT_ID}";
        client-secret = "\${GATUS_OIDC_CLIENT_SECRET}";
        redirect-url = "https://status.toscanini.me/authorization-code/callback";
        scopes = [ "openid" ];
        allowed-subjects = [ "1ae66034-d627-46f7-9c04-1d8c05639a1a" ];
      };
      inherit endpoints;
    }
  );
in
{
  myStack.containerNetworks.gatus = [
    "traefik"
    "app-db"
  ];

  # Database on the shared app-db cluster (see stacks/app-db/).
  myStack.appDatabases.gatus.consumers = [ "gatus" ];
  # Also order after traefik + pocket-id: gatus fetches the OIDC
  # discovery document at startup and PANICS if id.toscanini.me is
  # unreachable — during a fleet-wide restart that leaves the unit
  # "Finished" with a dead container (the documented oneshot trap).
  systemd.services.podman-gatus = {
    after = [
      "podman-traefik.service"
      "podman-pocket-id.service"
    ];
    wants = [
      "podman-traefik.service"
      "podman-pocket-id.service"
    ];
  };

  # GATUS_OIDC_CLIENT_ID + GATUS_OIDC_CLIENT_SECRET (Pocket ID SSO):
  # sops-encrypted env.sops. Edit with `sops env.sops`.
  sops.secrets."gatus-env" = mkDotenvSecret ./env.sops;

  myStack.webApps.gatus = {
    hostname = "status.toscanini.me";
    serviceName = "gatus";
    port = 8080;
    # LAN-only: uptime dashboard is operator-facing.
    # gatus exports results_* series (per-endpoint success, response
    # time, cert expiry).
    metrics.enable = true;
    homepage = {
      group = "Monitoring";
      # /oidc/login skips gatus's hard-coded "Login with OIDC" button
      # page — silent round-trip through Pocket ID when a session is
      # alive (no auto-redirect option upstream).
      href = "https://status.toscanini.me/oidc/login";
      description = "Outside-in uptime + cert expiry";
      icon = "gatus.png";
      widget = {
        # NOT type=gatus: OIDC security gates gatus's own API (no token
        # concept), so the native widget can't authenticate. /metrics
        # stays open — mirror the native widget's up/down/uptime trio
        # from prometheus instead.
        type = "prometheusmetric";
        url = "http://prometheus:9090";
        refreshInterval = 60000;
        metrics = [
          {
            label = "Up";
            query = "count(gatus_results_endpoint_success == 1) or vector(0)";
          }
          {
            label = "Down";
            query = "count(gatus_results_endpoint_success == 0) or vector(0)";
          }
          {
            label = "Uptime (24h)";
            query = "100 * avg(avg_over_time(gatus_results_endpoint_success[24h]))";
            format = {
              type = "number";
              suffix = "%";
              options = {
                maximumFractionDigits = 2;
              };
            };
          }
        ];
      };
    };
  };

  virtualisation.oci-containers.containers.gatus = mkRootlessContainer {
    image = "docker.io/twinproduction/gatus:v5.36.0@sha256:c5f210d095fa78e6efaa20ffeb14803f2ba4f10615e16a6d12087697149617f0";

    environment = {
      GATUS_CONFIG_PATH = "/config/config.yaml";
    };

    # GATUS_OIDC_CLIENT_ID + GATUS_OIDC_CLIENT_SECRET: sops-encrypted
    # env.sops, decrypted to /run/secrets/gatus-env at activation.
    environmentFiles = [
      config.sops.secrets."gatus-env".path
      config.myStack.appDatabases.gatus.envFile
    ];

    volumes = [
      "${gatusConfig}:/config/config.yaml:ro"
    ];
  };
}
