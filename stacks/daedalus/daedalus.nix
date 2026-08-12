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
  mkDotenvSecret,
  mkSecretRender,
  ...
}:

let
  # `docker.io/n8nio/n8n:2.33.2@sha256:d31c…` → `2.33.2`, and
  # `…/mcp-grocy:v2.7.0@sha256:…` → `2.7.0`. See the env bindings below for
  # why these are parsed rather than restated: a second copy of a version
  # string is a second copy that goes stale on the next bump.
  #
  # Empty rather than absent when the image is pinned by digest alone, which
  # every consumer renders as "unknown" rather than as a wrong number.
  tagOf =
    container:
    let
      m = builtins.match ".*:v?([0-9][^@:]*)@sha256:.*" (
        config.virtualisation.oci-containers.containers.${container}.image
      );
    in
    if m == null then "" else builtins.head m;

  # Every container's image tag, WHATEVER shape it is: `10.11.11ubu2404-ls42`,
  # `jvm-stable`, `latest`, `8`.
  #
  # Deliberately not `tagOf`, which insists the tag look like a version and
  # answers empty otherwise. Deciding whether a tag names a version is the
  # reader's job, and a channel name arriving intact is exactly what lets a
  # panel say "this pin carries no version" rather than show a wrong one.
  #
  # One variable over every container rather than a variable per service,
  # because the alternative is a nix edit — and a rebuild — every time a page
  # wants to report a version that is already written down here. The Media
  # tabs read eight of these.
  imageTags = lib.mapAttrs (
    _: c:
    let
      pinned = builtins.match ".*:([^@:]+)@sha256:.*" c.image;
      plain = builtins.match ".*:([^@:]+)" c.image;
    in
    if pinned != null then builtins.head pinned
    else if plain != null then builtins.head plain
    else ""
  ) config.virtualisation.oci-containers.containers;

  # `localhost/litellm-pgvector:b553f84-a4yhvmn9` → `b553f84`. Not a version:
  # there is no published image and no release, so the flake pins a source
  # COMMIT and mkLocalImage puts its short form in the tag. That commit is what
  # a changelog can be measured from.
  pgvectorRev =
    let
      m = builtins.match ".*:([0-9a-f]{7,40})-[^-]*$" (
        config.virtualisation.oci-containers.containers.litellm-pgvector.image
      );
    in
    if m == null then "" else builtins.head m;

  # Which containers ride each VPN tunnel, derived rather than declared: a
  # netns tenant says so in its own `--network=container:<owner>` flag, and
  # that flag is the thing that actually puts it behind the tunnel. A
  # hand-kept list beside it could only ever be the same fact, less reliably.
  netnsTenantsOf =
    owner:
    lib.sort (a: b: a < b) (
      lib.attrNames (
        lib.filterAttrs (
          _: c: lib.any (o: o == "--network=container:${owner}") (c.extraOptions or [ ])
        ) config.virtualisation.oci-containers.containers
      )
    );

  # The VPN egress registry, as the dashboard consumes it. Nix knows things
  # about these tunnels that no API can answer — when the key expires, what
  # the tunnel is for, where the renewal runbook lives — and this is the one
  # place those cross the boundary.
  vpnEgress = lib.mapAttrsToList (_: v: v // { tenants = netnsTenantsOf v.container; }) (
    config.fleet.vpnEgress
  );

  # Where the container drops an apply request and reads back status. A bind
  # mount, deliberately, rather than an API the host calls: the container has
  # no privilege to lose, and the host agent never has to authenticate to the
  # app or reach into Postgres. The app produces the artifact; the host moves
  # it into the flake and rebuilds.
  # Under apps/ — daedalus is an app on its own platform, so its host-side
  # state sits with the other apps' dirs rather than as a root-level stack.
  applyDir = "${config.fleet.stateRoot}/apps/daedalus/apply";

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
      OPERATOR_USER=santiago
      OPERATOR_GROUP=users

      ${builtins.readFile ./host/lib.sh}
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
      OPERATOR_USER=santiago
      OPERATOR_GROUP=users

      ${builtins.readFile ./host/lib.sh}
      ${builtins.readFile ./host/deploy-trigger.sh}
    '';
  };

  # The repo-side half of adding an app: authorise a repo to push to the
  # registry, and get its first image built. See host/ci.sh for why both need
  # the host — one reads a password the container must not have, the other
  # starts a runner.
  #
  # No allowlist here, unlike the deploy trigger above: the whole point is
  # acting on a repo that is NOT an app yet, so there is no set to check
  # against. The script validates the name's SHAPE and then confirms the
  # repository exists under the account, which is the closest thing to an
  # allowlist that still admits the case this exists for.
  ciScript = pkgs.writeShellApplication {
    name = "daedalus-ci";
    runtimeInputs = [
      pkgs.jq
      pkgs.gh
      pkgs.curl
      pkgs.systemd
      pkgs.coreutils
      pkgs.gnugrep
    ];
    text = ''
      APPLY_DIR=${lib.escapeShellArg applyDir}
      OWNER=santiagotoscanini
      REGISTRY_ENV=${config.sops.secrets."registry-env".path}
      GHCR_AUTH=${config.sops.secrets."ghcr-auth".path}
      OPERATOR_USER=santiago
      OPERATOR_GROUP=users

      ${builtins.readFile ./host/lib.sh}
      ${builtins.readFile ./host/ci.sh}
    '';
  };

  # Where the merged per-container environment is published. /run, so these
  # secrets live on tmpfs and never enter a ZFS snapshot or the syncoid mirror.
  envDir = "/run/daedalus-env";

  envSnapshotScript = pkgs.writeShellApplication {
    name = "daedalus-env-snapshot";
    runtimeInputs = [
      pkgs.podman
      pkgs.util-linux # setpriv
      pkgs.coreutils
      pkgs.gnugrep
    ];
    text = ''
      OUT_DIR=${lib.escapeShellArg envDir}
      # The registry's apps plus daedalus itself — exactly the set with a page
      # in the UI. Derived from apps.json, so an Apply keeps it current.
      APPS=${lib.escapeShellArg (lib.concatStringsSep " " (deployableApps ++ [ "daedalus" ]))}
      SETPRIV=${pkgs.util-linux}/bin/setpriv
      ENV_BIN=${pkgs.coreutils}/bin/env
      PODMAN=${pkgs.podman}/bin/podman

      ${builtins.readFile ./host/env-snapshot.sh}
    '';
  };

  # Where each running container's image labels are published. Public metadata
  # rather than secrets — see the header of image-snapshot.sh — but /run for
  # the same reason: derived state that should not outlive a reboot.
  imageDir = "/run/daedalus-images";

  imageSnapshotScript = pkgs.writeShellApplication {
    name = "daedalus-image-snapshot";
    runtimeInputs = [
      pkgs.podman
      pkgs.util-linux # setpriv
      pkgs.coreutils
      pkgs.jq
    ];
    text = ''
      OUT_DIR=${lib.escapeShellArg imageDir}
      SETPRIV=${pkgs.util-linux}/bin/setpriv
      ENV_BIN=${pkgs.coreutils}/bin/env
      PODMAN=${pkgs.podman}/bin/podman
      JQ=${pkgs.jq}/bin/jq

      ${builtins.readFile ./host/image-snapshot.sh}
    '';
  };

  # What only the host can answer about this machine — SMART, self-test
  # history, scrub state, snapshot usage, replication lag, boot generations.
  # See host/system-snapshot.sh for why each of those has no other route in.
  systemDir = "/run/daedalus-system";

  systemSnapshotScript = pkgs.writeShellApplication {
    name = "daedalus-system-snapshot";
    # SC2016 is "expressions don't expand in single quotes", which is exactly
    # what every jq program in this script relies on: `$dev`, `$status` and
    # friends are jq's own variables, bound with --arg, and letting the shell
    # near them is the bug the check is warning about in reverse. Same for the
    # one awk program's `$1`/`$2`.
    excludeShellChecks = [ "SC2016" ];
    runtimeInputs = [
      pkgs.smartmontools
      pkgs.zfs
      pkgs.coreutils
      pkgs.dmidecode
      pkgs.gnused
      pkgs.gnugrep
      pkgs.gawk
      pkgs.nix
      pkgs.jq
    ];
    text = ''
      OUT_DIR=${lib.escapeShellArg systemDir}
      SMARTCTL=${pkgs.smartmontools}/bin/smartctl
      DMIDECODE=${pkgs.dmidecode}/bin/dmidecode
      ZPOOL=${pkgs.zfs}/bin/zpool
      ZFS=${pkgs.zfs}/bin/zfs
      LSBLK=${pkgs.util-linux}/bin/lsblk
      NIX_ENV=${pkgs.nix}/bin/nix-env
      UNAME=${pkgs.coreutils}/bin/uname
      SED=${pkgs.gnused}/bin/sed
      GREP=${pkgs.gnugrep}/bin/grep
      AWK=${pkgs.gawk}/bin/awk
      JQ=${pkgs.jq}/bin/jq

      ${builtins.readFile ./host/system-snapshot.sh}
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
  # Every hostname already published on this box, apps and non-apps alike
  # (pihole, grafana, chat, …). Handed to the container so a hostname edit can
  # be rejected while it is being typed.
  #
  # The platform already refuses a collision — fleet.traefikRoutes asserts that
  # no two routers claim the same entrypoint+host, because traefik's pick
  # between identical rules is nondeterministic. But that assertion fires
  # during `nixos-rebuild`, i.e. mid-Apply, after the commit; recovering means
  # a revert. This list is what lets the same mistake be a red input box
  # instead.
  #
  # Reading config.fleet.webApps here is safe despite the module header's
  # warning about config reads: webApps is derived from fleet.apps, which is a
  # literal, and nothing in that chain depends on the container this file
  # feeds. (`self`, by contrast, DOES feed the container, which is why it stays
  # a let-binding rather than a read of fleet.apps.daedalus.)
  takenHostnames = lib.sort (a: b: a < b) (
    lib.mapAttrsToList (_: w: w.hostname) config.fleet.webApps
  );

  # webApp name → published hostname, for the dashboard's tile catalogue.
  #
  # The same list as `takenHostnames`, keyed rather than flattened, because the
  # two answer different questions: that one is "is this name free", this one is
  # "where do I dial `jellyfin`". Passing it means a hostname edit moves the
  # dashboard's URL with it instead of stranding a literal in TypeScript — the
  # tile catalogue names webApps, never FQDNs.
  #
  # Not every tile has an entry: the gluetun-netns services and the host-netns
  # ones are reached on `host.containers.internal:<port>` (they cannot ride
  # traefik-net), and those ports are literals in the catalogue — structural
  # host ports, already restated in the stack that owns each one.
  webAppHosts = lib.mapAttrs (_: w: w.hostname) config.fleet.webApps;

  # Apps with a tracked stacks/apps/<name>-env.sops. A FACT, read from the same
  # directory listing declarations.nix reads, not a setting: this is the only
  # thing that decides whether an app gets operator secrets, so the page shows
  # it and offers no switch. The registry (apps.json) carries settings; the
  # manifest carries what Nix knows — and this belongs on that side.
  operatorSecretApps = lib.attrNames (import ../apps/operator-secrets-lib.nix { inherit lib; });

  # Names pi-hole answers from its own hosts file instead of forwarding.
  #
  # Read from the setting FTL is actually configured with, not from
  # `fleet.dnsHosts`: the stacks contribute most of these, but pi-hole's own
  # module appends the hosts that belong to no stack (the gaming PC), and a
  # page that showed only the stack half would be quietly missing entries that
  # exist. Split into address and name because they are the two halves of the
  # answer — nearly every one points at this box, and the ones that do not are
  # exactly the interesting rows.
  lanHosts =
    let
      parse = e: {
        ip = lib.elemAt (lib.splitString " " e) 0;
        host = lib.elemAt (lib.splitString " " e) 1;
      };
    in
    lib.sort (a: b: a.host < b.host) (
      map parse config.services.pihole-ftl.settings.dns.hosts
    );

  # Every scheduled job that has been declared as worth noticing, and HOW it is
  # noticed. The two are different guarantees and the registry is the only
  # place they are stated together: `email` means a run that FAILS sends mail,
  # `slug` means a run that stops happening at all pages through healthchecks.
  #
  # A job with email and no slug cannot report that it was never started, which
  # is exactly the failure a timer has — so the pair is what the Jobs tab
  # exists to show. healthchecks knows about half of these and systemd knows
  # about all of them; neither knows which was intended.
  monitoredJobs = lib.mapAttrsToList (unit: j: {
    inherit unit;
    inherit (j) email slug;
  }) config.fleet.monitoredJobs;

  nixManifest = pkgs.writeText "daedalus-nix-manifest.json" (
    builtins.toJSON {
      schemaVersion = 1;
      nixManaged.daedalus = self;
      inherit
        takenHostnames
        webAppHosts
        operatorSecretApps
        lanHosts
        monitoredJobs
        ;
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
  # manifest the container reads. As two literals these drift within the hour —
  # the app list rendering one description while the detail page reports
  # another. Restating this is exactly the class of bug daedalus exists to
  # catch, so it does not get to have it.
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
    hostname = null; # = daedalus.<baseDomain>
    image = null;
    egress = null;
    env = [ ];
    auth = {
      mode = "proxy";
      isolated = true;
      healthPath = "/api/healthz";
    };
    presentation = {
      description = "S2 control plane";
    };
    # Uncapped on purpose: this is a Vite dev server that typechecks and
    # bundles on demand, so its working set is spiky and unlike a built app's.
    # A cap sized from steady state would OOM it on the first cold compile.
    resources = {
      cpus = null;
      memoryMb = null;
      pids = null;
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
      "/run/daedalus-dashboard/env"
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
      # unauthenticated path — it backs the gatus probe and the forward-auth
      # bypass.
      inherit (self.auth) mode isolated healthPath;
      # Who applied. An Apply writes a git commit, so the commit should name a
      # person rather than "daedalus". Trusting a header requires that nothing
      # else can dial the app and forge one — which is exactly what `isolated`
      # above guarantees, and why the platform asserts the two go together.
      headers = {
        "X-Forwarded-Email" = "{{ .claims.email }}";
      };
      # Four paths skip the Pocket ID gate, for the same reason healthPath
      # does — whatever fetches them cannot hold a passkey:
      #
      #   /api/deploy — zot's push events (stacks/registry). Carries its own
      #                 auth instead: X-Deploy-Token, checked in the route
      #                 against DEPLOY_HOOK_TOKEN below, and it can do exactly
      #                 one thing — start an existing app's deploy unit.
      #
      #   the icons   — iOS fetches the apple-touch-icon when a page is added
      #                 to the home screen, and that fetch does not carry the
      #                 forward-auth session cookie. Gated, it is answered with
      #                 a 302 to the IdP, iOS reads HTML where it wanted a PNG,
      #                 and the home screen gets a generic letter tile instead.
      #                 The other two are here so a favicon behaves the same way
      #                 in any client that requests it outside a page load.
      #
      # A bypassed path is effectively public on the LAN, so each is written to
      # deserve it: three of these are the app's own artwork and the fourth
      # authenticates itself. Everything else on this app still needs a passkey.
      authBypassRule = "Path(`/api/deploy`) || Path(`/icon.svg`) || Path(`/icon.png`) || Path(`/apple-icon.png`)";
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
      # The fleet.export domains (platform/export.nix) — the successor to the
      # manifest and the env blobs; readers flip domain by domain.
      EXPORT_DIR = "/export";

      # The box's identity, for src/lib/site.ts. VITE_-prefixed because the
      # CLIENT bundle needs these too — hostname validators and JSX render
      # them, and a file under /export is server-only. Vite statically
      # replaces them client-side; the server reads the same values through
      # import.meta.env. This is what lets the app carry no hostname literals.
      VITE_BASE_DOMAIN = config.fleet.baseDomain;
      VITE_GITHUB_OWNER = config.fleet.github.owner;
      VITE_REGISTRY_HOST = config.fleet.webApps.registry.hostname;
      VITE_GRAFANA_URL = "https://${config.fleet.webApps.grafana.hostname}";
      # The endpoint lib/registry.ts dials (zot over traefik — daedalus is
      # `isolated` and deliberately not on registry-net).
      REGISTRY_URL = "https://${config.fleet.webApps.registry.hostname}";
      # Where apply requests are dropped for the host agent.
      APPLY_DIR = "/apply";

      # Dashboard: the non-secret half of what the tiles need. The keys ride
      # the rendered env file below; these are identifiers that appear in the
      # public dashboard URLs anyway.
      CF_ACCOUNT_ID = config.fleet.cloudflare.accountId;
      CF_TUNNEL_ID = config.fleet.cloudflare.tunnelId;
      CF_ZONE_ID = config.fleet.cloudflare.zoneId;
      # Off-box, so it cannot come from webAppHosts. One binding here rather
      # than a literal per Lemonade tile.
      LEMONADE_URL = "http://gaming-pc.local.${config.fleet.baseDomain}:13305";
      # The default route, which is the router. Bound from the one option that
      # already says where this box sends everything it cannot deliver itself,
      # so there is no second copy of the address to drift.
      GATEWAY_IP = config.networking.defaultGateway.address;
      # The product name, and ONLY that. The router serves no API, but its
      # login page carries a build stamp — model, hardware revision, firmware,
      # build date — so all four of those are read off the device and a
      # firmware bump reaches the tab with nothing edited here. What the stamp
      # does not carry is the name printed on the box, which is this.
      ROUTER_PRODUCT = "AXE5400 Tri-Band Wi-Fi 6E";
      # Pi-hole NOT through traefik, and bound from the same option that tells
      # traefik where to dial rather than restated. The reads this backs carry
      # device identities — hostnames, MAC addresses, what each one looks up —
      # and reaching them on the public hostname would mean widening the
      # unauthenticated bypass in front of it to match. Off the bridge there is
      # nothing to widen: the gate stays exactly where it is.
      PIHOLE_URL = config.fleet.webApps.pihole.serviceUrl;
      # Two URLs for one device, and the split is the point rather than an
      # oversight. The read is a machine fetching an unauthenticated login
      # page: the router's TLS is a self-signed certificate, so HTTPS there
      # would have to be verification-disabled, which buys nothing over plain
      # HTTP for a page that carries no secret. The LINK is a person about to
      # type an admin password, where TLS is the whole point. Both interpolate
      # the same gateway option, so neither can drift from the other.
      ROUTER_URL = "http://${config.networking.defaultGateway.address}";
      ROUTER_ADMIN_URL = "https://${config.networking.defaultGateway.address}/webpages/index.html#/login";
      # What nearly every pi-hole hosts entry points at. Bound from the option
      # that GENERATES those entries, so "this one points somewhere else" stays
      # a real distinction instead of a comparison against a stale literal.
      LAN_IP = config.fleet.lanIp;
      # Read from the stack that pins it rather than restated here, so the
      # tile reports the version the server actually downloads on start.
      FACTORIO_VERSION = config.fleet.factorio.version;
      # Same argument, twice over: the Minecraft image downloads exactly this
      # version at this Paper build on every start, so the pin IS what runs.
      # The page cross-checks both against what the server reports over the
      # status ping, which is how a container that never restarted after a
      # bump gives itself away.
      MINECRAFT_VERSION = config.fleet.minecraft.version;
      MINECRAFT_PAPER_BUILD = config.fleet.minecraft.paperBuild;
      # The one address the game servers are reached by — the same string from
      # the sofa and from a hotel, because pi-hole answers it with the LAN
      # address and Cloudflare with the WAN one. Bound rather than typed so
      # the page cannot print a hostname this box no longer maintains.
      WAN_HOST = config.fleet.wanHost;
      # Same idea, different mechanism. n8n serves no version anywhere — not
      # on its public API, not in /rest/settings — so the tag it is pinned to
      # IS the running version. Parsed out of the pin itself rather than
      # retyped, because a second copy of a version string is a second copy
      # that goes stale on the next bump. Empty if the image is ever pinned by
      # digest alone, which the AI tab renders as "unknown" rather than as a
      # wrong number.
      N8N_VERSION = tagOf "n8n";
      # wg-easy serves its version nowhere a read-only caller can reach it
      # (v2's API is behind a TOTP session), so the pin IS the version.
      WG_EASY_VERSION = tagOf "wg-easy";
      # Pocket ID has no /api/version and prints none on /healthz, so the pin
      # is again the only answer. Traefik is the opposite case and gets no
      # variable at all — it serves /api/version on the internal entrypoint,
      # which reports what the process is actually running rather than what
      # the flake asked for.
      POCKET_ID_VERSION = tagOf "pocket-id";
      # The two containers standing beside LiteLLM whose version is knowable
      # from the flake. The third — searxng — is a digest-pinned `:latest`, and
      # states its build in its own startup banner instead, which daedalus
      # reads back out of Loki.
      MCP_GROCY_VERSION = tagOf "mcp-grocy";
      PGVECTOR_REV = pgvectorRev;
      # Every container's pinned tag, as JSON. The four variables above predate
      # it and stay because their consumers already read them by name; anything
      # new reads this instead, so a page that wants to report what a service
      # is running costs no nix edit and no rebuild. See `imageTags`.
      IMAGE_TAGS = builtins.toJSON imageTags;
      # ...and where the OTHER half of that answer is published: the labels
      # baked into the images actually on disk, for the services whose pin is
      # a moving tag and therefore carries no version at all.
      IMAGE_LABELS_PATH = "/images/labels.json";
      HOST_FACTS_PATH = "/system/system.json";
      # The VPN tunnels, as JSON. One variable rather than a variable per
      # tunnel per field, because the whole point is that the set grows: a
      # third gluetun instance appears on the Network page with no change
      # here and none in the app.
      VPN_EGRESS = builtins.toJSON vpnEgress;

      # The third way in, which is no proxy at all: the WAN address itself,
      # kept current by platform/ddclient. What DEPENDS on that address is
      # the registry each service contributes to; the rest is how the job
      # that maintains it is configured, read from the service definition so
      # a change to the poll interval cannot leave a stale number on a page.
      DIRECT_INGRESS = builtins.toJSON (
        lib.mapAttrsToList (name: v: { inherit name; inherit (v) port proto note; }) config.fleet.directIngress
      );
      DDNS_HOST = lib.head (config.services.ddclient.domains ++ [ "" ]);
      DDNS_INTERVAL = config.services.ddclient.interval;
      DDCLIENT_VERSION = config.services.ddclient.package.version;

      # The resolver is a NixOS service rather than a pinned image, so the
      # package IS the running version — and FTL's own /api/info/version reads
      # /etc/pihole/versions, a file the Docker image writes and this
      # installation has never had (it answers `internal_error`). Read from the
      # package the service actually runs, not restated.
      PIHOLE_VERSION = config.services.pihole-ftl.package.version;
      # The two upstream resolvers every name that is not answered locally goes
      # to. Read from the same setting dnsmasq is configured with, so the page
      # cannot claim a resolver that stopped being used a rebuild ago; FTL
      # reports per-upstream counts and timings by IP, and this is what turns
      # those into a list with an order.
      DNS_UPSTREAMS = builtins.toJSON config.services.pihole-ftl.settings.dns.upstreams;
      # The DHCP scope and its fixed reservations, as pi-hole is configured
      # with them. `hosts` is "MAC,IP,hostname" per entry — the addresses that
      # are decided here rather than handed out, which is why they are worth a
      # panel: a device with a reservation is one something else on this box is
      # allowed to refer to by address.
      DHCP_CONFIG = builtins.toJSON {
        inherit (config.services.pihole-ftl.settings.dhcp)
          active
          router
          start
          end
          leaseTime
          hosts
          ;
      };
    };
  };

  # Same list-merge idiom stacks/litellm uses to add its token mount to
  # prometheus: the stack that OWNS the file contributes the mount, rather
  # than the apps platform learning about daedalus.
  virtualisation.oci-containers.containers.app-daedalus.volumes = [
    "${nixManifest}:/registry/manifest.json:ro"
    # The fleet.export domains (platform/export.nix): versioned, stamped JSON
    # per domain at a STABLE path — the publisher re-runs on change, the
    # container just reads new bytes. This is the successor to both the
    # manifest above and the per-fact env blobs; readers flip domain by
    # domain, then the old channels are deleted.
    "/run/daedalus-export:/export:ro"
    "${applyDir}:/apply"
    # Last deploy result per app, written by app-<name>-deploy.service
    # (`<digest> ok|failed`). Read-only, and the DIRECTORY rather than the
    # files, so a rewritten state file is picked up without pinning an inode.
    "/var/lib/app-deploy:/deploy-state:ro"
    # The DIRECTORY, not the files: the snapshot rewrites each one, and a
    # single-file bind would pin the old inode.
    "${envDir}:/env-snapshot:ro"
    # Running image labels, published by daedalus-image-snapshot. The
    # DIRECTORY, not the file, for the same reason as above: the snapshot is
    # replaced by rename and a single-file bind would pin the old inode.
    "${imageDir}:/images:ro"
    # SMART, pools, snapshots, replication and generations, published by
    # daedalus-system-snapshot. Read-only, and no secret in it — the closest
    # thing is a drive serial, which is printed on the drive.
    "${systemDir}:/system:ro"
    # Per-repo CI state (runners, the running job and its steps, recent runs),
    # published by gha-ci-snapshot in stacks/gha-runner. Read-only, and it is
    # the OUTPUT rather than the credential: the GitHub PAT has
    # Administration:write on those repos and stays host-side, exactly as it
    # is kept out of the runner containers themselves.
    "/run/gha-ci:/ci:ro"
  ];

  # Refresh the published environments. A timer rather than an on-demand
  # request/response through the bind mount: a container's env only changes
  # when it restarts, so a page render should read a recent snapshot rather
  # than wait on a round trip through systemd.
  systemd.services.daedalus-env-snapshot = {
    description = "Publish app container environments for daedalus";
    after = [ "linger-users.service" ];
    wants = [ "linger-users.service" ];
    before = [ "podman-app-daedalus.service" ];
    wantedBy = [ "podman-app-daedalus.service" ];
    serviceConfig = {
      Type = "oneshot";
      ExecStart = "${envSnapshotScript}/bin/daedalus-env-snapshot";
    };
  };

  # The running images' OCI labels — where a service pinned to a moving tag
  # states the version its pin cannot. Ordered before daedalus like the env
  # snapshot, so a fresh boot has one before the first render.
  systemd.services.daedalus-image-snapshot = {
    description = "Publish running container image labels for daedalus";
    after = [ "linger-users.service" ];
    wants = [ "linger-users.service" ];
    before = [ "podman-app-daedalus.service" ];
    wantedBy = [ "podman-app-daedalus.service" ];
    serviceConfig = {
      Type = "oneshot";
      ExecStart = "${imageSnapshotScript}/bin/daedalus-image-snapshot";
    };
  };

  # Both snapshots fail SILENTLY from the reader's side, which is the whole
  # reason they are monitored. A missing image snapshot does not blank a page —
  # `imageVersion` falls back to the flake pin, and for the services whose pin
  # is a channel it reports "unknown", which is indistinguishable from a
  # service that genuinely has no version. So a stuck oneshot would show up as
  # Shelfmark and Recyclarr quietly going back to saying nothing.
  #
  # No `slug`: these are not dead-man jobs. A missed run costs a stale reading
  # of something that changes on rebuilds, so a failure email is the whole of
  # what is wanted.
  fleet.monitoredJobs.daedalus-image-snapshot = { };
  fleet.monitoredJobs.daedalus-env-snapshot = { };

  # The export publisher must have populated /run/daedalus-export before the
  # container mounts it: rootless podman cannot create a root-owned /run dir,
  # and a bind mount of a missing source fails the whole container start.
  # (The publisher itself lives in platform/export.nix; only the ordering is
  # daedalus's concern.)
  systemd.services.daedalus-export-publish = {
    before = [ "podman-app-daedalus.service" ];
    wantedBy = [ "podman-app-daedalus.service" ];
  };

  # The host facts behind three System tabs. Runs as ROOT and unprivileged
  # nowhere: smartctl needs a raw device, and `zpool status` needs the pool.
  # No setpriv drop like its two siblings — there is no rootless store to
  # reach into here, only root-only tools.
  systemd.services.daedalus-system-snapshot = {
    description = "Publish SMART, ZFS and generation facts for daedalus";
    before = [ "podman-app-daedalus.service" ];
    wantedBy = [ "podman-app-daedalus.service" ];
    serviceConfig = {
      Type = "oneshot";
      ExecStart = "${systemSnapshotScript}/bin/daedalus-system-snapshot";
    };
  };

  # Same argument as the image snapshot: it fails silently from the reader's
  # side. A stale file does not blank the Disks tab, it shows yesterday's
  # temperatures as though they were now — which is worse than an empty panel,
  # because it looks like an answer.
  fleet.monitoredJobs.daedalus-system-snapshot = { };

  # Ten minutes. Everything in it moves in hours at best — a scrub runs
  # monthly, a self-test weekly, snapshot usage grows over days — and the one
  # genuinely live number, drive temperature, is not worth a shorter interval
  # on a box whose alerting has its own thresholds.
  systemd.timers.daedalus-system-snapshot = {
    wantedBy = [ "timers.target" ];
    timerConfig = {
      OnBootSec = "4min";
      OnUnitActiveSec = "10min";
    };
  };

  # Fifteen minutes, not two: an image label changes only when an image does,
  # which means a rebuild or a deploy pull — both of which restart the
  # container and re-run this via the ordering above. The timer is the
  # backstop for the third case, an out-of-band `podman pull`.
  systemd.timers.daedalus-image-snapshot = {
    wantedBy = [ "timers.target" ];
    timerConfig = {
      OnBootSec = "3min";
      OnUnitActiveSec = "15min";
    };
  };

  systemd.timers.daedalus-env-snapshot = {
    wantedBy = [ "timers.target" ];
    timerConfig = {
      OnBootSec = "2min";
      OnUnitActiveSec = "2min";
    };
  };

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

  # Repo-side CI actions (set the push credential, run the workflow). Same
  # file-drop bridge, third verb. Root because it reads a sops secret the
  # container must not hold and starts a systemd unit.
  systemd.services.daedalus-ci = {
    description = "Authorise a repo for the registry, or run its CI, on daedalus's behalf";
    after = [ "network-online.target" ];
    wants = [ "network-online.target" ];
    serviceConfig = {
      Type = "oneshot";
      ExecStart = "${ciScript}/bin/daedalus-ci";
      # Two GitHub round trips and a `systemctl start` that returns as soon as
      # the runner is up — this never waits for a workflow to finish.
      TimeoutStartSec = "3min";
    };
  };

  systemd.paths.daedalus-ci = {
    description = "Watch for a daedalus CI request";
    wantedBy = [ "multi-user.target" ];
    pathConfig.PathChanged = "${applyDir}/ci-request.json";
  };

  # Not monitoredJobs, unlike its two siblings: both verbs are synchronous
  # requests from somebody looking at the page, and the failure is reported
  # there with GitHub's own message. An email would arrive second, with less.

  # A failed apply means the box may have been rolled back without anyone
  # watching the UI. Mail it.
  fleet.monitoredJobs.daedalus-apply = { };

  # LiteLLM master key, extracted rather than inherited. Adding
  # `config.sops.secrets."litellm-env".path` to environmentFiles would work,
  # but that file is a full dotenv — UI credentials, the SSO client id/secret —
  # and none of it belongs in this container. Same one-source-of-truth idiom as
  # litellm-prom-token: rotation still touches only stacks/litellm/env.sops.
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
    prep = "TOKEN=$(grep '^DEPLOY_HOOK_TOKEN=' ${
      config.sops.secrets."registry-env".path
    } | head -1 | cut -d= -f2-)";
    content = "DEPLOY_HOOK_TOKEN=$TOKEN";
  };

  # The fleet's per-service read-only API keys — the credentials daedalus reads
  # other services' numbers with.
  #
  # `service-keys.sops` is the store: one encrypted file, all the keys minted by
  # some OTHER service and handed to the control plane to read with. Two keys
  # are NOT in it, on purpose — pocket-id's and plane's are minted by those
  # stacks and already have an encrypted home there, so they are read straight
  # out of it rather than copied here. Nothing in this box's secret tree exists
  # twice; rotation always touches exactly one file.
  #
  # `grep -m1` on each: a missing key renders empty rather than failing the
  # unit, and the panel that needs it degrades to "no data" instead of taking
  # the whole page down. PLANE_API_KEY is empty until someone mints a
  # workspace token in Plane's UI, so this is not hypothetical.
  sops.secrets."daedalus-service-keys" = mkDotenvSecret ./service-keys.sops;

  systemd.services."daedalus-dashboard-keys" =
    let
      store = config.sops.secrets."daedalus-service-keys".path;
      # <n> in the store → DASH_<n> in the container's environment.
      serviceKeys = [
        "JELLYFIN_API_KEY"
        "SONARR_API_KEY"
        "RADARR_API_KEY"
        "BAZARR_API_KEY"
        "PROWLARR_API_KEY"
        "SEERR_API_KEY"
        "QBT_USER"
        "QBT_PASS"
        "IMMICH_API_KEY"
        "NEXTCLOUD_KEY"
        "HASS_API_KEY"
        "GROCY_API_KEY"
        "N8N_API_KEY"
        "OPENWEBUI_KEY"
        "CALIBREWEB_USER"
        "CALIBREWEB_PASS"
        "GRAFANA_USER"
        "GRAFANA_PASS"
        "HEALTHCHECKS_API_KEY"
        "WGEASY_USER"
        "WGEASY_PASS"
        "CF_API_TOKEN"
        # Optional override for the GitHub reads (the add-an-app repo picker
        # and the release-notes panels): a narrow read-only PAT, taking
        # precedence over GHTOKEN below. Empty by default, and the reason to
        # fill it is scope rather than capability — see the note on GHTOKEN.
        "GITHUB_REPO_TOKEN"
      ];
    in
    mkSecretRender {
      description = "Render the per-service API keys daedalus's dashboard reads";
      gates = [ "podman-app-daedalus.service" ];
      dir = "/run/daedalus-dashboard";
      file = "/run/daedalus-dashboard/env";
      prep = lib.concatStringsSep "\n" (
        map (k: "${k}=$(grep -m1 '^${k}=' ${store} | cut -d= -f2- || true)") serviceKeys
        ++ [
          "POCKETID_KEY=$(grep -m1 '^STATIC_API_KEY=' ${
            config.sops.secrets."pocket-id-env".path
          } | cut -d= -f2- || true)"
          # Plane's public API is workspace-scoped and publishes NO endpoint
          # that lists workspaces — `/api/v1/workspaces/` is a 404, and a
          # token is only valid for the one it was minted in. So the slug is
          # not derivable from the credential and has to travel with it; it
          # lives in the same file for that reason rather than because it is
          # secret (it is not — it is in every URL of the UI).
          "PLANE_KEY=$(grep -m1 '^PLANE_API_KEY=' ${
            config.sops.secrets."plane-env".path
          } | cut -d= -f2- || true)"
          "PLANE_WORKSPACE=$(grep -m1 '^PLANE_WORKSPACE=' ${
            config.sops.secrets."plane-env".path
          } | cut -d= -f2- || true)"
          # Reading the zone needs a DIFFERENT Cloudflare token from the one in
          # service-keys.sops: that one is account-scoped for the tunnel and
          # answers `Unauthorized` on /zones (verified). The zone-scoped token
          # that already exists is the one lego and route-sync use, so this
          # reads that file rather than minting a third credential — the same
          # single-source rule the litellm master key follows. It is
          # DNS-edit-capable and daedalus only ever GETs with it; narrowing
          # that would mean a fourth token to rotate with the other three.
          "CF_DNS_TOKEN=$(grep -m1 '^CF_DNS_API_TOKEN=' ${
            config.sops.secrets."cloudflared-env".path
          } | cut -d= -f2- | tr -d '\"' || true)"
          # The GHCR pull credential, reused to authenticate the dashboard's
          # GitHub API reads. Two consumers: the release-notes panels, which
          # only want rate-limit headroom (60 requests an hour per IP
          # unauthenticated, 5000 authenticated), and the add-an-app repo
          # picker, which genuinely needs to SEE this account's private repos
          # and read their .github/workflows.
          #
          # Know what is in the container here: it is a CLASSIC PAT carrying
          # `gist, read:org, read:packages, repo`, and `repo` is read-WRITE on
          # every repository on the account. Daedalus only ever issues GETs
          # with it, but the credential itself is not read-only. Narrowing that
          # is what GITHUB_REPO_TOKEN above is for: a fine-grained read-only
          # PAT there takes precedence and this value stops being read from the
          # container at all (podman's own pulls, host-side, keep using it).
          #
          # No new secret to rotate as things stand: it expires and rotates
          # with the deploys it already gates. If it ever does expire, deploys
          # fail loudly, the release panels fall back to the unauthenticated
          # budget, and the repo picker falls back to public repos and says so.
          #
          # podman's auth.json is `{"auths":{"ghcr.io":{"auth":"<b64 user:token>"}}}`.
          # grep + cut + base64 rather than jq: mkSecretRender's PATH is
          # coreutils and gnugrep, and this is not worth widening it for.
          "GHTOKEN=$(grep -o '\"auth\"[[:space:]]*:[[:space:]]*\"[^\"]*\"' ${
            config.sops.secrets."ghcr-auth".path
          } | head -1 | cut -d'\"' -f4 | base64 -d 2>/dev/null | cut -d: -f2- || true)"
        ]
      );
      content = lib.concatStringsSep "\n" (
        map (k: "DASH_${k}=\${${k}}") serviceKeys
        ++ [
          "DASH_POCKETID_KEY=\${POCKETID_KEY}"
          "DASH_PLANE_KEY=\${PLANE_KEY}"
          "DASH_PLANE_WORKSPACE=\${PLANE_WORKSPACE}"
          "DASH_GITHUB_TOKEN=\${GHTOKEN}"
          "DASH_CF_DNS_TOKEN=\${CF_DNS_TOKEN}"
        ]
      );
    };

  systemd.services."daedalus-litellm-key" = mkSecretRender {
    description = "Render the litellm master key as daedalus's LITELLM_API_KEY";
    gates = [ "podman-app-daedalus.service" ];
    dir = "/run/daedalus-litellm";
    file = "/run/daedalus-litellm/env";
    prep = "KEY=$(grep '^LITELLM_MASTER_KEY=' ${
      config.sops.secrets."litellm-env".path
    } | head -1 | cut -d= -f2-)";
    content = "LITELLM_API_KEY=$KEY";
  };
}
