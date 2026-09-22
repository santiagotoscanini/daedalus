# registry — zot, the box's own OCI registry.
#
# The apps pipeline's rendezvous point: the box's build agent
# (daedalus-build, stacks/daedalus in the engine) builds every app image here on the
# host and pushes it as the `builder` user; the apps platform's deploy
# timers and containers pull anonymously via
# https://registry.<baseDomain> (the proxy, wildcard TLS). GHCR is out
# of the deploy loop entirely — recovery note: images live ONLY here
# (the state dataset's snapshots + syncoid mirror); after a total box loss
# each app needs one rebuild from its repo before it can deploy.
#
# Auth model (three doors, one house):
#   - podman/push protocol traffic: htpasswd basic auth. The `builder`
#     user (machine-generated, stacks/daedalus/builder.nix) is the ONLY
#     writer — the box's own build agent. (The Actions-era `ci` user went
#     with the runners, and its REGISTRY_CI_* keys are now out of env.sops
#     too, so nothing names a credential this registry does not have.)
#     Anonymous = pull-only
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
# the control plane (https://<its hostname>/api/deploy), which turns an
# image push into an immediate redeploy instead of waiting up to two
# minutes for that app's poll timer. Authenticated with
# DEPLOY_HOOK_TOKEN from env.sops, sent as X-Deploy-Token.
#
# Why through traefik rather than a shared podman bridge: putting zot and
# daedalus on one bridge would give the registry a direct network path to
# the thing that can rebuild the system. Going via traefik keeps daedalus
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
# Retention is LIVE (assets/config.json, which is JSON and cannot carry
# comments — the policy is explained here). It runs inside zot's GC
# scheduler, so `gcInterval` is also the retention cadence, and
# `journalctl -u podman-zot | grep -i retention` is where it reports.
# meta.db (the push/pull timestamps retention depends on) lives with the
# blobs in the state dir — never prune metadata files independently.
#
# Two policies, and ORDER MATTERS: "a repository will apply the FIRST policy
# it matches", so `cache/**` must stay above `**`. Within one policy the
# keepTags rules are additive — a tag survives if ANY rule keeps it — which
# is why a catch-all `pushedWithin` rule can only ever ADD retention, and why
# the old 2160h catch-all quietly defeated the two rules above it.
#
#   The orphan list, first because zot takes the first matching policy — these
#   are repositories for things that are no longer on the box (`ipcrawl`, and
#   `spike` from the builder's commissioning). `keepTags: []` expires every tag
#   and the next GC reclaims the blobs. Deleting the directories by hand would
#   have been wrong: `dedupe` is on, so a blob another repo shares may physically
#   live under the one being removed. Let zot do it — it owns that bookkeeping.
#   This block goes away once the store is empty; it is a reclaim, not a rule.
#
#   cache/** — BuildKit's registry cache export (build.sh's
#   `--export-cache ref=<registry>/cache/<app>:buildkit`). Exactly one tag
#   there is live, `buildkit`, and it is kept BY NAME with no time condition:
#   that is the defence against zot #4233 (a metaDB rebuild loses the
#   timestamps and a purely time-based rule then expires everything). Beside
#   it, every build leaves a crowd of digest-named tags: `mode=max` exports one
#   per cached step, so the count grows with build traffic rather than with the
#   number of apps (plutus alone carried 630). Those are what the 48h rule is
#   for — a steady-state window, not a safety net for a mistaken push. This is
#   where the store actually lives: at 168h it was 15 GB of a 20 GB tree. Two
#   days is chosen against how these apps are built, not how long cache stays
#   theoretically useful: a repo that is pushed at all is pushed most days, so
#   it re-warms its own cache, and a repo that has been quiet for a week is
#   about to rebuild its install step whatever this number says.
#
#   ** — the app repos. `latest` by name (same #4233 reasoning: the tag every
#   deploy timer pulls must not depend on a timestamp). Then the 10 most
#   recently pushed `sha-` tags per repo: a rollback means redeploying a
#   previous `sha-`, and ten builds back is roughly a week of active work and
#   much longer when idle — far past the point where the answer is "rebuild
#   from the repo" rather than "pull an old image". At an observed ~66 MB
#   marginal per build (shared base layers + dedupe) that is well under a
#   gigabyte per app. Last, a 72h catch-all: it expires `candidate-` tags
#   (built only to compare against a live image, and read within minutes)
#   three days after the comparison instead of the old ninety, and it keeps a
#   hand-pushed tag alive long enough for a human to notice it is there.
#
# `deleteUntagged` + `delay: 24h` cover the blobs a push leaves behind; an
# untagged manifest younger than a day is an upload in flight, not garbage.
#
# readTimeout/writeTimeout are raised from zot's 60s default — a
# single blob PATCH slower than the timeout aborts the whole upload
# (#4079). Registry pushes must never ride the CF tunnel (100 MB
# request-body cap), and none do: the registry is not published
# remotely, so the build agent's pushes and every pull alike reach zot
# through traefik on LAN websecure.
#
# v2.2.0 WARNING: a breaking on-disk storage refactor is queued
# upstream. Stay on v2.1.x digests until its migration notes are read
# (update-images will surface the bump; don't take it blind).
#
# The host brings:
#   fleet.modules.registry.enable       the switch (default off, as every catalog module)
#   fleet.modules.registry.envSopsFile  REGISTRY_PROM_PASSWORD + DEPLOY_HOOK_TOKEN
#   fleet.images.zot                    the digest-pinned image (the full variant: ui,
#                                       search, metrics, scrub — `-minimal` has none)
# Requires the apps platform (asserted): the registry exists to feed it, and
# its push events are delivered to the control plane's container.

