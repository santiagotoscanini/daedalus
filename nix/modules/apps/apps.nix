# apps — vibe-coded app wrapper.
#
# Each entry in `fleet.apps` materializes:
#   - A container `app-<name>` on `traefik-net`, listening on the
#     hardcoded internal port 3000. Also joins the shared `app-db-net`
#     bridge when `postgres.enable = true` (dials the shared `pg`
#     cluster there — see modules/app-db).
#   - A webApp at `<name>.<baseDomain>`. `stage = "live"` flips
#     exposeRemotely so cloudflared-route-sync upserts the public CNAME.
#   - (Opt-in, `prometheus.enable`) scrape on the app's own /metrics,
#     plus the per-app Grafana dashboard (in the "Apps" folder) when
#     one is supplied. Postgres metrics are separate — the shared
#     `app-db-exporter` (modules/app-db) covers them either way.
#   - An auto-deploy timer + oneshot (`deploy.enable`, ON by default) that
#     polls the image registry and redeploys the container when the digest
#     moves. This is the "push to main and it's live" half of the platform;
#     see assets/deploy.sh for why an explicit pull is unavoidable.
#
# Convention enforced: every app container LISTENS ON PORT 3000.
# No per-app port override. The image is built by us; the rule is ours.
#
# Naming: the declaration key (e.g. `anansi`) is used verbatim for the
# hostname `<name>.<baseDomain>`, the dashboard tag, the container name
# `app-<name>`, the
# postgres role + database `<name>` on the shared cluster (when
# `postgres.enable`), and its repository under the site's GitHub owner.
#
# Image default: `<registry hostname>/<name>:latest` — the box's own
# zot (modules/registry), fed by the build agent that builds every app
# image on this host (daedalus-build, stacks/daedalus). Override for
# forks or pinned digests.
#
# Source modes — `source.mode`, which half of the platform an app uses:
#
#   "registry" (default) — everything above. The box builds, zot hosts,
#                the deploy timer pulls. Push to main and it's live.
#   "local"    — the source lives on THIS HOST at `source.path` (daedalus:
#                the engine clone under the operator's projects) and is
#                bind-mounted at /app; the container runs a dev server
#                against it, so editing a file is the whole deploy. The
#                image built from `source.contextDir` carries only the
#                runtime: a mkLocalImage context is interpolated into
#                /nix/store, so code copied in would be a frozen snapshot
#                and hot reload would be watching the wrong files.
#                Suppresses the deploy timer (nothing to poll) and the
#                box's build agent (stacks/daedalus/build-agent.nix filters
#                on this). Current user: stacks/daedalus.
#
# Database: `postgres.enable = true` materializes a role + database
# on the shared `pg` cluster via modules/app-db. App reads
# `DATABASE_URL` from the bootstrap-generated env file
# (postgresql://<name>:<pwd>@pg:5432/<name>).
#
# Baseline secrets (always-on per app):
#   - AUTH_SECRET — random hex32, generated at first boot by
#     app-<name>-secrets-bootstrap.service, written to
#     <machineState>/apps/<name>/env (mode 0600, outside the checkout).
#     The app uses it for session signing / JWT / CSRF / etc.
#
# Optional features (opt-in; `false` by default):
#   - postgres.enable   → injects DATABASE_URL (+ POSTGRES_*)
#   - storage.enable    → bind-mounts a persistent data dir at /app/data
#   - litellm           → injects LITELLM_BASE_URL
#   - prometheus.enable → /metrics scrape + per-app Grafana dashboard
#   - auth.mode         → SSO against Pocket ID, either shape (below)
#   - …future features follow the same pattern (off by default,
#     env injection conditional on opt-in).
#
# SSO — `auth.mode`, one option covering both shapes:
#
#   "proxy"  — traefik's forward-auth middleware gates the router; the
#              app never learns there is an IdP. For apps with no user
#              model of their own (argus). Zero app-side work.
#   "native" — the app IS the OIDC client: it gets OIDC_ISSUER_URL,
#              OIDC_CLIENT_ID, OIDC_REDIRECT_URI, OIDC_PROVIDER_ID,
#              OIDC_SCOPES in its environment and OIDC_CLIENT_SECRET in
#              an env file. For apps with accounts of their own
#              (anansi), which keep per-user data isolation.
#
# Either way the client itself is declared, not clicked: the entry
# materializes `fleet.ssoClients.<name>` (modules/pocket-id/clients.nix),
# whose oneshot creates/updates it at the IdP with the id and secret
# this box chose. Adding SSO to an app is this one option: the secret is
# generated the first time the client is declared.
#
# Convention enforced #2: an app that needs a disk writes it to
# /app/data. Same reasoning as the port — we build the images, so we
# pick the path. `storage.enable = true` bind-mounts
# <stateRoot>/apps/<name>/data there (overridable via
# storage.hostPath); fleet.statePaths pre-creates it as the operator, which is
# what container UID 0 maps to under rootless podman. This is what
# SQLite / file-backed apps need; Postgres apps use postgres.enable
# instead, and an app can use both.
#
# Environment plumbing — fully declarative:
#
#   environmentFiles = [
#     <machineState>/apps/<name>/env    # always (AUTH_SECRET)
#     <machineState>/app-db/<name>/env  # when postgres=true
#     <user-supplied per-app overlays>             # via .environmentFiles
#   ];
#   environment = {
#     APP_NAME, APP_HOSTNAME, APP_PUBLIC_URL, PORT     # always
#     LITELLM_BASE_URL = http://litellm:4000           # when litellm = true
#     <user-supplied static env>                       # via .env
#
# The host brings:
#   fleet.modules.apps.enable   the switch (platform/apps-options.nix; default off)
#   site/apps.json              the registry, exported by the control plane's Apply
#   site/vault/apps/<n>-env.sops   an app's operator secrets, when it has any
# Requires the reverse proxy, the shared cluster (for postgres apps), the
# identity provider (for gated apps) and the registry (for the deploy loop).
#   };

