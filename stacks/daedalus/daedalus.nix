# daedalus — the box's own control plane, and the only app here that is not
# built by CI.
#
# Everything else on the apps platform rides the registry loop: push to main,
# CI builds an image, zot hosts it, `app-<name>-deploy.timer` pulls it. daedalus
# uses `source.mode = "local"` instead — its source sits next to this file at
# ./app, the container bind-mounts that directory at /app, and runs the Vite dev
# server against it. Saving a file IS the deploy: no commit, no CI, no pull, no
# rebuild.
#
# What that buys and what it costs:
#   + Edit-to-browser in under a second, from anywhere with a shell on the box.
#   + The app's history is the flake's history — one repo, one commit trail.
#   - No production build. Dev-server performance, forever, on purpose: this is
#     a single-operator admin UI, not something that serves load.
#   - `pnpm install --frozen-lockfile` runs at every container start, so
#     Verdaccio (and, cold, its npmjs uplink) is a hard startup dependency.
#     First boot after a fresh restore takes minutes; the unit is Type=oneshot
#     so it goes green immediately while Vite is still starting, and gatus is
#     red until it listens. Expected, not a fault.
#
# ⚠ /etc/nixos lives on rpool/root, which has NO ZFS snapshots and is NOT in
# the syncoid mirror (unlike /home/santiago/selfhost). The only copy of this
# app's source outside this disk is what has been pushed to the nixos-s2 git
# remote. Commit often.
#
# Which rebuilds matter:
#   ./app/**            → nothing. Vite is watching it.
#   ./app/package.json  → `systemctl restart podman-app-daedalus` (re-installs).
#   ./assets/**         → nixos-rebuild (context hash → new image tag → restart).
#   this file           → nixos-rebuild.

{ config, mkSecretRender, ... }:

{
  fleet.apps.daedalus = {
    source = {
      mode = "local";
      # A plain string, not `./app` — a nix path literal would be copied into
      # /nix/store and the container would watch a frozen snapshot, which is
      # exactly the failure this whole design exists to avoid.
      path = "/etc/nixos/stacks/daedalus/app";
      contextDir = ./assets;
    };

    # Role + database `daedalus` on the shared pg cluster (stacks/app-db),
    # REVOKE'd from PUBLIC like every other tenant. DATABASE_URL arrives via
    # the bootstrap-generated env file. Joining app-db-net for it is also how
    # the container reaches `litellm:4000`, which lives on the same bridge.
    postgres.enable = true;

    # Sets LITELLM_BASE_URL. The key is rendered separately below — the shared
    # gateway, not a second instance, so daedalus sees every model Lemonade
    # serves without a duplicated model list to keep in sync.
    litellm.enable = true;
    environmentFiles = [ "/run/daedalus-litellm/env" ];

    # LAN-only. A control plane for this box has no business answering on a
    # public CNAME, wildcard cert or not.
    stage = "lab";

    auth = {
      # Forward-auth: daedalus has no user model of its own and only ever
      # serves one operator, so the Pocket ID gate belongs in front of it
      # rather than inside it. Zero app-side auth code.
      mode = "proxy";
      # Private iso-daedalus-net bridge with traefik as the only other member,
      # so nothing else on traefik-net can dial the dev server directly and
      # skip the gate. Costs the prometheus scrape; there are no metrics yet.
      isolated = true;
      # The one unauthenticated path. Backs the gatus probe, the forward-auth
      # bypass and the homepage tile's siteMonitor — see the route's header.
      healthPath = "/api/healthz";
    };

    homepage = {
      description = "S2 control plane";
      icon = "mdi-server-network-#7c5cff";
    };
  };

  # LiteLLM master key, extracted rather than inherited. Adding
  # `config.sops.secrets."litellm-env".path` to environmentFiles would work,
  # but that file is a full dotenv — UI credentials, the SSO client id/secret —
  # and none of it belongs in this container. Same one-source-of-truth idiom as
  # litellm-prom-token and homepage's HOMEPAGE_VAR_LITELLM_KEY: rotation still
  # touches only stacks/litellm/env.sops.
  #
  # The render dir is deliberately NOT /run/app-daedalus — that is the
  # container unit's RuntimeDirectory, and systemd wipes it when the container
  # stops (the trap that produced nextcloud-redis's 500s).
  systemd.services."daedalus-litellm-key" = mkSecretRender {
    description = "Render the litellm master key as daedalus's LITELLM_API_KEY";
    gates = [ "podman-app-daedalus.service" ];
    dir = "/run/daedalus-litellm";
    file = "/run/daedalus-litellm/env";
    prep = "KEY=$(grep '^LITELLM_MASTER_KEY=' ${config.sops.secrets."litellm-env".path} | head -1 | cut -d= -f2-)";
    content = "LITELLM_API_KEY=$KEY";
  };
}