{
  config,
  lib,
  pkgs,
  mkRootlessContainer,
  mkDotenvSecret,
  mkSecretRender,
  pinnedImage,
  ...
}:

let
  cfg = config.fleet.modules.registry;

  dataDir = "${config.fleet.stateRoot}/registry";

  # The box's image builder and its push identity (stacks/daedalus/builder.nix).
  inherit (config.fleet) builder;

  # The control plane's published entry, which the apps stack creates. Read
  # guardedly so the assertion below, not an attribute error, is what a host
  # without the apps platform sees.
  controlPlane = config.fleet.webApps.daedalus or null;
in
{
  options.fleet.modules.registry = {
    enable = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "zot, the box's own OCI registry.";
    };

    envSopsFile = lib.mkOption {
      type = lib.types.path;
      example = lib.literalExpression "./host/sops/registry/env.sops";
      description = ''
        sops-encrypted dotenv carrying REGISTRY_PROM_PASSWORD (the htpasswd
        password the metrics scrape authenticates with) and
        DEPLOY_HOOK_TOKEN (the shared secret zot signs its push events
        with, verified by the control plane). Host data: the engine carries
        no box's ciphertext. Only read while the module is on.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = controlPlane != null;
        message = "fleet.modules.registry: the registry feeds the apps platform and reports pushes to the control plane's container — enable fleet.modules.apps.";
      }
    ];

    sops.secrets."registry-env" = mkDotenvSecret cfg.envSopsFile;

    # traefik only, for the webApps serviceName route. The `registry` bridge
    # that used to sit beside it existed for the Actions runner containers —
    # those are gone, and everything that pushes now (the host's build agent)
    # or pulls (the deploy oneshots, podman) reaches zot through traefik.
    fleet.bridgeMemberships.zot = [ "traefik" ];

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

    # Pocket ID client — id `zot`, secret generated on the box. Not
    # group-restricted: anonymous pull
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
    #
    # This runs as root, and registry-env is the operator's (mkDotenvSecret), so
    # the env files are PARSED with grep, never sourced; every password reaches
    # htpasswd on stdin, never in argv (no hidepid here: /proc/*/cmdline is
    # world-readable). An empty prometheus value refuses the render — an empty
    # htpasswd password is an open door.
    #
    # The `builder` user (stacks/daedalus/builder.nix, while the GitHub App
    # exists) is the box's own image builder and the registry's only writer: its
    # password is machine-generated there and read here through its validating
    # reader. Its access policy (read/create/update, no delete) is in
    # assets/config.json unconditionally — a policy naming a user htpasswd lacks
    # grants nothing.
    systemd.services.registry-config-render = lib.mkMerge [
      (mkSecretRender {
        description = "Render zot config + htpasswd from registry-env";
        gates = [ "podman-zot.service" ];
        # Both renders gate on zot; only this edge orders them.
        after = [ "sso-zot-env-render.service" ];
        dir = "/run/registry";
        file = "/run/registry/config.json";
        prep = ''
          SSO_ISSUER=${lib.escapeShellArg config.fleet.sso.issuerUrl}
          REGISTRY_URL=${lib.escapeShellArg "https://${config.fleet.webApps.registry.hostname}"}
          # zot's adminPolicy matches the OIDC e-mail claim: the operator's IdP login.
          OPERATOR_EMAIL=${lib.escapeShellArg config.fleet.operator.email}
          # The deploy-hook sink, from the app's published hostname rather than a
          # literal in the asset — a hostname rename must reach zot too.
          DAEDALUS_DEPLOY_URL=${lib.escapeShellArg "https://${controlPlane.hostname}/api/deploy"}
          # Plain unquoted KEY=value files: the first match, everything after `=`.
          env_get() { grep -m1 "^$2=" "$1" | cut -d= -f2-; }
          registry_env=${config.sops.secrets."registry-env".path}
          sso_env=${config.fleet.ssoClients.zot.envFile}
          REGISTRY_PROM_PASSWORD=$(env_get "$registry_env" REGISTRY_PROM_PASSWORD)
          DEPLOY_HOOK_TOKEN=$(env_get "$registry_env" DEPLOY_HOOK_TOKEN)
          OIDC_CLIENT_ID=$(env_get "$sso_env" OIDC_CLIENT_ID)
          OIDC_CLIENT_SECRET=$(env_get "$sso_env" OIDC_CLIENT_SECRET)
          for v in REGISTRY_PROM_PASSWORD; do
            if [ -z "''${!v}" ]; then
              echo "registry-config-render: $v is empty in registry-env; refusing to render htpasswd" >&2
              exit 1
            fi
          done
          ${lib.optionalString builder.enable ''
            # The builder user enters htpasswd only with a password its reader
            # accepts (root 0600, exactly 64 hex): an empty one would let anyone
            # push. A refusal keeps zot up for everyone else and fails the builder
            # closed; daedalus-build-dockerconfig is the unit that fails loudly.
            if ! BUILDER_PASSWORD=$(${builder.registryPasswordRead}); then
              BUILDER_PASSWORD=
              echo "registry-config-render: builder password refused; htpasswd rendered WITHOUT the builder user" >&2
            fi
          ''}
          {
            printf '%s' "$REGISTRY_PROM_PASSWORD" | ${pkgs.apacheHttpd}/bin/htpasswd -niB prometheus
            ${lib.optionalString builder.enable ''
              if [ -n "$BUILDER_PASSWORD" ]; then
                printf '%s' "$BUILDER_PASSWORD" | ${pkgs.apacheHttpd}/bin/htpasswd -niB ${builder.registryUser}
              fi
            ''}
          } | install -m 0400 -o ${config.fleet.operator.user} -g ${config.fleet.operator.group} /dev/stdin /run/registry/htpasswd
        '';
        content = builtins.readFile ./assets/config.json;
      })
      {
        # A render that changes on a rebuild is RESTARTED rather than stopped and
        # started, so the PartOf below carries the restart to zot in the same job:
        # zot bind-mounts the rendered files, and `install` replaces them with new
        # inodes that a running container never sees. Stop-then-start would take
        # zot down with the render in the stop phase and leave it down until
        # switch-to-configuration starts the active targets again at the very end.
        stopIfChanged = false;
      }
      (lib.mkIf builder.enable {
        after = [ "daedalus-build-registry-password.service" ];
        wants = [ "daedalus-build-registry-password.service" ];
        # Rotating the builder password (builder.nix header) re-renders this.
        partOf = [ "daedalus-build-registry-password.service" ];
      })
    ];

    # Every restart of the render reaches the container that reads its output.
    systemd.services.podman-zot.partOf = [ "registry-config-render.service" ];

    # The hook's own router, in front of the app's, with a rate limit.
    #
    # zot has no event filter and its scheduled CVE scan publishes one event
    # per manifest, so a pass is ~1 000 POSTs in three minutes (12/s
    # observed) and they all land here, on the app's forward-auth bypass.
    # With daedalus up that is a no-op per event. With daedalus DOWN it is
    # the incident of 2026-09-10: traefik answers 502 and resolves the dead
    # backend name on every attempt, pi-hole rate-limits 127.0.0.1 (every
    # container's client address), and image pulls, deploys and the OIDC
    # gates fail across the box.
    #
    # The limit caps the failure path, not the feature: 5/s with a burst of
    # 20 is well above the trickle a push produces, and a 429 costs zot
    # nothing (it does not retry). During a scan pass most scanned events
    # are refused, which is the correct outcome; a push that lands inside a
    # pass falls back to the app's two-minute poll timer. Keyed by source IP
    # and matched on the path only, so the UI's own request bursts (a Vite
    # dev server serves hundreds of modules per page load) are never
    # limited. The strip middleware stays so a bypassed request cannot
    # spoof the identity headers, exactly as on the app router.
    fleet.traefikRawRules."daedalus-deploy-hook.yml" = lib.mkIf (controlPlane != null) (
      builtins.toJSON {
        http = {
          middlewares.deploy-hook-ratelimit.rateLimit = {
            average = 5;
            period = "1s";
            burst = 20;
          };
          routers.daedalus-deploy-hook-rtr = {
            entryPoints = [ "websecure" ];
            # Longer than the app's `Host(...)` rule, so it wins on traefik's
            # default rule-length priority.
            rule = "Host(`${controlPlane.hostname}`) && Path(`/api/deploy`)";
            middlewares = lib.optional (controlPlane.authHeaders != { }) "oidc-daedalus-strip@file" ++ [
              "deploy-hook-ratelimit@file"
            ];
            service = "daedalus-svc";
            tls.options = "tls-opts@file";
          };
        };
      }
    );

    # /metrics requires auth once auth is configured (zot >= 2.1.18), so
    # the plain webApps scrape can't be used. Own render dir — the
    # prometheus container must not see /run/registry (htpasswd + OIDC
    # secret live there).
    systemd.services.registry-prom-password = mkSecretRender {
      description = "Render zot scrape password for prometheus";
      gates = [ "podman-prometheus.service" ];
      dir = "/run/registry-prom";
      file = "/run/registry-prom/password";
      # Parsed, not sourced: registry-env is the operator's, this runs as root.
      prep = ''
        REGISTRY_PROM_PASSWORD=$(grep -m1 '^REGISTRY_PROM_PASSWORD=' ${
          config.sops.secrets."registry-env".path
        } | cut -d= -f2-)
        if [ -z "$REGISTRY_PROM_PASSWORD" ]; then
          echo "registry-prom-password: REGISTRY_PROM_PASSWORD is empty in registry-env" >&2
          exit 1
        fi
      '';
      content = "\${REGISTRY_PROM_PASSWORD}";
    };

    # Gated on monitoring's switch: a volume on a container nobody declares is
    # an eval error, not a no-op.
    virtualisation.oci-containers.containers.prometheus =
      lib.mkIf config.fleet.modules.monitoring.enable
        {
          volumes = [ "/run/registry-prom:/run/secrets/registry-prom:ro" ];
        };

    # What this stack hands the control plane (fleet.dashboard). The hostname
    # twice under the names the engine reads: REGISTRY_HOST for the
    # site identity (src/host/site.ts), REGISTRY_URL for host/registry.ts —
    # zot over traefik, since daedalus is `isolated` and deliberately not on
    # a bridge with it. And the deploy-hook token: the shared secret zot
    # signs its push events with, ONE encrypted source of truth (env.sops
    # here, where the caller side lives), rendered by THIS stack for the
    # receiving side so rotation touches a single file. Not
    # /run/app-daedalus: that is the container unit's RuntimeDirectory,
    # wiped when the container stops.
    fleet.dashboard.registry = {
      env = {
        REGISTRY_HOST = config.fleet.webApps.registry.hostname;
        REGISTRY_URL = "https://${config.fleet.webApps.registry.hostname}";
      };
      envFiles = [ "/run/registry-daedalus/env" ];
    };
    systemd.services.registry-daedalus-token =
      lib.mkIf config.fleet.modules.daedalus.enable
        (mkSecretRender {
          description = "Render the registry's deploy-hook token for daedalus to verify";
          gates = [ "podman-app-daedalus.service" ];
          dir = "/run/registry-daedalus";
          file = "/run/registry-daedalus/env";
          prep = "TOKEN=$(grep '^DEPLOY_HOOK_TOKEN=' ${
            config.sops.secrets."registry-env".path
          } | head -1 | cut -d= -f2-)";
          content = "DEPLOY_HOOK_TOKEN=$TOKEN";
        });

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
      image = pinnedImage "zot" "ghcr.io/project-zot/zot";
      volumes = [
        "/run/registry/config.json:/etc/zot/config.json:ro"
        "/run/registry/htpasswd:/etc/zot/htpasswd:ro"
        "${dataDir}:/var/lib/zot"
      ];
    };
  };
}
