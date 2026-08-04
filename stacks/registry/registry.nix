# stacks/registry — zot, the box's own OCI registry.
#
# The apps pipeline's rendezvous point: CI (gha-runner stack) builds
# images and pushes them here over the private `registry` bridge
# (http://zot:5000 — never leaves podman networking); the apps
# platform's deploy timers and containers pull anonymously via
# https://registry.toscanini.me (traefik, wildcard TLS). GHCR is out
# of the deploy loop entirely — recovery note: images live ONLY here
# (rpool/selfhost snapshots + syncoid mirror); after a total box loss
# each app needs one CI re-run before it can deploy.
#
# Auth model (three doors, one house):
#   - podman/CI protocol traffic: htpasswd basic auth. The `ci` user
#     (env.sops) is the only writer; its password is mirrored into the
#     GitHub repo secrets the workflows read. Anonymous = pull-only
#     (accessControl anonymousPolicy) — that's what lets deploy timers
#     and app containers pull with zero credentials. NOTE: zot
#     deliberately rejects anonymous DOCKER-CLI pulls when auth is
#     configured (UA-sniffing workaround, zot PR #3868); podman is
#     unaffected, and everything on this box is podman.
#   - browser UI: native Pocket ID OIDC (generic "oidc" provider —
#     confidential client, no PKCE: zot only does PKCE for public
#     clients). Client registered via the Pocket ID API; id+secret in
#     env.sops. Callback: <externalUrl>/zot/auth/callback/oidc.
#   - apikey extension is on: a logged-in UI user can mint per-purpose
#     basic-auth API keys if ever needed.
#
# Push events: the `events` extension POSTs every registry event to
# daedalus (https://daedalus.toscanini.me/api/deploy), which turns an
# image push into an immediate redeploy instead of waiting up to two
# minutes for that app's poll timer. Authenticated with
# DEPLOY_HOOK_TOKEN from env.sops, sent as X-Deploy-Token.
#
# Why through traefik rather than a shared podman bridge: the obvious
# bridge, registry-net, also carries the gha-runner containers, and
# putting daedalus there would hand workflow code a network path to the
# thing that can rebuild the system. Going via traefik keeps daedalus
# `isolated` (only traefik reaches it) and narrows the forward-auth
# bypass to that one path — so a compromised zot gains "can trigger a
# deploy", nothing more.
#
# zot has no event-type filter, so daedalus receives deletes and
# manifest reads too and decides what to act on. Over-triggering is
# cheap: app-<name>-deploy.service compares digests and no-ops when
# nothing moved.
#
# Config is RENDERED at boot (mkSecretRender: OIDC id/secret + a
# bcrypt htpasswd hashed from env.sops) to /run/registry/ — NOT
# /run/zot: that's the container unit's RuntimeDirectory and systemd
# wipes it on container stop (the nextcloud-redis trap).
#
# Retention is declared but DRY-RUN: zot's retention/GC corner has
# history (mass-expiry on metaDB rebuild #4233, per-repo inconsistency
# #3804). Watch `journalctl -u podman-zot | grep retention` for a few
# cycles; flip dryRun to false once the would-delete list looks right.
# meta.db (push/pull timestamps retention depends on) lives with the
# blobs in the state dir — never prune metadata files independently.
# GC of orphan blobs runs for real even in dry-run.
#
# readTimeout/writeTimeout are raised from zot's 60s default — a
# single blob PATCH slower than the timeout aborts the whole upload
# (#4079). Registry pushes must never ride the CF tunnel (100 MB
# request-body cap): CI pushes stay on the bridge, human pulls on LAN
# websecure.
#
# v2.2.0 WARNING: a breaking on-disk storage refactor is queued
# upstream. Stay on v2.1.x digests until its migration notes are read
# (update-images will surface the bump; don't take it blind).

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
  # Digest of ghcr.io/project-zot/zot:v2.1.18 (full image: ui, search,
  # metrics, scrub — the -minimal variant has none of those).
  zotImage = "ghcr.io/project-zot/zot:v2.1.18@sha256:34f18f783037f967dba10df02f9d4086c4d626f5643ef9f5e51e4a4547280a0b";

  dataDir = "/home/santiago/selfhost/registry";

