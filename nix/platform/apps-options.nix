{ config, lib, ... }:

# fleet.apps — the DECLARATION of the apps registry, and nothing else.
#
# Each entry describes one self-built app: where its code comes from, its
# hostname and stage, and which platform features it opts into (postgres,
# storage, SSO, metrics, scheduled tasks, resource caps). The module that
# MATERIALIZES an entry — the `app-<name>` container, its webApp, the deploy
# timer, the secrets bootstrap — is the apps stack, which is not in this tree
# yet. The declaration lives here, ungated, because the control plane's own
# module writes `fleet.apps.daedalus` and reads the registry for its pages: an
# engine whose options are declared by a stack it does not ship cannot be
# evaluated by anyone else.
#
# Until the apps stack migrates, a host WITHOUT it can define `fleet.apps`
# entries and nothing will run them.
#
# Two defaults read other modules' values, lazily:
#   image             `<fleet.webApps.registry.hostname>/<name>:latest` — the
#                     container-registry stack publishes that webApp. Only
#                     forced for a `source.mode = "registry"` app.
#   storage.hostPath  under `<fleet.stateRoot>/apps`.

let
  # The outer config's facts, bound here because the submodule below shadows
  # `config` with its own.
  site = config.fleet;
  inherit (config.fleet) operator;
  registryHost = config.fleet.webApps.registry.hostname;
  appsDataRoot = "${config.fleet.stateRoot}/apps";
