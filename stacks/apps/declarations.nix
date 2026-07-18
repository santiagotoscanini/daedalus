# Per-app declarations. Add entries here; the apps module
# (stacks/apps/apps.nix) composes container + traefik + observability
# + homepage + (optionally) postgres for each.
#
# Defaults inferred from the entry's key:
#   - image    = ghcr.io/santiagotoscanini/<name>:latest
#   - hostname = <name>.toscanini.me
#   - container = app-<name>
#   - homepage section = capitalized <name>
#
# Optional opt-ins:
#   - postgres.enable = true   → per-app postgres via stacks/app-db/
#   - prometheus.enable = true → /metrics scrape + Grafana dashboard; flip
#                                once the app actually ships /metrics
#   - stage = "live"           → public CNAME via Cloudflare tunnel
#   - deploy.enable = false    → freeze the app on its current image
#
# Workflow:
#   1. Push the code to github.com/santiagotoscanini/<name>; CI publishes
#      `ghcr.io/santiagotoscanini/<name>:latest`.
#   2. Add an entry below; `sudo nixos-rebuild switch`.
#
# That's the whole loop. From then on, every push to main goes live on its
# own: `app-<name>-deploy.timer` polls ghcr.io every 2 minutes, and when the
# digest moves it pulls, restarts the container, and health-checks it through
# traefik. No manual pull, no rebuild. Watch a deploy with
# `journalctl -fu app-<name>-deploy.service`; a deploy that comes back
# unhealthy leaves the unit failed (and the new image running — there is no
# auto-rollback). See stacks/apps/apps.nix + assets/deploy.sh.

{ config, mkDotenvSecret, ... }:

{
  # Operator-managed secrets for ipcrawl (Shodan key + hash peppers) —
  # sops class, tracked, editable with `sops ipcrawl-env.sops`. The
  # machine-generated secrets/ipcrawl/env keeps only the bootstrap
  # AUTH_SECRET (rotation: delete file + rebuild — never carries
  # operator values).
  sops.secrets."app-ipcrawl-env" = mkDotenvSecret ./ipcrawl-env.sops;

  myStack.apps.anansi = {
    postgres.enable = true;
    stage = "live";

    homepage = {
      description = "Anansi — task-tracking experiment";
      icon = "mdi-spider-#f59e0b";
    };
  };

  # ipcrawl — fork of github.com/alectrocute/ipcrawl (MIT). Upstream has no
  # Dockerfile and deploys as systemd+nginx on a VPS; the fork adds the
  # Dockerfile + .github/workflows/image.yml that publishes
  # ghcr.io/santiagotoscanini/ipcrawl:latest, so the `image` default applies
  # unchanged. Rebase the fork on upstream to pick up changes.
  myStack.apps.ipcrawl = {
    # SQLite + an fs-backed screenshot/SWR cache, no Postgres. Schema is
    # created in-process on boot (server/utils/exploreDb.ts ensureSchema),
    # so there's no migration step to run — the migrations/ dir upstream is
    # for their Cloudflare D1 path, not this one.
    storage.enable = true;

    # All outbound (camera live-probes + the daily Shodan pull) exits through
    # the dedicated ProtonVPN tunnel in stacks/ipcrawl-vpn/ instead of the
    # house WAN IP. The app leaves traefik-net and rides gluetun-ipcrawl's
    # netns; traefik reaches the UI via the host port gluetun publishes.
    egress = {
      container = "gluetun-ipcrawl";
      hostPort = 3100;
    };

    # LAN-only. This is a catalogue of other people's exposed webcams;
    # publishing it on a CNAME under our own domain is a decision to make
    # deliberately, not a default.
    stage = "lab";

    # Runtime flags. These are podman `--env` (win over the secrets
    # `--env-file` on any name collision), and Nuxt coerces the booleans
    # with `=== 'true'`, so the literal string "true" is the only thing
    # that enables them — "1"/"yes"/"TRUE" read as off.
    env = {
      # ON: probe cameras live so cards show current frames instead of the
      # static Shodan still. This dials arbitrary exposed cameras straight
      # from the house's IP — enabled deliberately.
      NUXT_ENABLE_LIVE_PROBE = "true";

      # Write successful live frames back into the screenshot store, so the
      # cached still stays fresh for when probing is off/unreachable.
      NUXT_ENABLE_LIVE_FRAME_PERSIST = "true";

      # Cams pulled per Shodan query. ~1 credit / 100 results / query, so
      # this is the main lever on credit burn. Upstream prod runs 2999.
      NUXT_SHODAN_LIMIT_PER_QUERY = "1500";

      # Maintenance brake, held off. "true" 503s the APIs and redirects
      # HTML to /offline-for-now.
      NUXT_OFFLINE_FOR_NOW = "false";

      # OFF: the Shodan pull runs on a Nitro in-process cron (daily 00:00),
      # not at boot. On-boot refresh only fires when the DB is empty, but
      # keeping it off means a fresh install waits for the cron or a manual
      # trigger rather than pulling during first boot.
      NUXT_SHODAN_REFRESH_ON_BOOT = "false";

      # The app reads its own canonical origin from this, not from the
      # APP_PUBLIC_URL the apps module injects.
      NUXT_PUBLIC_SITE_URL = "https://ipcrawl.toscanini.me";
    };
    # NUXT_SQLITE_PATH is baked into the image (=/app/data/explore.sqlite,
    # i.e. inside the storage bind mount) — deliberately not restated here,
    # so there's one source of truth for it.

    # NUXT_SHODAN_API_KEY + NUXT_VOTER_PEPPER + NUXT_CAM_ID_PEPPER —
    # operator secrets from ipcrawl-env.sops (see top of file). Without
    # a Shodan key the app still boots and serves; the catalogue is
    # just empty.
    environmentFiles = [ config.sops.secrets."app-ipcrawl-env".path ];

    homepage = {
      description = "ipcrawl — exposed-webcam catalogue (Shodan)";
      icon = "mdi-cctv-#38bdf8";
    };
  };
}
