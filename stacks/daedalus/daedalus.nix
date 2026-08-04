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
      LOCKFILE=${lib.escapeShellArg config.fleet.rebuildLock}
      HOSTNAME=${lib.escapeShellArg config.networking.hostName}
      GIT_EMAIL=${lib.escapeShellArg config.fleet.mail.sender}

      ${builtins.readFile ./host/apply.sh}
    '';
  };

  # Apps that actually have an `app-<name>-deploy.service` to start: exactly
  # the registry-mode entries. Read from the same JSON the manifest uses
  # rather than from `config.fleet.apps`, so this module still makes no config
  # read (see the note on `self` below) — and a local-source app like daedalus
  # is excluded for free, because it has no deploy unit at all.
  #
  # This list is the security control on the trigger: its contents become part
  # of a unit name that root starts.
  deployableApps = builtins.attrNames (builtins.fromJSON (builtins.readFile ../apps/apps.json)).apps;

  deployTriggerScript = pkgs.writeShellApplication {
    name = "daedalus-deploy-trigger";
    runtimeInputs = [
      pkgs.jq
      pkgs.systemd
      pkgs.coreutils
    ];
    text = ''
      APPLY_DIR=${lib.escapeShellArg applyDir}
      DEPLOYABLE=${lib.escapeShellArg (lib.concatStringsSep " " deployableApps)}

      ${builtins.readFile ./host/deploy-trigger.sh}
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
  #                here. Only daedalus itself, from the `self` binding below.
  #
  # A store path, not a bind mount of /etc/nixos/stacks/apps/apps.json: the
  # path itself changes when the content does, so the container's ExecStart
  # changes and it restarts with the new manifest. Binding the live file
  # instead would pin its inode and survive an Apply that rewrote it.
  # ONLY the hand-written entries. The committed registry deliberately does NOT
  # ride in here.
  #
  # It used to, and that made every Apply restart daedalus: this is a store
  # path bound into the container, so changing apps.json changed the path,
  # changed the volume argument, changed the unit, and systemd restarted it —
  # right at the "switching" phase, killing the very page that was showing the
  # progress bar. The registry now arrives through a stable path instead (see
  # registrySnapshot below), so applying a change no longer takes the app down.
  nixManifest = pkgs.writeText "daedalus-nix-manifest.json" (
    builtins.toJSON {
      schemaVersion = 1;
      nixManaged.daedalus = self;
    }
  );

  # Copies the committed registry to a FIXED path inside the bind mount, so the
  # container can read what Nix last built without that content being part of
  # its unit.
  #
  # The store-path dependency moves here, which is the point: this tiny oneshot
  # re-runs whenever apps.json changes (its ExecStart embeds the file's store
  # path, so the unit definition changes and systemd restarts it), while the
  # container's definition stays put. Nothing else about the app moves.
  registrySnapshot = pkgs.writeShellApplication {
    name = "daedalus-registry-snapshot";
    runtimeInputs = [ pkgs.coreutils ];
    text = ''
      install -d -m 0755 -o santiago -g users ${lib.escapeShellArg applyDir}
      install -m 0644 -o santiago -g users \
        ${../apps/apps.json} ${lib.escapeShellArg "${applyDir}/applied.json"}
    '';
  };

  # daedalus's own registry entry, in the manifest's shape.
  #
  # Defined ONCE and consumed twice: by `fleet.apps.daedalus` below, and by the
  # manifest the container reads. It was briefly two literals, and the icon
  # drifted between them within the hour — the UI reported one colour while
  # the homepage rendered another. Restating this is exactly the class of bug
  # daedalus exists to catch, so it does not get to have it.
  #
  # NOT read back out of `config.fleet.apps.daedalus`, which would be the other
  # way to deduplicate: this value feeds a volume on the container that
  # apps.nix generates from `fleet.apps`, and threading the read through that
  # is the loop the apps module's header warns about. One let-binding, two
  # consumers, no config read.
  self = {
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
      icon = "mdi-server-network-#e2795a";
    };
    notes = {
      app = "The control plane itself. Declared by hand in stacks/daedalus/daedalus.nix rather than in the registry: an Apply that broke this entry would take down the interface you would use to undo it.";
      source = "source.mode = \"local\" — the source lives in the flake repo at stacks/daedalus/app and is bind-mounted into the container, which runs the Vite dev server against it. Saving a file is the whole deploy.";
    };
  };
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
    postgres.enable = self.postgres;
    storage.enable = self.storage;

    # Sets LITELLM_BASE_URL. The key is rendered separately below — the shared
    # gateway, not a second instance, so daedalus sees every model Lemonade
    # serves without a duplicated model list to keep in sync.
    litellm.enable = self.litellm;
    prometheus.enable = self.prometheus;
    environmentFiles = [
      "/run/daedalus-litellm/env"
      "/run/daedalus-deploy-hook/env"
    ];

    # LAN-only. A control plane for this box has no business answering on a
    # public CNAME, wildcard cert or not.
    inherit (self) stage;

    auth = {
      # Forward-auth: daedalus has no user model of its own and only ever
      # serves one operator, so the Pocket ID gate belongs in front of it
      # rather than inside it. Zero app-side auth code.
      #
      # `isolated` puts it on a private iso-daedalus-net bridge with traefik as
      # the only other member, so nothing on traefik-net can dial the dev
      # server directly and skip the gate. `healthPath` is the one
      # unauthenticated path — it backs the gatus probe, the forward-auth
      # bypass and the homepage tile's siteMonitor.
      inherit (self.auth) mode isolated healthPath;
      # Who applied. An Apply writes a git commit, so the commit should name a
      # person rather than "daedalus". Trusting a header requires that nothing
      # else can dial the app and forge one — which is exactly what `isolated`
      # above guarantees, and why the platform asserts the two go together.
      headers = {
        "X-Forwarded-Email" = "{{ .claims.email }}";
      };
      # Two paths skip the Pocket ID gate, for the same reason healthPath
      # does — a machine has to reach them and cannot hold a passkey:
      #
      #   /api/info   — the homepage tile. Counts and app names only.
      #   /api/deploy — zot's push events (stacks/registry). Carries its own
      #                 auth instead: X-Deploy-Token, checked in the route
      #                 against DEPLOY_HOOK_TOKEN below, and it can do exactly
      #                 one thing — start an existing app's deploy unit.
      #
      # A bypassed path is effectively public on the LAN, so both are written
      # to deserve it. Everything else on this app still needs a passkey.
      authBypassRule = "Path(`/api/info`) || Path(`/api/deploy`)";
    };

    homepage = {
      inherit (self.homepage) description icon;
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
      # What Nix last built. Two files, because they change at different rates:
      # the manifest is a store path (hand-written entries, rarely moves), the
      # snapshot is a stable path refreshed by daedalus-registry-snapshot on
      # every rebuild — so an Apply updates it WITHOUT restarting this app.
      NIX_MANIFEST_PATH = "/registry/manifest.json";
      NIX_REGISTRY_PATH = "/apply/applied.json";
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
    # Last deploy result per app, written by app-<name>-deploy.service
    # (`<digest> ok|failed`). Read-only, and the DIRECTORY rather than the
    # files, so a rewritten state file is picked up without pinning an inode.
    "/var/lib/app-deploy:/deploy-state:ro"
  ];

  fleet.statePaths.${applyDir} = { };

  # Refreshes /apply/applied.json from the committed registry. Ordered before
  # the container so the file exists on a cold boot; re-runs on any rebuild
  # that changed apps.json, because its ExecStart embeds that file's store path.
  systemd.services.daedalus-registry-snapshot = {
    description = "Publish the committed app registry for daedalus to read";
    before = [ "podman-app-daedalus.service" ];
    wantedBy = [
      "podman-app-daedalus.service"
      "multi-user.target"
    ];
    after = [ "local-fs.target" ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      ExecStart = "${registrySnapshot}/bin/daedalus-registry-snapshot";
    };
  };

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

  # Redeploy trigger. Same file-drop bridge as apply, different verb: this one
  # starts an app's EXISTING deploy unit rather than rebuilding the system.
  #
  # Push, not a replacement for the poll. `app-<name>-deploy.timer` still runs
  # (see stacks/apps) and is what makes deploys self-healing: a notification
  # that arrives while the box is off is simply lost, whereas the timer's
  # Persistent=true catches up on boot. This only removes latency.
  systemd.services.daedalus-deploy-trigger = {
    description = "Start an app's deploy unit on daedalus's behalf";
    after = [ "network-online.target" ];
    wants = [ "network-online.target" ];
    serviceConfig = {
      Type = "oneshot";
      ExecStart = "${deployTriggerScript}/bin/daedalus-deploy-trigger";
      # deploy.sh health-checks with a 90s timeout after the restart; give the
      # whole pull-restart-verify cycle room without hanging forever.
      TimeoutStartSec = "10min";
    };
  };

  systemd.paths.daedalus-deploy-trigger = {
    description = "Watch for a daedalus redeploy request";
    wantedBy = [ "multi-user.target" ];
    pathConfig.PathChanged = "${applyDir}/deploy-request.json";
  };

  fleet.monitoredJobs.daedalus-deploy-trigger = { };

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
  # The shared secret zot signs its push events with. ONE encrypted source of
  # truth — stacks/registry/env.sops, where the caller side lives — rendered
  # here for the receiving side, so rotation touches a single file. Same idiom
  # as the litellm master key below.
  systemd.services."daedalus-deploy-hook-token" = mkSecretRender {
    description = "Render the registry's deploy-hook token for daedalus to verify";
    gates = [ "podman-app-daedalus.service" ];
    dir = "/run/daedalus-deploy-hook";
    file = "/run/daedalus-deploy-hook/env";
    prep = "TOKEN=$(grep '^DEPLOY_HOOK_TOKEN=' ${config.sops.secrets."registry-env".path} | head -1 | cut -d= -f2-)";
    content = "DEPLOY_HOOK_TOKEN=$TOKEN";
  };

  systemd.services."daedalus-litellm-key" = mkSecretRender {
    description = "Render the litellm master key as daedalus's LITELLM_API_KEY";
    gates = [ "podman-app-daedalus.service" ];
    dir = "/run/daedalus-litellm";
    file = "/run/daedalus-litellm/env";
    prep = "KEY=$(grep '^LITELLM_MASTER_KEY=' ${config.sops.secrets."litellm-env".path} | head -1 | cut -d= -f2-)";
    content = "LITELLM_API_KEY=$KEY";
  };
}
