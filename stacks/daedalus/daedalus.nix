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

{
  config,
  lib,
  pkgs,
  mkSecretRender,
  ...
}:

let
  # Where the container drops an apply request and reads back status. A bind
  # mount, deliberately, rather than an API the host calls: the container has
  # no privilege to lose, and the host agent never has to authenticate to the
  # app or reach into Postgres. The app produces the artifact; the host moves
  # it into the flake and rebuilds.
  applyDir = "/home/santiago/selfhost/daedalus/apply";

  applyScript = pkgs.writeShellApplication {
    name = "daedalus-apply";
    runtimeInputs = [
      pkgs.jq
      pkgs.git
      pkgs.util-linux # setpriv
      pkgs.coreutils
      pkgs.nixos-rebuild
      pkgs.openssh # git push over ssh
    ];
    text = ''
      APPLY_DIR=${lib.escapeShellArg applyDir}
      FLAKE=/etc/nixos
      TARGET=/etc/nixos/stacks/apps/apps.json
      HOSTNAME=${lib.escapeShellArg config.networking.hostName}
      GIT_EMAIL=${lib.escapeShellArg config.fleet.mail.sender}

      ${builtins.readFile ./host/apply.sh}
    '';
  };

  # What Nix currently believes, handed to the container as one read-only
  # store file. Two parts, because they have different provenance:
  #
  #   registry   — stacks/apps/apps.json, the committed export of daedalus's
  #                own `apps` table. Comparing the DB against THIS is how the
  #                UI reports drift: it is not "what the DB says", it is what
  #                the running system was actually built from.
  #   nixManaged — apps declared by hand in Nix and therefore not editable
  #                here. Only daedalus itself. Restated rather than derived
  #                from `config.fleet.apps`: reading that attrset from the
  #                module that also defines `fleet.apps.daedalus`, to build a
  #                volume on the container that apps.nix generates from
  #                `fleet.apps`, is exactly the kind of loop the apps module's
  #                header warns about. A dozen literal lines is cheaper than
  #                an infinite recursion at eval time.
  #
  # A store path, not a bind mount of /etc/nixos/stacks/apps/apps.json: the
  # path itself changes when the content does, so the container's ExecStart
  # changes and it restarts with the new manifest. Binding the live file
  # instead would pin its inode and survive an Apply that rewrote it.
  nixManifest = pkgs.writeText "daedalus-nix-manifest.json" (
    builtins.toJSON {
      schemaVersion = 1;
      registry = builtins.fromJSON (builtins.readFile ../apps/apps.json);
      nixManaged = {
        daedalus = {
          stage = "lab";
          sourceMode = "local";
          postgres = true;
          storage = false;
          litellm = true;
          prometheus = false;
          operatorSecrets = false;
          image = null;
          egress = null;
          env = [ ];
          auth = {
            mode = "proxy";
            isolated = true;
            healthPath = "/api/healthz";
          };
          homepage = {
            description = "S2 control plane";
            icon = "mdi-server-network-#7c5cff";
          };
          notes = {
            app = "The control plane itself. Declared by hand in stacks/daedalus/daedalus.nix rather than in the registry: an Apply that broke this entry would take down the interface you would use to undo it.";
            source = "source.mode = \"local\" — the source lives in the flake repo at stacks/daedalus/app and is bind-mounted into the container, which runs the Vite dev server against it. Saving a file is the whole deploy.";
          };
        };
      };
    }
  );
in