in
{
  # The apps stack's switch, declared beside the registry it gates so a module
  # here can read it (the control plane gates what it defines under its own
  # container on it). The stack that implements it is not in this tree yet: a
  # host without that stack sets this to false, and `fleet.apps` entries are
  # then declarations nothing runs.
  options.fleet.modules.apps.enable = lib.mkOption {
    type = lib.types.bool;
    default = true;
    description = "The apps platform: the self-built apps declared in site/apps.json, deployed from the box's own registry.";
  };

  options.fleet.apps = lib.mkOption {
    type = lib.types.attrsOf (
      lib.types.submodule (
        { name, config, ... }: {
          options = {
            # Where the running code comes from. "registry" is the platform's
            # normal loop (the box builds, zot hosts, the deploy timer pulls);
            # "local" is the escape hatch for an app whose source lives in
            # this flake repo and is edited in place.
            source = {
              mode = lib.mkOption {
                type = lib.types.enum [
                  "registry"
                  "local"
                ];
                default = "registry";
                description = ''
                  "registry" — the image is built on this box by the build
                  agent (daedalus-build), pushed to `${registryHost}`,
                  and pulled here by `app-<name>-deploy.timer`. Push to main
                  and it's live.

                  "local" — the source lives on this host at `source.path`
                  (daedalus: the engine clone under ${operator.home}/projects) and
                  is bind-mounted into the container at /app, which runs a dev
                  server against it. Editing a file IS the deploy: no commit,
                  no build, no image pull, no rebuild. The image built from
                  `source.contextDir` carries ONLY the runtime — copying the
                  code in would defeat the whole thing, since a `mkLocalImage`
                  context is interpolated into /nix/store and frozen there.

                  Consequences of "local", all deliberate: no auto-deploy
                  timer (nothing to poll), nothing for the build agent to
                  build (only registry-mode apps are buildable), and the app's
                  availability now depends on the npm registry at container
                  start.
                '';
              };
              path = lib.mkOption {
                type = lib.types.nullOr lib.types.str;
                default = null;
                description = ''
                  Local mode: host directory bind-mounted at /app. A plain
                  string, NOT a nix path — a path literal would be copied into
                  /nix/store and the container would watch the frozen copy.
                '';
                example = "${operator.home}/projects/daedalus/app";
              };
              contextDir = lib.mkOption {
                type = lib.types.nullOr lib.types.path;
                default = null;
                description = ''
                  Local mode: directory holding the dev runtime's
                  `Containerfile`. Keep the app source OUT of it — the store
                  hash of this directory is the image tag, so anything in here
                  restarts the container when it changes.
                '';
                example = lib.literalExpression "./assets";
              };
            };

            image = lib.mkOption {
              type = lib.types.str;
              default = "${registryHost}/${name}:latest";
              description = ''
                OCI image. Default: `${registryHost}/<name>:latest` —
                the box's own zot (stacks/registry). Convention is to host
                each app at `github.com/${site.github.owner}/<name>`; a push to
                main there is built on this box by the build agent
                (daedalus-build) and pushed here. Override for placeholders,
                forks, or pinned digests (the immutable `sha-<sha>` tags the
                build agent pushes beside `latest`).

                Ignored entirely when `source.mode = "local"` — that image is
                built on the box from `source.contextDir`.
              '';
              example = "${registryHost}/example:sha-89dfc4456f8b2c4531f84790cce5e179bdaeae6a";
            };

            cmd = lib.mkOption {
              type = lib.types.nullOr (lib.types.listOf lib.types.str);
              default = null;
              description = ''
                Optional cmd override (escape hatch — apps should normally
                bake their start command into the image CMD).
              '';
            };

            hostname = lib.mkOption {
              type = lib.types.nullOr lib.types.str;
              default = null;
              defaultText = lib.literalExpression ''"''${name}.''${fleet.baseDomain}"'';
              example = "chat.${site.baseDomain}";
              description = ''
                Published address. Null = `<name>.<baseDomain>`.

                Must be exactly ONE label under `fleet.baseDomain` (asserted).
                That is not stylistic — three things downstream assume it:

                  * traefik's ACME cert is a single entrypoint-level wildcard,
                    `main=<baseDomain>` + `sans=*.<baseDomain>`
                    (stacks/traefik). A wildcard matches one label, so
                    `a.b.${site.baseDomain}` would serve the wrong cert and every
                    browser would refuse it.
                  * the Cloudflare tunnel's CNAMEs are upserted into that one
                    zone (stacks/cloudflared).
                  * pi-hole short-circuits `*.<baseDomain>` to the LAN IP.

                A second apex would need its own cert, its own tunnel config
                and its own DNS — hence the assertion rather than a note.

                Changing this renames only the published address. The
                container, the postgres role and database, the sops file and
                the GitHub repo all stay keyed by the attribute name. What DOES
                follow it: the traefik router, the pi-hole record, the gatus
                probe, the CF route, `AUTH_URL`/`APP_PUBLIC_URL`, and the
                Pocket ID redirect URI — so an SSO app is briefly unable to
                complete a login between the rebuild and the IdP catching up.
              '';
            };

            hostnameAliases = lib.mkOption {
              type = lib.types.listOf lib.types.str;
              default = [ ];
              example = [ "old-name.${site.baseDomain}" ];
              description = ''
                Addresses that serve this app beside `hostname` — a rename in
                progress, where the old name keeps working until the new one
                is confirmed (`fleet.webApps.<name>.aliases`: router, pi-hole,
                tunnel, Pocket ID callbacks). Same one-label rule as
                `hostname`. Handed to the container as APP_HOSTNAME_ALIASES,
                comma-separated, for servers that check the Host header.
              '';
            };

            stage = lib.mkOption {
              type = lib.types.enum [
                "declared"
                "off"
                "lab"
                "live"
              ];
              default = "lab";
              description = ''
                How the app is reachable — four rungs, each adding to the last.

                "declared" = nothing runs. No container, no deploy unit, no
                ingress. The row exists and so do the cheap durable things it
                will want: its postgres role and database, its data directory,
                its generated AUTH_SECRET. This is the rung every app sits on
                between "the entry exists" and "there is an image to run", and
                it is what makes that possible at all: the box only builds apps
                already present in site/apps.json, so an app must be applied
                before it can be built — and applying one whose image does not
                exist yet would declare a container that cannot pull, fail the
                switch, and roll the Apply back. Promote it once the first
                build has published an image.

                "off"  = no ingress at all. No traefik router, no DNS entry,
                no gatus probe, no Cloudflare route. The container still runs
                and still deploys; nothing can reach it over HTTP. For an app
                that is mid-migration, or one that only ever needed to talk to
                the database. NOT the same as "declared", and not the same as
                stopping it.

                "lab"  = LAN-only (<name>.${site.baseDomain} via pi-hole + traefik).

                "live" = adds Cloudflare-tunnel exposure (public CNAME via
                cloudflared-route-sync). The *.${site.baseDomain} wildcard cert
                covers both — no per-app cert work.

                Consequence of "off" worth knowing: the deploy health check
                runs THROUGH traefik, so with no ingress there is nothing to
                check. Deploys still pull and restart, they just cannot certify
                that the new image serves — see assets/deploy.sh.
              '';
            };

            # VPN egress via a gluetun (or other netns-owning) container. See
            # `mkGluetunInstance`. When set, the app borrows that container's
            # network namespace for ALL traffic instead of joining traefik-net:
            # outbound exits the VPN (fail-closed), and traefik reaches the UI via
            # the host port the netns owner publishes
            # (`host.containers.internal:<egress.hostPort>`). Mutually exclusive
            # with `postgres.enable` and `prometheus.enable` (a netns'd app
            # isn't scrapable from monitoring-net) — enforced via assertions.
            egress = {
              container = lib.mkOption {
                type = lib.types.nullOr lib.types.str;
                default = null;
                description = ''
                  Name of a netns-owning container (e.g. a gluetun instance)
                  whose network namespace this app joins via
                  `--network=container:<name>`. null = normal traefik-net.
                '';
                example = "gluetun-example";
              };
              hostPort = lib.mkOption {
                type = lib.types.nullOr lib.types.port;
                default = null;
                description = ''
                  Host port the netns owner publishes for this app's :3000,
                  which traefik dials via host.containers.internal. Required
                  when `egress.container` is set.
                '';
                example = 3100;
              };
            };

            # Plain Postgres-per-app, materialized by stacks/app-db/.
            postgres = {
              enable = lib.mkOption {
                type = lib.types.bool;
                default = false;
                description = ''
                  When true, materialize a role + database `<name>` on
                  the shared `pg` cluster via stacks/app-db/. The app
                  container joins the shared `app-db-net` bridge and
                  receives DATABASE_URL
                  (postgresql://<name>:<pwd>@pg:5432/<name>) via env
                  file. See stacks/app-db/README.md.
                '';
              };
              # No per-app resource tunables: the cluster is shared, so
              # cpus/memory are set once in stacks/app-db/app-db.nix.
              # For app-scoped throttling, use postgres role-level
              # settings: ALTER ROLE <name> CONNECTION LIMIT N;
              # ALTER ROLE <name> SET statement_timeout = '30s'; etc.
            };

            # Persistent disk for file-backed apps (SQLite, caches, uploads).
            storage = {
              enable = lib.mkOption {
                type = lib.types.bool;
                default = false;
                description = ''
                  When true, bind-mount `storage.hostPath` at `/app/data`
                  inside the container and pre-create it (0755 ${operator.user}:${operator.group})
                  via fleet.statePaths. Off by default — stateless apps get
                  no disk.

                  /app/data is a convention, not an option, exactly like the
                  port-3000 rule: we build the images, so we pick the path.
                '';
              };
              hostPath = lib.mkOption {
                type = lib.types.str;
                default = "${appsDataRoot}/${name}/data";
                description = ''
                  Host dir backing /app/data. The default sits under
                  `fleet.stateRoot` (small records, frequent+hourly+daily
                  snapshots), which is right for a small SQLite file but
                  expensive for a large, churning blob cache — snapshot
                  deltas balloon. Point high-churn apps at a bulk-data root
                  instead (a `fleet.data` entry; on ZFS, a one-time
                  `zfs create -o mountpoint=legacy <pool>/<name>` plus an
                  entry in the host's `fleet.zfs.datasets`).
                '';
              };
            };

            # SSO against Pocket ID. Both shapes declare the client in
            # the same place (fleet.ssoClients) — what differs is who
            # holds the credential: traefik's middleware, or the app.
            auth = {
              mode = lib.mkOption {
                type = lib.types.enum [
                  "none"
                  "proxy"
                  "native"
                ];
                default = "none";
                description = ''
                  "none" — no SSO (the app's own auth, or none at all).

                  "proxy" — traefik's generated `oidc-<name>`
                  forward-auth middleware gates the router(s); the app
                  is never reached unauthenticated and needs no code.
                  For apps with no user model. Requires
                  `auth.healthPath` (the middleware would otherwise 302
                  every gatus probe to the IdP).

                  "native" — the app is the OIDC client itself. It
                  receives OIDC_ISSUER_URL, OIDC_CLIENT_ID,
                  OIDC_REDIRECT_URI, OIDC_PROVIDER_ID, OIDC_PROVIDER_NAME
                  and OIDC_SCOPES in its environment, plus
                  OIDC_CLIENT_SECRET from a rendered env file. Preferred
                  whenever the app HAS accounts, since only the app can
                  map an IdP identity onto its own per-user data
                  (AUTH.md's order of preference).
                '';
              };
              allowedGroups = lib.mkOption {
                type = lib.types.listOf lib.types.str;
                default = [ "admins" ];
                description = ''
                  Pocket ID group names allowed to use this client —
                  authorization enforced at the IdP, before the app.
                  Admin-only by default; add a household group for shared apps.
                  `[ ]` means any account with a passkey gets in.
                '';
              };
              healthPath = lib.mkOption {
                type = lib.types.nullOr lib.types.str;
                default = null;
                description = ''
                  Unauthenticated path that proves the app itself is
                  serving. Becomes the webApp's gatus probe, the
                  forward-auth bypass (proxy mode), and the auto-deploy
                  health check — so a redeploy is certified by the app
                  rather than by a 302 to the IdP. Mandatory under
                  `mode = "proxy"`.
                '';
                example = "/api/healthz";
              };
              authBypassRule = lib.mkOption {
                type = lib.types.nullOr lib.types.str;
                default = null;
                description = ''
                  Extra traefik rule expression whose matches skip the
                  forward-auth middleware — for machine endpoints that
                  carry their own auth. Proxy mode only.
                '';
                example = "PathPrefix(`/api`)";
              };
              headers = lib.mkOption {
                type = lib.types.attrsOf lib.types.str;
                default = { };
                description = ''
                  Identity headers the middleware forwards upstream
                  (name -> Go template over claims). Proxy mode only,
                  and empty by default: an app that trusts a header
                  blindly should also set `auth.isolated`, since any
                  container on traefik-net could otherwise dial it
                  directly and forge one.
                '';
                example = lib.literalExpression ''
                  { "X-Forwarded-Email" = "{{ .claims.email }}"; }
                '';
              };
              isolated = lib.mkOption {
                type = lib.types.bool;
                default = false;
                description = ''
                  Move the container off traefik-net onto a private
                  `iso-<name>-net` bridge whose only other member is
                  traefik, so the forward-auth middleware is the only
                  possible caller. The right default for any app using
                  `auth.headers`; incompatible with `egress` and
                  `prometheus.enable`.
                '';
              };
              providerId = lib.mkOption {
                type = lib.types.str;
                default = "pocket-id";
                description = ''
                  Native mode: the provider id the app registers Pocket
                  ID under. Frameworks derive the callback path from it
                  (Auth.js: /api/auth/callback/<providerId>), so it has
                  to agree with the app's code — it is half of the
                  redirect URI registered at the IdP.
                '';
              };
              callbackPath = lib.mkOption {
                type = lib.types.str;
                default = "/api/auth/callback/pocket-id";
                description = ''
                  Native mode: path (on the app's own hostname) the IdP
                  redirects back to. The default is Auth.js's shape for
                  `providerId = "pocket-id"`. Registered as the client's
                  callback URL and handed to the app as
                  OIDC_REDIRECT_URI, so the two can never disagree.
                '';
              };
              scopes = lib.mkOption {
                type = lib.types.str;
                default = "openid profile email groups";
                description = ''
                  Native mode: space-separated scopes, passed as
                  OIDC_SCOPES. `groups` is what lets an app read the
                  user's Pocket ID groups out of the ID token.
                '';
              };
            };

            litellm.enable = lib.mkOption {
              type = lib.types.bool;
              default = false;
              description = ''
                Opt-in: when true, sets `LITELLM_BASE_URL = http://litellm:4000`
                in the app's environment. Off by default — apps that don't
                use the LLM gateway never see the variable.

                Does NOT inject the master key. Apps that need it add
                the litellm sops secret
                (config.sops.secrets."litellm-env".path) to their
                `environmentFiles`.
              '';
            };

            # Auto-deploy — the "push to main and it's live" half of the platform.
            # See this module's header and assets/deploy.sh.
            deploy = {
              enable = lib.mkOption {
                type = lib.types.bool;
                default = config.source.mode == "registry";
                defaultText = lib.literalExpression ''config.source.mode == "registry"'';
                description = ''
                  Poll the registry and redeploy the container when the image digest
                  moves. ON by default for registry apps: every one of them rides a
                  moving `:latest` the box's build agent publishes on push-to-main,
                  so "new image → run it" is the expected behaviour, not an opt-in.
                  OFF by default
                  under `source.mode = "local"`, where there is no registry to poll
                  and the source is already live.

                  Turn OFF to freeze an app on whatever it's running — pair with a
                  digest- or sha-pinned `image` to hold a known-good build.
                '';
              };
              interval = lib.mkOption {
                type = lib.types.str;
                default = "*:0/2";
                description = ''
                  systemd OnCalendar for the poll. Since build.sh starts the deploy
                  itself, this is the safety net rather than the path a push takes:
                  the default (every 2 min) is the worst-case latency when that
                  start did not happen. A pull of an unchanged tag is one manifest
                  request.
                '';
              };
              healthPath = lib.mkOption {
                type = lib.types.nullOr lib.types.str;
                default = null;
                description = ''
                  Path fetched through traefik after the restart to decide whether
                  the new image is alive. Any status < 500 counts — an Auth.js app
                  302-ing to a login page is a working app.

                  null falls back to `auth.healthPath`, else "/". That
                  fallback is what keeps the check honest on a
                  forward-auth'd app, where "/" is a 302 to the IdP that
                  a dead container would answer just as well.
                '';
              };
              healthTimeout = lib.mkOption {
                type = lib.types.int;
                default = 90;
                description = ''
                  Seconds to wait for the app to answer after the restart. On
                  timeout the new image keeps running and the unit fails loudly
                  (deploy-and-report — there is no auto-rollback).
                '';
              };
            };

            prometheus = {
              enable = lib.mkOption {
                type = lib.types.bool;
                default = false;
                description = ''
                  Add a prometheus scrape for `<cName>:3000<path>` and
                  materialize the per-app Grafana dashboard (when one is
                  supplied). Off by default — flip to true when the app
                  ships a /metrics endpoint; a scrape without one is just
                  a permanently-down target in Prometheus.
                '';
              };
              path = lib.mkOption {
                type = lib.types.str;
                default = "/metrics";
                description = "metrics_path of the prometheus scrape.";
              };
              dashboard = lib.mkOption {
                type = lib.types.nullOr lib.types.path;
                default = null;
                description = ''
                  Optional Grafana dashboard JSON. `%APP_NAME%` placeholders
                  are substituted with the app's name. Lands under the "Apps"
                  folder. Nested under `prometheus` because it only renders
                  when `enable` is on — the dashboard is metrics-driven, so
                  without the scrape it would only show empty panels.
                '';
              };
            };

            # How the app is named to a person: its row in daedalus, and
            # its entry on the Pocket ID consent screen.
            #
            # No icon here. Every app publishes its own — it is what the
            # browser tab shows — so daedalus reads it from the app rather
            # than from a second copy that has to be kept in agreement.
            presentation = {
              description = lib.mkOption {
                type = lib.types.str;
                default = "";
                description = "One-line subtitle under the app name.";
              };
            };

            # cgroup v2 caps. All three are enforceable rootless on this box
            # because systemd delegates `cpu io memory pids` down to
            # user@1000.service (check with `cat
            # /sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/cgroup.controllers`);
            # without that delegation podman would accept the flags and the
            # kernel would ignore them.
            #
            # Null everywhere by default. An app the platform silently caps is
            # an app that dies at 3am for a reason nobody wrote down, and the
            # right ceiling is per-app knowledge — so opting in is explicit.
            resources = {
              cpus = lib.mkOption {
                type = lib.types.nullOr lib.types.float;
                default = null;
                example = 1.5;
                description = ''
                  CPU cores, as a cgroup bandwidth cap
                  (`cpu.max = cpus*100000 100000`). Fractional is fine.

                  A ceiling on throughput, NOT a reservation and NOT pinning:
                  the app may still be scheduled on any core, and under
                  contention it simply gets throttled instead of preempting
                  something else. For a latency-sensitive app, throttling is
                  often worse than the contention it prevents — cap the noisy
                  neighbour instead.
                '';
              };

              memoryMb = lib.mkOption {
                type = lib.types.nullOr lib.types.ints.positive;
                default = null;
                example = 512;
                description = ''
                  Resident memory cap in MiB (`memory.max`). Also passed as
                  `--memory-swap`, which is the LOWEST value podman accepts
                  (it rejects `--memory-swap` below `--memory`).

                  What that actually means here, because it is not what the
                  docker flag names suggest: podman 5.7 + crun 1.24 write
                  `--memory-swap` into `memory.swap.max` verbatim, without
                  subtracting `--memory` the way the docker docs describe. So
                  the cap is `N` of RAM plus up to `N` of swap — and this box
                  swaps to zram, so that overflow is compressed RAM, not disk.
                  Anonymous pages past `N` get pushed to zram; the OOM kill
                  lands at `2N`. Leaving `--memory-swap` off is worse: podman
                  defaults it to `2*memory`, i.e. a `3N` kill point.

                  Page cache counts toward `memory.max` but is reclaimed under
                  pressure rather than triggering a kill, so an app doing heavy
                  file I/O will sit at its limit permanently and that is
                  normal — read `container_memory_usage_bytes` next to the
                  kill counter, not on its own.
                '';
              };

              pids = lib.mkOption {
                type = lib.types.nullOr lib.types.ints.positive;
                default = null;
                example = 200;
                description = ''
                  Max processes + threads (`pids.max`). A fork-bomb guard, and
                  the cheapest of the three to get wrong: every runtime thread
                  counts, so a Node app with a worker pool or a JVM can sit
                  surprisingly high. Check `container_pids` before setting it —
                  hitting this limit surfaces as EAGAIN from fork/pthread_create,
                  which most runtimes report as something misleading.
                '';
              };
            };

            # Scheduled work the app itself defines: a digest to send, a
            # cache to rebuild, a nightly import. One systemd timer + oneshot
            # per entry, each a `podman exec` into the app's own container —
            # so a task runs the image that is deployed, with the app's whole
            # environment (DATABASE_URL, AUTH_SECRET, operator secrets) already
            # in it, and nothing has to be re-plumbed here.
            #
            # A list, not an attrset, because the registry round-trips through
            # daedalus's database where these rows are ordered and `id` is a
            # column — the same reason `env` is a list of {key, value}.
            tasks = lib.mkOption {
              type = lib.types.listOf (
                lib.types.submodule {
                  options = {
                    id = lib.mkOption {
                      type = lib.types.str;
                      example = "digest";
                      description = ''
                        Short name, unique within the app: `^[a-z0-9][a-z0-9-]{0,39}$`,
                        asserted. It becomes the systemd unit name
                        `app-<name>-task-<id>`, which root starts (daedalus's
                        Run-now bridge), so the charset is a security control
                        rather than a naming convention.
                      '';
                    };
                    schedule = lib.mkOption {
                      type = lib.types.str;
                      example = "*-*-* 04:23:00";
                      description = ''
                        A concrete systemd `OnCalendar` expression. Never a
                        bare `hourly`/`daily` — asserted: both fire at :00,
                        where myspeed's speedtest drops house-wide DNS for a
                        minute or two and a job that lands there fails to
                        resolve while still reporting success.

                        The presets live in daedalus's UI, which expands them
                        to a concrete string (with a stable per-app minute in
                        1..59) BEFORE writing apps.json. Nix does no
                        arithmetic on the schedule: JSON in, system out, and
                        the UI can show the exact minute a task will run
                        precisely because it chose it.
                      '';
                    };
                    command = lib.mkOption {
                      type = lib.types.listOf lib.types.str;
                      example = [
                        "node"
                        "scripts/digest.mjs"
                      ];
                      description = ''
                        argv, run as `podman exec app-<name> <argv>`. A list,
                        never a shell string: there is no quoting to get
                        wrong, no word splitting, and nothing for a value to
                        escape out of. The working directory and environment
                        are the container's own.
                      '';
                    };
                    timeoutSec = lib.mkOption {
                      # `int` rather than ints.positive so the assertion below
                      # can name the app and the task; a type error would only
                      # name the option path.
                      type = lib.types.int;
                      default = 900;
                      description = ''
                        `TimeoutStartSec` on the generated unit: a run still
                        going after this is SIGTERMed and the unit fails
                        (which mails, via fleet.monitoredJobs).
                      '';
                    };
                  };
                }
              );
              default = [ ];
              description = ''
                Scheduled tasks for this app. Each materializes
                `app-<name>-task-<id>.service` + `.timer`, registered in
                `fleet.monitoredJobs` so a failed run mails like every other
                scheduled job on the box.

                Generated only while the app is past `stage = "declared"` —
                a `podman exec` into a container that does not exist would
                fail on every tick. The field validations apply either way.
              '';
            };

            env = lib.mkOption {
              type = lib.types.attrsOf lib.types.str;
              default = { };
              description = ''
                Static env vars merged into the container's `environment`.
                NOT for secrets — visible in /nix/store. For secrets, add
                an env file to `environmentFiles`.
              '';
            };

            environmentFiles = lib.mkOption {
              type = lib.types.listOf lib.types.path;
              default = [ ];
              description = ''
                Additional env files passed via --env-file. Common uses:
                per-app secrets, third-party API keys, the litellm
                master key (config.sops.secrets."litellm-env".path).
                Conventions: `0600 ${operator.user}:${operator.group}`; hand-managed files
                live under `**/secrets/` so the path is gitignored.
              '';
            };
          };
        }
      )
    );
    default = { };
    description = ''
      The apps registry: one entry per self-built app. Materialized by the
      apps stack.
    '';
  };
}