{
  config,
  lib,
  pkgs,
  mkLocalImage,
  mkRootlessContainer,
  ...
}:

let
  cfg = config.fleet.apps;

  # The outer config's identity facts, bound here because the fleet.apps
  # submodule below shadows `config` with its own.
  inherit (config.fleet) operator;

  appSecretsBase = "${config.fleet.machineState}/apps";
  appDbEnvBase = "${config.fleet.machineState}/app-db";

  # Host tree backing `storage.enable`. One dir per app underneath —
  # and the app-adjacent state other stacks own (argus's gluetun/,
  # daedalus's apply/) nests in the same per-app dirs.
  appsDataRoot = "${config.fleet.stateRoot}/apps";

  # Last deploy result per app, `<digest> ok|failed`; a sibling
  # `<name>.pull` marker file means pulls are currently failing (the two
  # axes are independent — see deploy.sh). systemd owns the dir
  # (StateDirectory below); the state file is what keeps a failed deploy
  # loud across subsequent no-op ticks.
  deployStateDir = "/var/lib/app-deploy";

  # The deploy health-check dials traefik at the LAN IP directly rather
  # than trusting DNS, so a pi-hole hiccup can't read as a dead app.
  inherit (config.fleet) lanIp;

  # One DNS label, then the base domain. Dots in the domain are escaped so
  # they cannot act as the regex any-char and quietly admit "exampleXorg".
  hostnameRe = "[a-z0-9]([a-z0-9-]*[a-z0-9])?\\.${
    lib.replaceStrings [ "." ] [ "\\." ] config.fleet.baseDomain
  }";

  mkApp =
    name: app:
    let
      cName = "app-${name}";
      # `<name>.<baseDomain>` unless the app names its own. Overriding is a
      # pure rename of the published address: the container, the database, the
      # sops file and the repo all stay keyed by `name`.
      hostname = if app.hostname != null then app.hostname else "${name}.${config.fleet.baseDomain}";
      publicUrl = "https://${hostname}";

      # Baseline (always-on) per-app secrets file.
      appSecretsFile = "${appSecretsBase}/${name}/env";

      postgresEnabled = app.postgres.enable;
      appDbEnvFile = "${appDbEnvBase}/${name}/env";

      storageEnabled = app.storage.enable;
      storageHostPath = app.storage.hostPath;

      # `stage = "declared"` is the bottom rung: the row exists, and so do the
      # cheap durable things it will want — its postgres role, its data dir, its
      # generated secrets — but NOTHING runs. No container, no deploy unit.
      #
      # It exists because every app is in this state once, between "the entry
      # exists" and "there is an image to run", and without a name for it that
      # gap is a deadlock: the box only builds apps that are already in
      # site/apps.json, and an apps.json entry whose image does not exist yet
      # declares a container that cannot pull, which fails the switch, which
      # makes the Apply revert the very entry that would have allowed the build.
      # Under the Actions runners the repo's own CI published an image before
      # daedalus had ever heard of the app; nothing replaced that when the
      # runners went.
      running = app.stage != "declared";

      # `stage = "off"` means no ingress: no webApp, so no traefik router, no
      # DNS, no gatus probe, no Cloudflare route. The container still runs —
      # that is the difference from "declared", and it is the point: an app that
      # only ever talks to the database is off, not undeclared.
      exposed = running && app.stage != "off";

      # Local-source app (stacks/daedalus, the control plane): run from a checkout on this host
      # (`source.path`) instead of an image pulled from the registry, with the
      # source bind-mounted so a dev server hot-reloads it. See the `source`
      # option's description for
      # why the code must NOT ride in the image.
      localSource = app.source.mode == "local";

      # The runtime-only dev image. mkLocalImage tags with the build context's
      # store hash, so the tag — and therefore this container's ExecStart —
      # moves when the Containerfile changes and stays put when app code
      # changes. That asymmetry is the whole point: editing a route must not
      # restart anything. Forced only under `localSource`, so `contextDir`
      # being null in registry mode never gets interpolated.
      devImage = mkLocalImage {
        name = "${cName}-dev";
        tagPrefix = "dev";
        inherit (app.source) contextDir;
        gates = [ "podman-${cName}.service" ];
      };

      # cgroup v2 caps — see the `resources` option descriptions for what each
      # one actually enforces. Omitted entirely when null, so an app with no
      # limits produces the same podman command line it always did.
      #
      # `--memory-swap` is pinned to `--memory` deliberately: podman writes it
      # into memory.swap.max verbatim and defaults it to 2× memory when unset,
      # so NOT passing it triples the effective ceiling.
      resourceFlags =
        lib.optional (app.resources.cpus != null) "--cpus=${toString app.resources.cpus}"
        ++ lib.optionals (app.resources.memoryMb != null) [
          "--memory=${toString app.resources.memoryMb}m"
          "--memory-swap=${toString app.resources.memoryMb}m"
        ]
        ++ lib.optional (app.resources.pids != null) "--pids-limit=${toString app.resources.pids}";

      # VPN egress: borrow a gluetun container's netns for ALL traffic
      # instead of joining traefik-net (a gluetun instance the host runs). The
      # incompatibilities (postgres, prometheus, missing hostPort) are
      # enforced via `assertions` below.
      egressEnabled = app.egress.container != null;

      # ── scheduled tasks ───────────────────────────────────────────────────
      #
      # One `app-<name>-task-<id>` .service + .timer per entry, each a
      # `podman exec` into this app's own container — the same shape
      # nextcloud-cron has used for years (a file-sync stack the reference host runs), which is why
      # `User = <operator>` + XDG_RUNTIME_DIR is what makes rootless podman work
      # from a system unit. A task restarts nothing, so unlike the deploy unit
      # it needs no root and no setpriv.
      #
      # Gated on `running`: `podman exec` into a container that does not exist
      # fails every tick, and a `declared` app has no container. The
      # ASSERTIONS below are NOT gated — a malformed task is a malformed task
      # whether or not its unit is generated today, and finding out only at
      # promotion time would move the error away from the edit that caused it.
      taskUnits = lib.optionals running app.tasks;
      taskUnitName = t: "${cName}-task-${t.id}";

      # argv → one ExecStart line. `escapeShellArgs` gives systemd's own
      # parser single-quoted words, so nothing in a command value can split
      # into a second argument; `%` is doubled because systemd expands
      # specifiers before it splits the line, and a literal `%` in a command
      # would otherwise become something else entirely.
      taskExecStart =
        t:
        lib.replaceStrings [ "%" ] [ "%%" ] (
          lib.escapeShellArgs (
            [
              "${pkgs.podman}/bin/podman"
              "exec"
              cName
            ]
            ++ t.command
          )
        );

      # SSO. "proxy" = traefik forward-auth in front of the router;
      # "native" = the app is the OIDC client. Both declare the Pocket
      # ID client itself via fleet.ssoClients.
      proxyAuth = app.auth.mode == "proxy";
      nativeAuth = app.auth.mode == "native";
      # Isolation only makes sense for a bridge-routed forward-auth app
      # (see the option's description); egress apps aren't on a bridge.
      isolatedAuth = proxyAuth && app.auth.isolated;
      # Where the IdP sends the browser back. The forward-auth plugin
      # owns /oidc/callback on the app's own hostname; a native app
      # mounts its framework's callback path.
      oidcCallback =
        if proxyAuth then "${publicUrl}/oidc/callback" else "${publicUrl}${app.auth.callbackPath}";

      displayName = lib.toSentenceCase name;

      # Pull-and-redeploy. House style (cf. cloudflared-route-sync): nix
      # injects the parameters, the bash body lives in a standalone
      # shellcheckable assets/*.sh. setpriv/env/podman are absolute because
      # the privilege-dropped child doesn't inherit this PATH — see the
      # header of deploy.sh.
      deployScript = pkgs.writeShellApplication {
        name = "app-${name}-deploy";
        runtimeInputs = [
          pkgs.curl
          pkgs.systemd
          pkgs.coreutils
          pkgs.msmtp # send_alert in deploy.sh (transition emails)
        ];
        text = ''
          APP=${lib.escapeShellArg name}
          IMAGE=${lib.escapeShellArg app.image}
          UNIT=${lib.escapeShellArg "podman-${cName}.service"}
          APP_HOST=${lib.escapeShellArg hostname}
          HEALTH_PATH=${
            lib.escapeShellArg (
              # A gated app answers 302-to-the-IdP on "/", which passes
              # (< 500) while certifying the middleware rather than the
              # new image. The auth bypass path is the one URL that
              # still reaches the real upstream, so default to it.
              if app.deploy.healthPath != null then
                app.deploy.healthPath
              else if app.auth.healthPath != null then
                app.auth.healthPath
              else
                "/"
            )
          }
          HEALTH_TIMEOUT=${toString app.deploy.healthTimeout}
          # The health check dials the app THROUGH traefik, so `stage = "off"`
          # leaves nothing to dial and every deploy would report failure.
          EXPOSED=${if exposed then "1" else "0"}
          LAN_IP=${lib.escapeShellArg lanIp}
          STATE=${lib.escapeShellArg "${deployStateDir}/${name}"}
          # The published record daedalus decodes — see publish_state in the
          # script body. Same directory, so it rides the existing :ro mount.
          STATE_JSON=${lib.escapeShellArg "${deployStateDir}/${name}.json"}
          SETPRIV=${pkgs.util-linux}/bin/setpriv
          ENV_BIN=${pkgs.coreutils}/bin/env
          PODMAN=${pkgs.podman}/bin/podman
          OPERATOR_USER=${lib.escapeShellArg config.fleet.operator.user}
          OPERATOR_GROUP=${lib.escapeShellArg config.fleet.operator.group}
          OPERATOR_HOME=${lib.escapeShellArg config.fleet.operator.home}
          OPERATOR_RUNTIME_DIR=${lib.escapeShellArg config.fleet.operator.runtimeDir}
          # Names the box in the alert subjects.
          HOSTNAME=${lib.escapeShellArg config.networking.hostName}
          # Deploy-failure alert relay (platform/mail msmtp -> Gmail).
          NOTIFY_FROM=${lib.escapeShellArg config.fleet.mail.sender}
          NOTIFY_TO=${lib.escapeShellArg config.fleet.mail.alertTo}

          ${builtins.readFile ./assets/deploy.sh}
        '';
      };

    in
    {
      assertions = [
        {
          assertion = !(egressEnabled && app.egress.hostPort == null);
          message = "fleet.apps.${name}: `egress.container` is set but `egress.hostPort` is null — set the host port the netns owner publishes for this app.";
        }
        {
          assertion = !(egressEnabled && app.prometheus.enable);
          message = "fleet.apps.${name}: `egress` cannot combine with `prometheus.enable` — a netns'd app isn't reachable from monitoring-net, so the scrape target would be permanently down.";
        }
        {
          assertion = app.auth.isolated -> (proxyAuth && !egressEnabled);
          message = "fleet.apps.${name}: `auth.isolated` needs `auth.mode = \"proxy\"` and no `egress` — isolation puts the container on a private bridge whose only other member is traefik, which a netns'd app can't join and a native-OIDC app gains nothing from.";
        }
        {
          assertion = !(app.auth.isolated && app.prometheus.enable);
          message = "fleet.apps.${name}: `auth.isolated` cannot combine with `prometheus.enable` — prometheus dials the app over traefik-net, which isolation removes.";
        }
        {
          assertion = app.auth.headers != { } -> proxyAuth;
          message = "fleet.apps.${name}: `auth.headers` are set by the forward-auth middleware — they only exist under `auth.mode = \"proxy\"`.";
        }
        {
          assertion = localSource -> (app.source.path != null && app.source.contextDir != null);
          message = "fleet.apps.${name}: `source.mode = \"local\"` needs both `source.path` (the host dir bind-mounted at /app) and `source.contextDir` (the dir holding the dev Containerfile).";
        }
        {
          assertion = !localSource -> (app.source.path == null && app.source.contextDir == null);
          message = "fleet.apps.${name}: `source.path` / `source.contextDir` only apply to `source.mode = \"local\"` — a registry app runs a prebuilt image and mounts no source.";
        }
        {
          assertion = localSource -> !egressEnabled;
          message = "fleet.apps.${name}: `source.mode = \"local\"` cannot combine with `egress` — the dev server's install step needs the npm registry, which a VPN-only netns doesn't route to.";
        }
        {
          assertion = proxyAuth -> exposed;
          message = "fleet.apps.${name}: `auth.mode = \"proxy\"` needs an ingress to gate — the forward-auth middleware is generated from the webApp, and `stage = \"off\"` emits none. Use `auth.mode = \"none\"` while it is unexposed, or expose it.";
        }
        {
          assertion = app.prometheus.enable -> exposed;
          message = "fleet.apps.${name}: `prometheus.enable` with `stage = \"off\"` would be a permanently-down scrape target — an unexposed app leaves traefik-net, so prometheus cannot reach it.";
        }
        {
          # Rejected at eval rather than left to fail at runtime, because the
          # runtime failure is a TLS error in the browser with a valid-looking
          # config behind it — the router works, the DNS works, and only the
          # cert is wrong.
          assertion = app.hostname == null || builtins.match hostnameRe app.hostname != null;
          message = "fleet.apps.${name}: hostname \"${toString app.hostname}\" must be exactly one label under ${config.fleet.baseDomain} (e.g. \"chat.${config.fleet.baseDomain}\"). traefik serves a single wildcard cert, `sans=*.${config.fleet.baseDomain}`, which matches one label only — a deeper name would get the wrong certificate, and the CF tunnel and pi-hole make the same assumption. A second apex needs its own cert, tunnel config and DNS.";
        }
        {
          assertion = lib.all (h: builtins.match hostnameRe h != null) app.hostnameAliases;
          message = "fleet.apps.${name}: every hostnameAliases entry must be exactly one label under ${config.fleet.baseDomain}, for the same wildcard-certificate reason as hostname.";
        }
        {
          # Not tidiness: a duplicate id would define ONE unit twice, and the
          # module system would merge two different commands into a single
          # `app-<name>-task-<id>` whose ExecStart is whichever definition won.
          # The operator would see one task in daedalus and another on the box.
          assertion = lib.length (lib.unique (map (t: t.id) app.tasks)) == lib.length app.tasks;
          message = "fleet.apps.${name}: two tasks share an id (${
            lib.concatStringsSep ", " (map (t: t.id) app.tasks)
          }) — task ids must be unique within an app, because each one becomes exactly one systemd unit named app-${name}-task-<id>.";
        }
      ]
      ++ lib.concatMap (t: [
        {
          # SECURITY CONTROL, not validation for its own sake: this string is
          # interpolated into a systemd unit name, and the daedalus bridge
          # (stacks/daedalus/host/task-run.sh) hands that name to a root
          # `systemctl start`. Anything outside [a-z0-9-] — a slash, a dot, a
          # space, `../` — is an attempt to name a unit other than this task's.
          # The charset is checked here so a bad id can never reach a unit
          # name at all, in addition to the bridge's allowlist.
          assertion = builtins.match "[a-z0-9][a-z0-9-]{0,39}" t.id != null;
          message = "fleet.apps.${name}: task id \"${t.id}\" is not allowed — it must match ^[a-z0-9][a-z0-9-]{0,39}$ (lowercase letters, digits and dashes, starting with a letter or digit, at most 40 characters). The id becomes part of the systemd unit name app-${name}-task-${t.id}, which root starts, so the charset is a security boundary. Rename the task in daedalus.";
        }
        {
          assertion = t.command != [ ];
          message = "fleet.apps.${name}: task \"${t.id}\" has an empty `command` — give it the argv to run inside the container, e.g. [ \"node\" \"scripts/digest.mjs\" ]. An empty command would generate a unit that execs nothing and fails on every tick.";
        }
        {
          assertion = t.timeoutSec > 0;
          message = "fleet.apps.${name}: task \"${t.id}\" has timeoutSec = ${toString t.timeoutSec} — it must be a positive number of seconds (the default is 900). It becomes TimeoutStartSec on the generated unit, where 0 means \"no timeout at all\" and a hung run would hold the unit active forever.";
        }
        {
          # The contract puts schedule expansion in the app, not here (nix
          # stays dumb: JSON in, system out). systemd's shorthands would be
          # ACCEPTED by the timer, which is exactly the problem — `hourly` and
          # `daily` both fire at :00, where myspeed's speedtest saturates the
          # uplink and takes house-wide DNS with it for a minute or two. A job
          # landing there fails to resolve and can still report success.
          assertion =
            !(lib.elem t.schedule [
              "minutely"
              "hourly"
              "daily"
              "monthly"
              "weekly"
              "yearly"
              "annually"
              "quarterly"
              "semiannually"
            ]);
          message = "fleet.apps.${name}: task \"${t.id}\" uses the systemd shorthand schedule \"${t.schedule}\", which fires on the hour. Write a concrete OnCalendar with a minute that is not :00 (e.g. \"*-*-* 04:23:00\") — daedalus expands its hourly/daily presets to one before writing apps.json, for exactly this reason.";
        }
      ]) app.tasks;

      # The Pocket ID client.
      #
      # Native mode declares the whole thing — id `<name>`, and a secret
      # generated on first declaration. modules/pocket-id/clients.nix mints it,
      # converges the client at the IdP and hands the container its
      # OIDC_CLIENT_SECRET env file.
      #
      # Proxy mode declares only the copy: the client itself is derived from
      # the webApp's `auth = "oidc"` like every other forward-auth'd app,
      # but what it is CALLED has no mechanical source, so it comes from the
      # same place the app's own row does.
      fleet.ssoClients =
        lib.optionalAttrs nativeAuth {
          "${name}" = {
            inherit displayName;
            inherit (app.presentation) description;
            launchURL = publicUrl;
            callbackURLs = [ oidcCallback ];
            logoutCallbackURLs = [ oidcCallback ];
            inherit (app.auth) allowedGroups;
            consumers = [ cName ];
          };
        }
        // lib.optionalAttrs (proxyAuth && exposed) {
          "${name}" = {
            inherit displayName;
            inherit (app.presentation) description;
          };
        };

      # Delegate per-app Postgres entirely to modules/app-db. The
      # presence of the key triggers role + database creation and the
      # per-app env file. LAN access is the single shared
      # `postgres.<baseDomain>:5432` TCP/SNI route (modules/app-db).
      #
      # `reach` is DERIVED from egress rather than asked for: an app in
      # gluetun's netns has no bridge interface, so `pg` cannot resolve
      # there and it must use the plain-TCP host port. That is the same
      # path the TV stack's *arrs already take. Asking the operator to
      # state it as well would be a second fact that can disagree with
      # the first.
      # The role and database are made even while `declared`: they are cheap,
      # they survive, and the first build wants DATABASE_URL to exist. But the
      # default consumer list names this app's container, and ordering against a
      # unit that does not exist is how an allowlist outruns its units.
      fleet.appDatabases = lib.optionalAttrs postgresEnabled {
        "${name}" = {
          reach = if egressEnabled then "hostPort" else "bridge";
        }
        // lib.optionalAttrs (!running) { consumers = [ ]; };
      };

      # Register in bridgeMemberships either way — that's what earns the
      # mandatory Type=oneshot systemd override (rootless podman + Type=notify
      # is broken on this box). "traefik" joins the bridge for DNS routing;
      # `[ ]` means pasta/netns with NO bridge (egress mode borrows gluetun's
      # netns via extraOptions, and traefik reaches it via the published host
      # port — see webApps below). Same shape as the TV stack's `sonarr = [ ]`.
      # `auth.isolated` swaps the shared bridge for a private one; that
      # membership comes from webApps.isolated, and listing "traefik"
      # here as well would re-open the shared path (assertion in
      # platform/publishing.nix).
      # `exposed` gates the traefik membership too: an app with no router has
      # no reason to sit on the shared bridge. The key itself is still emitted
      # (possibly as `[ ]`), because that registration is what earns the
      # mandatory Type=oneshot override.
      # …and `running` gates the key itself, because that registration is what
      # MAKES the systemd override; a membership naming a container this
      # configuration never declares fails eval on the missing image.
      fleet.bridgeMemberships = lib.optionalAttrs running {
        "${cName}" =
          lib.optional (exposed && !egressEnabled && !isolatedAuth) "traefik"
          ++ lib.optional (postgresEnabled && !egressEnabled) "app-db";
      };

      # Web exposure — hardcoded internal port 3000. Bridge-routed by default
      # (serviceName on traefik-net). In egress mode the app can't ride
      # traefik-net, so traefik dials the host port gluetun publishes via
      # host.containers.internal — the same escape hatch the TV stack uses.
      # `stage = "off"` emits NO webApp at all, which is what actually removes
      # the ingress: traefik routers, the pi-hole DNS entry, the gatus probe
      # and the Cloudflare route are all materialized from this one attrset
      # (platform/publishing.nix). Dropping it is therefore a real state, not a
      # cosmetic flag — nothing is left listening for that hostname.
      fleet.webApps = lib.optionalAttrs exposed {
        "${name}" = {
          inherit hostname;
          aliases = app.hostnameAliases;
          exposeRemotely = app.stage == "live";
        }
        // (lib.optionalAttrs proxyAuth {
          auth = "oidc";
          isolated = isolatedAuth;
          inherit (app.auth) authBypassRule;
          authHeaders = app.auth.headers;
          # The webApp is where the derived client reads its group
          # restriction from, so proxy mode routes `auth.allowedGroups`
          # through it rather than declaring the client itself.
          authGroups = app.auth.allowedGroups;
        })
        # gatus probes the real upstream on this path either way; under
        # "proxy" it doubles as the middleware's bypass (publishing.nix
        # appends it), which is what keeps the probe off the IdP.
        // (lib.optionalAttrs (app.auth.healthPath != null) { inherit (app.auth) healthPath; })
        // (
          if egressEnabled then
            { serviceUrl = "http://host.containers.internal:${toString app.egress.hostPort}"; }
          else
            {
              serviceName = cName;
              port = 3000;
            }
        );
      };

      # Prometheus scrapes the app's own /metrics endpoint (when
      # prometheus.enable). Postgres metrics come from the single
      # shared `app-db-exporter` declared in modules/app-db/exporter.nix —
      # the dashboard breaks them out per-app via the `datname` label.
      # No per-app scrape entry here.
      fleet.prometheusScrapes = lib.optional app.prometheus.enable {
        job_name = cName;
        static_configs = [
          {
            targets = [ "${cName}:3000" ];
            labels = {
              app = name;
            };
          }
        ];
        metrics_path = app.prometheus.path;
      };

      # Grafana dashboard in the "Apps" folder (when supplied). Gated on
      # prometheus.enable alongside the scrape: the dashboard is
      # metrics-driven, so without a scrape it would only render empty
      # panels.
      fleet.grafanaDashboardsByFolder =
        lib.optionalAttrs (app.prometheus.enable && app.prometheus.dashboard != null)
          {
            "Apps"."${cName}" = lib.replaceStrings [ "%APP_NAME%" ] [ name ] (
              builtins.readFile app.prometheus.dashboard
            );
          };

      # Persistent data dir — the fleet-standard statePaths convention
      # (uid 0 default = container root = the operator; state-paths.service
      # sorts paths so parents are created before children, and every
      # podman unit orders after it).
      fleet.statePaths = lib.optionalAttrs storageEnabled (
        lib.optionalAttrs (lib.hasPrefix "${appsDataRoot}/" storageHostPath) {
          "${appsDataRoot}" = { };
          "${appsDataRoot}/${name}" = { };
        }
        // {
          "${storageHostPath}" = { };
        }
      );

      # One attrset rather than four `systemd.services."x" = …` statements:
      # the image-build unit must be absent (not merely disabled) for registry
      # apps, and `lib.optionalAttrs` cannot be mixed with dotted-path
      # definitions of the same attribute.
      systemd.services = {
        # Baseline secrets bootstrap. Generates AUTH_SECRET on first boot
        # and writes the per-app env file. Idempotent: re-running is safe;
        # the env file is created only if missing. Delete the file +
        # rebuild to rotate (invalidates any sessions/JWTs signed with
        # the old AUTH_SECRET).
        "app-${name}-secrets-bootstrap" = {
          description = "Bootstrap app-${name}: generate AUTH_SECRET on first boot";
          before = [ "podman-${cName}.service" ];
          wantedBy = [ "podman-${cName}.service" ];
          after = [ "local-fs.target" ];
          path = [
            pkgs.openssl
            pkgs.coreutils
          ];
          serviceConfig = {
            Type = "oneshot";
            RemainAfterExit = true;
            Restart = "on-failure";
            RestartSec = "5s";
          };
          script = ''
            set -eu
            install -d -m 0700 -o ${operator.user} -g ${operator.group} "${appSecretsBase}/${name}"
            if [ ! -e "${appSecretsFile}" ]; then
              AUTH_SECRET=$(openssl rand -hex 32)
              install -m 0600 -o ${operator.user} -g ${operator.group} /dev/stdin "${appSecretsFile}" <<EOF
            AUTH_SECRET=$AUTH_SECRET
            EOF
            fi
          '';
        };

        # Auto-deploy. Pulls the image; restarts the container only if the
        # digest actually moved; then health-checks it through traefik. Runs as
        # root (it must restart a system unit) and drops to the operator for podman.
        #
        # No RemainAfterExit — unlike every bootstrap oneshot here, this one has
        # to run again on every tick.
        "app-${name}-deploy" = {
          # A `declared` app has no container to redeploy into, and its image
          # is the thing that does not exist yet.
          enable = app.deploy.enable && running;
          description = "Redeploy app-${name} when a new image lands on the registry";
          # linger-users gates /run/user/1000 → rootless podman → newuidmap.
          after = [
            "network-online.target"
            "linger-users.service"
            "podman-${cName}.service"
          ];
          wants = [
            "network-online.target"
            "linger-users.service"
          ];
          serviceConfig = {
            Type = "oneshot";
            StateDirectory = "app-deploy";
            ExecStart = "${deployScript}/bin/app-${name}-deploy";
          };
        };

        # Container ordering: the secrets bootstrap plus (egress mode) the
        # netns owner. The pg + per-app-bootstrap edges are NOT repeated
        # here — appDatabases.consumers already generates both (including
        # the transaction-proof direct podman-pg edge). The local-source
        # image build adds its own before=/wantedBy= edges via mkLocalImage's
        # `gates`, so it needs no entry here either.
      }
      // lib.optionalAttrs running {
        "podman-${cName}" = {
          after = [
            "app-${name}-secrets-bootstrap.service"
          ]
          ++ (lib.optional egressEnabled "podman-${app.egress.container}.service");
          wants = [
            "app-${name}-secrets-bootstrap.service"
          ]
          ++ (lib.optional egressEnabled "podman-${app.egress.container}.service");
        };
      }
      // lib.optionalAttrs localSource {
        "app-${name}-image-build" = devImage.service;
      }
      // lib.listToAttrs (
        map (t: {
          name = taskUnitName t;
          value = {
            description = "Scheduled task ${t.id} for app-${name}";
            # `requires`, not just `wants`: the whole unit is a podman exec
            # into that container, so without it there is nothing to run.
            # linger-users gates /run/user/1000 → rootless podman → newuidmap.
            after = [
              "podman-${cName}.service"
              "linger-users.service"
            ];
            requires = [
              "podman-${cName}.service"
              "linger-users.service"
            ];
            serviceConfig = {
              Type = "oneshot";
              # No RemainAfterExit: this runs again on every tick.
              TimeoutStartSec = t.timeoutSec;
              # Rootless podman from a system unit — the nextcloud-cron shape.
              User = operator.user;
              Environment = "XDG_RUNTIME_DIR=${operator.runtimeDir}";
              ExecStart = taskExecStart t;
            };
          };
        }) taskUnits
      );

      systemd.timers = {
        "app-${name}-deploy" = {
          enable = app.deploy.enable && running;
          description = "Poll the registry for a new app-${name} image";
          wantedBy = [ "timers.target" ];
          timerConfig = {
            OnCalendar = app.deploy.interval;
            Persistent = true; # catch up if the box was off
            RandomizedDelaySec = 45; # don't have every app hit the registry on the same second
          };
        };
      }
      // lib.listToAttrs (
        map (t: {
          name = taskUnitName t;
          value = {
            description = "Schedule for app-${name} task ${t.id} (${t.schedule})";
            wantedBy = [ "timers.target" ];
            timerConfig = {
              OnCalendar = t.schedule;
              Persistent = true; # a run missed while the box was off still happens
              RandomizedDelaySec = 45; # two apps sharing a minute don't start on the same second
            };
          };
        }) taskUnits
      );

      # A failed run is exactly the thing worth an email — nobody is watching
      # a 04:23 job. Registered only for units that exist: mail.nix asserts
      # every monitoredJobs entry names a real unit with an ExecStart, so a
      # `declared` app's tasks must not appear here either.
      fleet.monitoredJobs = lib.listToAttrs (
        map (t: {
          name = taskUnitName t;
          value = { };
        }) taskUnits
      );

      # The container itself — pure declarative, identical pattern to
      # every other stack on the box.
      virtualisation.oci-containers.containers = lib.optionalAttrs running {
        "${cName}" = mkRootlessContainer (
          {
            image = if localSource then devImage.image else app.image;

            # A hostPath on another dataset additionally picks up RequiresMountsFor for
            # free — podman.nix extracts it from `volumes`, closing the
            # cold-boot race where the container starts before the ZFS
            # dataset mounts and writes into the empty underlay.
            #
            # The local-source mount goes at /app, i.e. the image's WORKDIR:
            # this is the live repo directory, not a copy, which is what lets
            # the dev server watch files edited on the host. /app/data (storage)
            # nests inside it when both are on; podman orders nested mounts by
            # path depth, so the inner one still wins.
            volumes =
              lib.optional localSource "${app.source.path}:/app"
              ++ lib.optional storageEnabled "${storageHostPath}:/app/data";

            environmentFiles = [
              appSecretsFile
            ]
            ++ (lib.optional postgresEnabled appDbEnvFile)
            ++ app.environmentFiles;

            environment = {
              APP_NAME = name;
              APP_HOSTNAME = hostname;
              APP_PUBLIC_URL = publicUrl;
              PORT = "3000";
              # Auth.js v5 / NextAuth sits behind traefik, so the request
              # Host is the public hostname (<name>.<baseDomain>), not the
              # in-container `app-<name>:3000` the framework auto-derives.
              # Without these two, Auth.js bails on every /api/auth/* call
              # with `UntrustedHost`. Set at the platform level since every
              # reverse-proxied app on this PaaS hits the same wall.
              AUTH_TRUST_HOST = "true";
              AUTH_URL = publicUrl;
            }
            # Only while a rename is in progress. Emitted unconditionally, an
            # empty value would still change every app's unit and restart the
            # whole apps fleet on the switch that introduced it.
            // (lib.optionalAttrs (app.hostnameAliases != [ ]) {
              APP_HOSTNAME_ALIASES = lib.concatStringsSep "," app.hostnameAliases;
            })
            // (lib.optionalAttrs app.litellm.enable {
              LITELLM_BASE_URL = "http://litellm:4000";
            })
            # Native OIDC. The client secret is NOT here — it arrives as
            # OIDC_CLIENT_SECRET in a rendered env file that
            # modules/pocket-id/clients.nix appends to this container (the
            # `consumers` entry above), so it never sits in /nix/store.
            // (lib.optionalAttrs nativeAuth {
              OIDC_ISSUER_URL = config.fleet.sso.issuerUrl;
              OIDC_CLIENT_ID = name;
              OIDC_REDIRECT_URI = oidcCallback;
              OIDC_PROVIDER_ID = app.auth.providerId;
              OIDC_PROVIDER_NAME = "Pocket ID";
              OIDC_SCOPES = app.auth.scopes;
            })
            // app.env;

            # Every app image lives on the box's own zot, which serves
            # anonymous reads — container pulls carry no credential at all.
            #
            # `--init`: every app here is node as PID 1, and node does not reap.
            # An app that spawns processes (plutus drives chromium) leaves each
            # orphaned grandchild as a zombie holding a pid until the container's
            # 2048 ceiling, where it can no longer fork and dies under a green
            # oneshot — the failure one MCP sidecar documented, measured there at
            # ~14 pids an hour. catatonit is PID 1 instead; signals still reach the
            # app, which podman forwards through it. Platform-wide rather than per
            # app because we build these images and the rule is ours, like port 3000.
            extraOptions = [
              "--init"
            ]
            ++ (lib.optional egressEnabled "--network=container:${app.egress.container}")
            ++ resourceFlags;
          }
          // (lib.optionalAttrs (app.cmd != null) { inherit (app) cmd; })
          # In egress mode podman needs the netns owner up first; dependsOn
          # adds Requires=+After= on its unit (same as the TV arrs on gluetun).
          // (lib.optionalAttrs egressEnabled { dependsOn = [ app.egress.container ]; })
        );
      };
    };