{
  # Reach the monitoring stack: prometheus for liveness/traffic/DB size, loki
  # for the log panels. Both live on `monitoring`. This list MERGES with the
  # one stacks/apps/apps.nix contributes for this container (app-db, plus the
  # iso bridge from webApps.isolated) — bridgeMemberships is the single source
  # of membership and its lists concatenate across modules.
  #
  # It does cost some of what `auth.isolated` buys: daedalus can now dial
  # prometheus and loki. That is a deliberate trade for real status instead of
  # invented status — the isolation that matters (nothing on traefik-net can
  # reach daedalus) is unaffected, since this only adds outbound reach.
  fleet.bridgeMemberships."app-daedalus" = [ "monitoring" ];

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
      # Who applied. An Apply writes a git commit, so the commit should name a
      # person rather than "daedalus". Trusting a header requires that nothing
      # else can dial the app and forge one — which is exactly what `isolated`
      # above guarantees, and why the platform asserts the two go together.
      headers = {
        "X-Forwarded-Email" = "{{ .claims.email }}";
      };
      # /api/info skips the gate so the homepage tile can read it, the same
      # way healthPath does. The route is written to deserve that: counts and
      # app names only — no config, no env, no drift detail. A bypassed path
      # is effectively public on the LAN, and this is the control plane.
      authBypassRule = "Path(`/api/info`)";
    };

    homepage = {
      description = "S2 control plane";
      icon = "mdi-server-network-#e2795a";
      # Dialled through traefik rather than by container DNS: homepage lives
      # on traefik-net and `isolated` deliberately keeps daedalus off it.
      widget = {
        type = "customapi";
        url = "https://daedalus.toscanini.me/api/info";
        refreshInterval = 60000;
        mappings = [
          {
            field = "running";
            label = "Running";
            format = "number";
          }
          {
            field = "attention";
            label = "Issues";
            format = "number";
          }
          {
            field = "unapplied";
            label = "Unapplied";
            format = "number";
          }
        ];
      };
    };

    env = {
      # Reached over the `monitoring` bridge added above.
      PROMETHEUS_URL = "http://prometheus:9090";
      LOKI_URL = "http://loki:3100";
      # What Nix last built — see the nixManifest let-binding.
      NIX_MANIFEST_PATH = "/registry/manifest.json";
      # Where apply requests are dropped for the host agent.
      APPLY_DIR = "/apply";
    };
  };

  # Same list-merge idiom stacks/litellm uses to add its token mount to
  # prometheus: the stack that OWNS the file contributes the mount, rather
  # than the apps platform learning about daedalus.
  virtualisation.oci-containers.containers.app-daedalus.volumes = [
    "${nixManifest}:/registry/manifest.json:ro"
    "${applyDir}:/apply"
  ];

  fleet.statePaths.${applyDir} = { };

  # The apply agent. Root, because only root can `nixos-rebuild switch`.
  #
  # Triggered by a path unit rather than a socket or an API: the container
  # writes request.json into the bind mount above, systemd notices, and this
  # runs. The container therefore holds no host privilege at all — the trust
  # boundary is "can write into that directory", and everything that can
  # already has NOPASSWD sudo on this box.
  #
  # NOT a timer: an apply should start when one is requested, not up to N
  # seconds later, and a rebuild is far too expensive to poll for.
  systemd.services.daedalus-apply = {
    description = "Apply the daedalus app registry: commit the export and rebuild";
    # linger-users gates /run/user/1000; the rebuild restarts rootless units.
    after = [
      "network-online.target"
      "linger-users.service"
    ];
    wants = [ "network-online.target" ];
    serviceConfig = {
      Type = "oneshot";
      ExecStart = "${applyScript}/bin/daedalus-apply";
      # A rebuild can take minutes on a cold cache; the default 90s would
      # SIGTERM it mid-switch.
      TimeoutStartSec = "30min";
    };
  };

  systemd.paths.daedalus-apply = {
    description = "Watch for a daedalus apply request";
    wantedBy = [ "multi-user.target" ];
    pathConfig = {
      # PathChanged fires on close-after-write and on rename-into-place, which
      # is how the app publishes the file — it writes a temp and renames, so a
      # half-written request is never observable.
      PathChanged = "${applyDir}/request.json";
    };
  };

  # A failed apply means the box may have been rolled back without anyone
  # watching the UI. Mail it.
  fleet.monitoredJobs.daedalus-apply = { };

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
