# log-audit baseline — findings the operator has triaged as accepted

Do not re-report these as new findings. List them in the
"known/accepted" appendix only if their volume or shape changed.

## Accepted findings (operator decisions, 2026-07-18)

- **sonarr logs its app-db Postgres password in plaintext** on every
  migration run (`MigrationController: … Password=…;Port=5433`,
  journald → Loki). Accepted; no rotation. Upstream sanitizer gap
  (radarr/prowlarr redact the same line). Re-check after sonarr image
  bumps — report again only if still leaking on a version where
  upstream claims a fix.
- **nzbget has no active news server** (`[ERROR] At least one server
  must be active` at every start). Usenet is intentionally unused
  (torrents-only). Also covers its cosmetic config nags (empty
  ControlPassword, FormAuth-without-TLS, ArticleCache off).
- **janitorr has no HTTP surface to probe** — v2.x ships
  spring-boot-starter-actuator without a web starter, so no gatus
  endpoint / traefik route is possible. Its liveness IS covered by
  `container_up{name="janitorr"}` + the "Container Disappeared"
  Grafana alert (verified firing 2026-07-18 14:45 during a real
  outage). Don't report "janitorr invisible to monitoring".

## Characterized noise (verified benign 2026-07-18; skip unless shape changes)

- stderr→priority-3 mapping noise (INFO content at warn+ priority):
  cloudflared (~88 lines/boot), healthchecks/uwsgi (~86), stirling-pdf
  init (~70), node-exporter (~57), wireguard init chatter (~56),
  prometheus (~45), subgen, bazarr, factorio (curl progress bars).
- One-per-boot benign lines: loki `empty ring` cold-start error; alloy
  remotecfg `noop client` error; pg-exporter missing optional
  `postgres_exporter.yml`; bazarr duplicate-key language-table INSERTs
  into pg (4×); grocy chown-on-read-only settingoverrides; aardvark-dns
  empty-response burst during the container start storm;
  systemd-sysctl enp3s0 writes before the NIC exists; 1–2 failed
  transient podman healthcheck units (probe before ready).
- grafana `resource-client-auth-interceptor` warn (~28×/5 min,
  upstream noise); gatus alerting deliberately unconfigured (Grafana
  is the single alert path).
- Kernel one-liners on this hardware: nvme "using unchecked data
  buffer", INT3515 deferred probe, r8169 ASPM, ZFS/spl license taint.
- linuxserver images: `usermod: user abc is currently used`, metube
  PUID warning (deliberate PUID=0 mapping), jellyfin WebRootPath
  quirk.
- gluetun: PMTUD-failed MTU 1320 revert, ICMP-healthcheck fallback to
  DNS probes (rootless, no NET_RAW), exporter's 301 on the deprecated
  portforwarded API path.
- pocket-id: empty MAXMIND_LICENSE_KEY, quic-go UDP buffer note.
- immich: `path-to-regexp` route auto-conversion warning; 3× node WASI
  ExperimentalWarning. immich-postgres: 2× skipping missing optional
  `postgresql.override.conf`. immich-redis: valkey `No config file
  specified, using the default config` (stock defaults are deliberate —
  private bridge, no password).
- nextcloud-app: 3× `config/*.config.php differs from the latest version
  of this image` (our customized configs; the entrypoint just declines
  to overwrite them), 2× Apache AH00558 ServerName, 404s on
  `terms_of_service` from desktop clients probing an uninstalled app.
- shelfmark: `AuthlibDeprecationWarning: authlib.jose is deprecated`.
- seerr: `client.query() … deprecated and will be removed in pg@9.0`
  (bundled pg, nothing local to change).
- wealthfolio: `Unknown provider ID: CUSTOM_SCRAPER` — ordering artifact,
  the provider registers two lines later.
- calibre-web: `[cwa-checksum-backfill] Database schema not ready after
  30s, proceeding anyway` then completes successfully.

- **scraparr logs a burst of `No data found, assuming failure` /
  `No rootfolder data found`** for sonarr/radarr/prowlarr/jellyseerr in
  the first ~3 s of boot, then goes quiet. It polls the *arrs before
  their apps are listening (container-up ≠ app-ready). Converges on the
  next poll; unit ordering can't fix it (ordering gates on container
  launch, not app readiness). Accepted transient.
- **traefik startup-window 5xx** (≈11×502 + 3×500) on upstreams still
  starting — pocket-id, homepage, stirling-pdf, radarr, myspeed,
  jellyfin, gatus, calibre-web. All during the first minute; the
  platform's retry/health design covers it. Accepted transient. Report
  only if 5xx persist past startup or a *specific* router stays down.

## Fixed 2026-07-18 (report as REGRESSIONS if seen again)

- `newuidmap: executable file not found in $PATH` failures on
  podman-network-*/image-build oneshots at boot (fixed: /run/wrappers
  in unit path).
- systemd-tmpfiles "unsafe path transition" skips for
  /home/santiago/selfhost (fixed: statePaths now applied by the
  `state-paths.service` root oneshot).
- janitorr/wealthfolio/verdaccio startup crashes against
  seerr/pocket-id (fixed: unit ordering).
- pg tenants (pocket-id, gatus) crashing on `lookup pg … no such
  host` during mass restarts (fixed: direct consumer→pg ordering +
  pg_isready gate on podman-pg).
- bazarr gatus probe 401s (fixed: authenticated probe via
  webApps.healthHeaders + BAZARR_API_KEY in gatus env.sops).