in
{
  # `fleet.modules.apps.enable` and the whole `fleet.apps` option tree are
  # DECLARED by the platform (platform/apps-options.nix): the control
  # plane writes `fleet.apps.daedalus` and must evaluate without this file.
  # This module is the implementation — what an entry materializes into.

  # Per-path assembly, NOT `config = lib.mkMerge fragments`: the
  # fragment list depends on `config.fleet.apps`, so a definition
  # spanning the whole `fleet` attrset would force the list while
  # resolving `fleet.apps` itself — infinite recursion. Keeping every
  # contributed path explicit (one level below fleet/systemd/...)
  # lets `fleet.apps` resolve without forcing the fragments. A new
  # output path in mkApp must be registered here too.
  config =
    let
      fragments = lib.mapAttrsToList mkApp cfg;
      attrsOpt = path: lib.mkMerge (map (f: lib.attrByPath path { } f) fragments);
      listOpt = path: lib.concatLists (map (f: lib.attrByPath path [ ] f) fragments);
      # Every key a fragment may emit, by prefix. attrNames doesn't
      # force values, so this map is recursion-safe; a mkApp output
      # key missing here fails eval below instead of being silently
      # discarded.
      registered = {
        "" = [
          "assertions"
          "fleet"
          "systemd"
          "virtualisation"
        ];
        fleet = [
          "appDatabases"
          "bridgeMemberships"
          "monitoredJobs"
          "ssoClients"
          "statePaths"
          "webApps"
          "prometheusScrapes"
          "grafanaDashboardsByFolder"
        ];
        systemd = [
          "services"
          "timers"
        ];
        virtualisation = [ "oci-containers" ];
      };
      unregistered = lib.unique (
        lib.concatMap (
          f:
          lib.subtractLists registered."" (lib.attrNames f)
          ++
            lib.concatMap
              (p: map (k: "${p}.${k}") (lib.subtractLists registered.${p} (lib.attrNames (f.${p} or { }))))
              [
                "fleet"
                "systemd"
                "virtualisation"
              ]
        ) fragments
      );
    in
    lib.mkIf config.fleet.modules.apps.enable {
      assertions = listOpt [ "assertions" ] ++ [
        {
          assertion = unregistered == [ ];
          message = "modules/apps: mkApp emits unregistered option path(s): ${lib.concatStringsSep ", " unregistered} — register them in the per-path assembly.";
        }
      ];

      fleet = {
        # Every app's AUTH_SECRET used to live under stacks/apps/secrets in the
        # checkout; see platform/machine-state.nix for why it moved and why each
        # bootstrap REQUIRES the migration rather than merely following it.
        machineStateLegacy.apps = "${config.fleet.config.repo}/stacks/apps/secrets";
        machineStateReaders = map (n: "app-${n}-secrets-bootstrap.service") (lib.attrNames cfg);
        appDatabases = attrsOpt [
          "fleet"
          "appDatabases"
        ];
        monitoredJobs = attrsOpt [
          "fleet"
          "monitoredJobs"
        ];
        bridgeMemberships = attrsOpt [
          "fleet"
          "bridgeMemberships"
        ];
        ssoClients = attrsOpt [
          "fleet"
          "ssoClients"
        ];
        statePaths = attrsOpt [
          "fleet"
          "statePaths"
        ];
        webApps = attrsOpt [
          "fleet"
          "webApps"
        ];
        prometheusScrapes = listOpt [
          "fleet"
          "prometheusScrapes"
        ];
        grafanaDashboardsByFolder = attrsOpt [
          "fleet"
          "grafanaDashboardsByFolder"
        ];
      };

      virtualisation.oci-containers.containers = attrsOpt [
        "virtualisation"
        "oci-containers"
        "containers"
      ];

      systemd.services = attrsOpt [
        "systemd"
        "services"
      ];
      systemd.timers = attrsOpt [
        "systemd"
        "timers"
      ];
    };
}
