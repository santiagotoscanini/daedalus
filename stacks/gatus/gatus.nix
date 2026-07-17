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
# State (history DB) persists at ~/selfhost/gatus/data (sqlite) so restarts
# don't wipe the uptime history. LAN-only (status.toscanini.me); no
# exposeRemotely.

{
  config,
  lib,
  pkgs,
  mkRootlessContainer,
  ...
}:

let
  # One probe per published web app, derived from the merged webApps set.
  endpoints = lib.mapAttrsToList (name: w: {
    inherit name;
    group = "web-apps";
    url = "https://${w.hostname}";
    interval = "60s";
    conditions = [
      "[STATUS] < 500"
      "[CERTIFICATE_EXPIRATION] > 168h"
    ];
  }) config.myStack.webApps;

  # gatus reads YAML; JSON is a valid subset, so toJSON avoids quoting pain.
  gatusConfig = pkgs.writeText "gatus.yaml" (
    builtins.toJSON {
      web.port = 8080;
      storage = {
        type = "sqlite";
        path = "/data/data.db";
      };
      metrics = true;
      ui.title = "s2-server · status";
      inherit endpoints;
    }
  );
in
{
  myStack.containerNetworks.gatus = "traefik";

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
      description = "Outside-in uptime + cert expiry";
      icon = "gatus.png";
      widget = {
        type = "gatus";
        url = "http://gatus:8080";
      };
    };
  };

  virtualisation.oci-containers.containers.gatus = mkRootlessContainer {
    image = "docker.io/twinproduction/gatus:v5.36.0";

    environment = {
      GATUS_CONFIG_PATH = "/config/config.yaml";
    };

    volumes = [
      "${gatusConfig}:/config/config.yaml:ro"
      "/home/santiago/selfhost/gatus/data:/data"
    ];

    extraOptions = [
      "--network=traefik-net"
    ];
  };
}