- calibre-web ~700-line apt install of calibre on every start (fixed:
  the image now ships its own calibre tarball installer). NOTE — there
  is NO `localhost/calibre-web-calibre` local build; the stack runs
  upstream `docker.io/crocodilestick/calibre-web-automated` directly.
  Calibre 9.1.0 still re-installs on every container start (~88 lines in
  4 s) because /usr/bin is image-layer, not persisted. That is the
  accepted steady state — only the apt/dpkg/network path counts as a
  regression.
- **Fleet-wide ungraceful container shutdown → app-db pg WAL recovery
  on every reboot** (fixed 2026-07-18: `platform/common.nix`
  mkContainerOverride now orders every container `after`/`wants`
  `user@1000.service`, so podman stop runs before the user session and
  `/run/user/1000` tear down). REGRESSION signal: `podman-<x>-pre-stop`
  logging `RunRoot ... not writable` / `crun not found` / `status=125`
  at reboot, or pg logging `database system was not properly shut down;
  automatic recovery in progress` at boot. Verified at apply time via a
  test bounce: pg logged a clean `database system is shut down`. The
  real system-shutdown path is confirmed on the next actual reboot.
  CONFIRMED HOLDING on the 2026-07-30 reboot: both `pg` and
  `immich-postgres` logged clean shutdowns, no WAL recovery.

## Fixed 2026-07-30 (report as REGRESSIONS if seen again)

- **zot panicking on OIDC discovery at boot, killing the deploy loop.**
  It had no ordering on pocket-id at all, lost a ~5 s race, and died
  behind a green `active (exited)` unit; both `app-*-deploy` timers then
  failed every 2 min with `502 Bad Gateway` from
  `registry.toscanini.me`. Fixed by the new generalized gate below.
  REGRESSION signal: `panic: failed to initialize new relying party
  oidc`, or `PULL FAILED for registry.toscanini.me/...`.
- **The OIDC-discovery startup gate is now a platform option**:
  `fleet.sso.discoveryConsumers` (declared in `stacks/pocket-id`).
  Listing a container there orders it behind traefik + the IdP and adds
  the bounded discovery probe. gatus, zot, verdaccio and wealthfolio all
  went from hand-rolled blocks to one-liners. If a NEW stack does OIDC
  discovery at startup and panics/silently-breaks, the fix is one line —
  don't re-add a bespoke ExecStartPre.
- **pocket-id's expired-data cleanup was permanently self-blocked**:
  `francis_metadata.value` for `'last-cleanup'` held epoch-ms while the
  code reads it as a timestamp, so the upsert errored (SQLSTATE 22008)
  on the very row it needed to rewrite — sessions/tokens never GC'd.
  Fixed by the idempotent `pocket-id-cleanup-marker-repair` oneshot.
  REGRESSION signal: `date/time field value out of range` in pg, or
  `Error removing expired data` from pocket-id.
- **prometheus discarded its whole TSDB head on every unclean stop**
  (`out of sequence m-mapped chunk` → `discarding chunk files
  completely`), silently losing recent samples. Fixed with
  `--stop-timeout=60` so the head block flushes on SIGTERM.
- **The log pipeline had no monitoring of its own.** alloy is silent
  when healthy, so "stopped shipping" was indistinguishable from normal.
  Added `alloy` + `loki` prometheus scrapes and the
  `log-shipping-stalled-1` alert.

## Open decisions (not bugs — don't re-report as findings)

- **cleanuparr runs entirely in DRY RUN** (22+ `[DRY RUN] skipping
  method:` lines/boot covering SendRequestAsync, MarkFileAsSkipped,
  SendNotificationInternalAsync). This is why its
  `[QueueCleaner] Blocked item keeps coming back` loop repeats every
  5 min forever — items are only "deleted" in the log. Left as-is
  pending an operator decision; flipping it makes cleanuparr start
  actually deleting. Its startup health check also runs once and never
  re-reports, so it shows `0 healthy, 2 unhealthy` permanently after
  racing the *arrs at boot.
- **litellm reprints its startup banner every 30 s** (~5 760 lines/day),
  driven by the `STORE_MODEL_IN_DB=True` config-reload loop and emitted
  via `print()`, so no log level suppresses it. NOT fixed: dropping
  STORE_MODEL_IN_DB would also drop the DB-registered models and the
  pgvector vector stores, which are DB state, not config.
- **grocy's persisted LSIO nginx confs are 19–33 months behind** the
  image samples (`/config/nginx/{nginx,site-confs/default,ssl}.conf`);
  the image warns and skips its own migration. Refreshing them means
  overwriting live app state — needs an operator call, not a rebuild.
- **stirling-pdf's tessdata mount stays at `/usr/share/tessdata`**, and
  the "copying to system location" line at boot is correct behavior:
  mounting the host dir straight onto
  `/usr/share/tesseract-ocr/5/tessdata` would MASK the image's bundled
  English traineddata. Do not "fix" it.
- **calibre-web's credential-less OPDS poll every 60 s**
  (`OPDS Login failed for user "" IP-address: 10.89.11.1`, ~1 440
  WARN/day). 10.89.11.1 is the `iso-cleanuparr-net` gateway and
  cleanuparr is its only container member, but SNAT makes the
  attribution circumstantial — confirm the caller before changing
  anything.
- **traefik-oidc-auth refresh-token stampede**: one homepage page load
  fanned out 353 concurrent requests, 59 of which raced to redeem the
  same refresh token (37 `invalid_request` + 22 `invalid_grant` in a
  single second). Pocket ID behaved correctly; the plugin lacks a
  single-flight lock. Upstream defect, no local fix.
- **Ephemeral GHA runner registrations accumulate** on GitHub
  (`gha_runners_registered` 9 vs `gha_runners_online` 1 per repo).
  Harmless so far; wants a dereg-on-exit or a reaper.
