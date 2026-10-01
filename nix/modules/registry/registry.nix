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
#     writer — the box's own build agent. Anonymous = pull-only
#     (accessControl anonymousPolicy) — that's what lets deploy timers
#     and app containers pull with zero credentials. NOTE: zot
#     deliberately rejects anonymous DOCKER-CLI pulls when auth is
#     configured (UA-sniffing workaround, zot PR #3868); podman is
#     unaffected, and everything on this box is podman.
#   - browser UI: native Pocket ID OIDC (generic "oidc" provider —
#     confidential client, no PKCE: zot only does PKCE for public
#     clients). A declarative `fleet.ssoClients.zot`; its id+secret come
#     from the identity provider's render, not env.sops. Callback:
#     <externalUrl>/zot/auth/callback/oidc.
#   - apikey extension is on: a logged-in UI user can mint per-purpose
#     basic-auth API keys if ever needed.
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
# is why a catch-all `pushedWithin` rule can only ever ADD retention: a long
# one silently defeats every tighter rule above it.
#
#   First, when the host names any: its `retireRepositories` (an option; the
#   description there says why zot, not `rm -rf`, empties a repository).
#
#   cache/** — BuildKit's registry cache export (stacks/daedalus/host/build.sh's
#   `--export-cache` to `<registry>/cache/<app>:buildkit`). Exactly one tag
#   there is live, `buildkit`, and it is kept BY NAME with no time condition:
#   that is the defence against zot #4233 (a metaDB rebuild loses the
#   timestamps and a purely time-based rule then expires everything). Beside
#   it, every build leaves a crowd of digest-named tags: `mode=max` exports one
#   per cached step, so the count grows with build traffic rather than with the
#   number of apps (one app alone has carried hundreds). Those are what the
#   48h rule is for — a steady-state window, not a safety net for a mistaken
#   push. This is where most of the store lives, so the window is tight. Two
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
#   three days after the comparison, and it keeps a hand-pushed tag alive
#   long enough for a human to notice it is there.
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
#   fleet.modules.registry.envSopsFile  REGISTRY_PROM_PASSWORD
#   fleet.images.zot                    the digest-pinned image (the full variant: ui,
#                                       search, metrics, scrub — `-minimal` has none)
# Requires the apps platform (asserted): the registry exists to feed it.

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

  # The host's retirements as zot's FIRST retention policy (it applies the
  # first policy a repository matches — the header explains the order), or
  # nothing. The trailing comma is the template's: its own policies follow.
  #
  # keepTags must name a pattern no tag can match, never be empty: zot deletes
  # a tag only when it matches none of the patterns, and an EMPTY keepTags
  # switches tag retention off for the repository altogether (v2.1.21,
  # `HasTagRetention` is `len(KeepTags) > 0`) — every tag is kept. An entry
  # with no patterns matches every tag, so the pattern is spelled out: a tag
  # is never the empty string.
  retirePolicy =
    if cfg.retireRepositories == [ ] then
      ""
    else
      builtins.toJSON {
        repositories = cfg.retireRepositories;
        deleteReferrers = true;
        deleteUntagged = true;
        keepTags = [ { patterns = [ "^$" ]; } ];
      }
      + ",";

  configTemplate = builtins.replaceStrings [ "@RETIRE_POLICY@" ] [ retirePolicy ] (
    builtins.readFile ./assets/config.json
  );
in
{
  options.fleet.modules.registry = {
    enable = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "zot, the box's own OCI registry.";
    };

    retireRepositories = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      example = [
        "old-app"
        "cache/old-app"
      ];
      description = ''
        Repositories to empty: every tag expires at the next retention pass
        and the following GC reclaims the blobs. For the images of apps that
        left the box — deleting their directories by hand would be wrong,
        because `dedupe` is on and a blob another repository shares may
        physically live under the one being removed; zot owns that
        bookkeeping. Remove an entry once its store is empty: this is a
        reclaim, not a rule.
      '';
    };

    envSopsFile = lib.mkOption {
      type = lib.types.path;
      example = lib.literalExpression "./host/sops/registry/env.sops";
      description = ''
        sops-encrypted dotenv carrying REGISTRY_PROM_PASSWORD (the htpasswd
        password the metrics scrape authenticates with). Host data: the engine carries
        no box's ciphertext. Only read while the module is on.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = config.fleet.modules.apps.enable;
        message = "fleet.modules.registry: the registry feeds the apps platform — enable fleet.modules.apps.";
      }
    ];

    sops.secrets."registry-env" = mkDotenvSecret cfg.envSopsFile;

    # traefik only, for the webApps serviceName route: everything that
    # pushes (the host's build agent) or pulls (the deploy oneshots, podman)
    # reaches zot through traefik.
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

    # zot prints its whole configuration at INFO on every start, and masks only
    # the secrets it knows to be secrets (the OIDC client secret). That line
    # would land in Loki, readable by anything with a Grafana session, so a
    # credential added to the config later must not reach it. Dropped; every
    # other line zot emits still arrives.
    fleet.logDrops.zot-config-dump = {
      selector = "{container=\"zot\"}";
      expression = "\"message\":\"configuration settings\"";
      reason = "zot_config_dump";
    };

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
          # Plain unquoted KEY=value files: the first match, everything after `=`.
          env_get() { grep -m1 "^$2=" "$1" | cut -d= -f2-; }
          registry_env=${config.sops.secrets."registry-env".path}
          sso_env=${config.fleet.ssoClients.zot.envFile}
          REGISTRY_PROM_PASSWORD=$(env_get "$registry_env" REGISTRY_PROM_PASSWORD)
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
        content = configTemplate;
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
    # a bridge with it.
    fleet.dashboard.registry = {
      env = {
        REGISTRY_HOST = config.fleet.webApps.registry.hostname;
        REGISTRY_URL = "https://${config.fleet.webApps.registry.hostname}";
      };
    };
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