in
{
  sops.secrets."registry-env" = mkDotenvSecret ./env.sops;

  # `registry` bridge: zot + the gha-runner containers (which add the
  # membership by hand — they're not oci-containers, see that stack).
  # traefik secondary for the webApps serviceName route.
  fleet.bridgeMemberships.zot = [
    "registry"
    "traefik"
  ];

  fleet.statePaths.${dataDir} = { };

  # zot PANICS if OIDC discovery fails at startup, and the dead container
  # hides behind a green oneshot unit — which silently stops the whole
  # deploy loop, since app-*-deploy can no longer pull from here.
  fleet.sso.discoveryConsumers = [ "zot" ];

  fleet.webApps.registry = {
    serviceName = "zot";
    port = 5000;
    # Anonymous read makes /v2/ answer 200 unauthenticated — gatus
    # probes the real registry API, not just the UI shell.
    healthPath = "/v2/";
  };

  fleet.logStacks.registry = [ "zot" ];

  # Pocket ID client — id `zot`, secret SSO_SECRET_ZOT in
  # stacks/pocket-id/clients.sops. Not group-restricted: anonymous pull
  # is the point, and the browser UI is the only thing OIDC covers.
  # PKCE off — zot's generic oidc provider sends no verifier.
  fleet.ssoClients.zot = {
    displayName = "Zot";
    allowedGroups = [ ];
    callbackURLs = [ "https://${config.fleet.webApps.registry.hostname}/zot/auth/callback/oidc" ];
    pkce = false;
    # The creds feed the config render below, not the container's
    # environment — but listing the consumer is still what gates the
    # render on zot's unit and keeps the ordering honest.
    consumers = [ "zot" ];
    consumerEnv.id = "OIDC_CLIENT_ID";
  };

  # assets/config.json is a template in the readFile'd-body house
  # style: its ${VARS} expand in the render heredoc — OIDC_CLIENT_ID /
  # OIDC_CLIENT_SECRET from the declarative client's rendered env file,
  # the rest from env.sops, SSO_ISSUER injected here.
  systemd.services.registry-config-render = mkSecretRender {
    description = "Render zot config + htpasswd from registry-env";
    gates = [ "podman-zot.service" ];
    # Both renders gate on zot; only this edge orders them.
    after = [ "sso-zot-env-render.service" ];
    dir = "/run/registry";
    file = "/run/registry/config.json";
    prep = ''
      SSO_ISSUER=${lib.escapeShellArg config.fleet.sso.issuerUrl}
      set -a
      . ${config.sops.secrets."registry-env".path}
      . ${config.fleet.ssoClients.zot.envFile}
      set +a
      {
        ${pkgs.apacheHttpd}/bin/htpasswd -nbB "$REGISTRY_CI_USER" "$REGISTRY_CI_PASSWORD"
        ${pkgs.apacheHttpd}/bin/htpasswd -nbB prometheus "$REGISTRY_PROM_PASSWORD"
      } | install -m 0400 -o santiago -g users /dev/stdin /run/registry/htpasswd
    '';
    content = builtins.readFile ./assets/config.json;
  };

  # /metrics requires auth once auth is configured (zot >= 2.1.18), so
  # the plain webApps scrape can't be used. Own render dir — the
  # prometheus container must not see /run/registry (htpasswd + OIDC
  # secret live there).
  systemd.services.registry-prom-password = mkSecretRender {
    description = "Render zot scrape password for prometheus";
    gates = [ "podman-prometheus.service" ];
    dir = "/run/registry-prom";
    file = "/run/registry-prom/password";
    prep = ''
      . ${config.sops.secrets."registry-env".path}
    '';
    content = "\${REGISTRY_PROM_PASSWORD}";
  };

  virtualisation.oci-containers.containers.prometheus.volumes = [
    "/run/registry-prom:/run/secrets/registry-prom:ro"
  ];

  # Prometheus on traefik-net scrapes zot by container DNS, as the
  # htpasswd `prometheus` user (any authenticated identity may read
  # /metrics).
  fleet.prometheusScrapes = [
    {
      job_name = "registry";
      basic_auth = {
        username = "prometheus";
        password_file = "/run/secrets/registry-prom/password";
      };
      static_configs = [ { targets = [ "zot:5000" ]; } ];
    }
  ];

  virtualisation.oci-containers.containers.zot = mkRootlessContainer {
    image = zotImage;
    volumes = [
      "/run/registry/config.json:/etc/zot/config.json:ro"
      "/run/registry/htpasswd:/etc/zot/htpasswd:ro"
      "${dataDir}:/var/lib/zot"
    ];
  };
}
