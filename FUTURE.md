# FUTURE.md — deferred improvements

Items consciously deferred from the 2026-07-15 gap-to-SOTA audit.

## 1. Adopt native OIDC for wg-easy + seerr when upstream ships it

The box-wide Pocket ID SSO migration (2026-07) is done — every web UI
authenticates through Pocket ID (passkeys) except two, which keep their
current local login to avoid a second login prompt until each ships
native OIDC. Full per-service auth map, group access model, and the
recipe to onboard a service/user live in `/etc/nixos/AUTH.md`.

- **seerr** — Jellyfin-credential login today. Native OIDC merged in
  [PR #2715](https://github.com/seerr-team/seerr/pull/2715), milestoned
  v3.5.0 (testing: [discussion #2721](https://github.com/seerr-team/seerr/discussions/2721)).
  When released: create a Pocket ID client, enable OIDC in Seerr, add it
  to the `family` group.
- **wg-easy** — v15 local account (+TOTP). OAuth **shipped** in
  [v15.4.0-beta.1](https://github.com/wg-easy/wg-easy/releases/tag/v15.4.0-beta.1)
  (`feat: oauth integration`): a generic OIDC provider configured via
  `OAUTH_PROVIDERS` + `OAUTH_OIDC_SERVER` / `OAUTH_OIDC_CLIENT_ID` /
  `OAUTH_OIDC_CLIENT_SECRET`, i.e. fully declarable. Still prerelease,
  so we stay on 15.3.0. When it goes stable: Pocket ID client, the
  three env vars into `stacks/wg-easy/env.sops`, drop the
  `INIT_USERNAME`/`INIT_PASSWORD` local account, keep in `admins`.
  Previously tracked as unshipped in
  [issue #1923](https://github.com/wg-easy/wg-easy/issues/1923) (also #2374).

Not candidates (no viable OIDC path — stay on their own auth, documented
in AUTH.md "Out of scope"): **jellyfin** (native TV/mobile clients can't
do OIDC) and **factorio-admin** (OFSM unmaintained, login can't be
disabled → would force a double login, explicitly not wanted).

Trigger to revisit: seerr cuts a release with OIDC, or wg-easy 15.4.0
leaves beta.

## 2. Off-site ZFS sync to an external service

Local replication (rpool → s2-pool mirror, see platform/backup.nix) covers
disk failure but NOT fire, theft, or ransomware — all copies live in
one house. Deferred for cost reasons (2026-07-15).

Plan when picked up, either of:
- `zfs send` / syncoid to a ZFS-capable target (rsync.net, or a
  relative's box with a mirror pair), or
- declarative `services.restic.backups` → Backblaze B2 for the
  irreplaceable set (~700 GB: /s2/immich, /s2/santi, /s2/sofi,
  /s2/shared, replicated selfhost) — ~USD 4–5/month.

Trigger to revisit: budget available, or any close call with the data.

## 3. PgBouncer in front of the shared app-db cluster

`max_connections = 200` is shared by every ORM-pooled app on the
cluster (see the TODO in `stacks/app-db/app-db.nix`). Fine at the
current app count; a transaction-mode PgBouncer between `pg` and the
apps would lift the ceiling without per-app pool tuning.

Trigger to revisit: connection-refused errors in app logs, or the
cluster approaching ~150 concurrent connections
(`pg_stat_activity` count in grafana).

## 4. Logical Postgres backups (pg_dump timers)

The shared app-db cluster is protected only by crash-consistent ZFS
snapshots + syncoid (immich runs its own built-in dumps). Snapshots
faithfully preserve logical corruption — a bad app migration survives
restore, and the daily ring buffer recycles past the last good state
in 7 days.

Plan when picked up: a weekly `pg_dump -Fc` per database (systemd
timer, output under `/home/santiago/selfhost/<stack>/dumps/` so dumps
ride the existing snapshot + syncoid machinery), pruned to N copies,
with an hc-ping.

## 5. Memory caps on heavy containers

Only janitorr, app-db's pg, and the pg exporter set `--memory`. Uncapped heavy hitters:
immich-machine-learning (multi-GB OpenVINO), jellyfin (transcode),
subgen (~1 GB resident whisper model × 2 concurrent jobs),
nextcloud-app (PHP_MEMORY_LIMIT=2G but no container cap), and the
redis/postgres sidecars. A runaway can OOM the box that runs LAN DNS.

Plan when picked up: `--memory` (and maybe `--memory-swap`) per heavy
container, sized from grafana's per-service RSS history; consider a
`memoryLimit` passthrough arg on `mkRootlessContainer`.

## 6. Nextcloud: migrate the redis cache to `memcache.kvstore`

`stacks/nextcloud/nextcloud.nix` sets `REDIS_HOST = "nextcloud-redis"`,
which is the sole trigger for the official image's generated
`redis.config.php`. That file writes `memcache.distributed` and
`memcache.locking` = `\OC\Memcache\Redis` plus a top-level `redis`
block — and Nextcloud 34.0.0 marked both the `redis` and `redis.cluster`
config keys `@deprecated`, superseded by a new predis-backed
`memcache.kvstore` backend that also speaks Valkey, Sentinel and
cluster. A new `MemcacheLegacy` setup check now shows an info notice in
Admin → Overview for exactly our shape. Deferred because the successor
is pure-PHP predis where the current backend is the phpredis C
extension, and the locking cache is on every single request.

Plan when picked up:
- Drop `REDIS_HOST` from `environment` so `redis.config.php` stays inert;
  keep `environmentFiles` — `REDIS_HOST_PASSWORD` becomes input to the
  render below instead of to the image's PHP.
- Add a second `mkSecretRender` beside `nextcloud-redis-conf`, owned by
  `hostUid 33` (www-data), writing a `kvstore.config.php` that sets both
  `memcache.distributed` and `memcache.locking` to
  `\OC\Memcache\KeyValueCache` and points `memcache.kvstore.server` at
  `nextcloud-redis:6379`.
- Bind it in as a **file**, not a directory — mounting a dir at
  `/var/www/html/config` would shadow `config.php`.
- Migrate `memcache.distributed` first and benchmark before moving
  `memcache.locking`; `nextcloud-redis` itself needs no change.

Trigger to revisit: the `MemcacheLegacy` check escalates from info to
warning, or Nextcloud 35 announces removal of the `redis` key.

## 7. Pocket ID: declare the UI-configurable settings in nix

Pocket ID keeps its UI-configurable settings (`sessionDuration`,
`appName`, `allowUserSignups`, `requireUserEmail`, the SMTP block, …) in
the `pocket_id` database, and reads them from the environment **only**
when `UI_CONFIG_DISABLED=true`. We do not set that, so those settings
live purely in mutable DB state, outside the rebuild trail — the same
class of gap as Grafana's UI state. Deferred because flipping the switch
makes every *unset* key snap back to its upstream default and freezes
the admin UI (403 `UiConfigDisabledError`), so it is all-or-nothing.

Plan when picked up:
- Dump the live set first:
  `curl -H "X-API-KEY: $KEY" https://id.toscanini.me/api/application-configuration/all`
- Port every non-default value into the container `environment` (note
  `sessionDuration` is currently 1440, i.e. the intended 24h), moving
  the SMTP password into `stacks/pocket-id/env.sops`.
- Then set `UI_CONFIG_DISABLED = "true"`, and verify login + a password
  reset mail still work before switching.

Trigger to revisit: a Pocket ID DB restore, or the next time one of
these settings needs changing.

## 8. Cleanuparr: native OIDC, stats widget, and the shared pg cluster

Cleanuparr moved a long way between 2.3.3 and 2.10.1 and we adopted none
of it. Three separate items, in dependency order — all of them blocked on
first completing its account setup wizard, which 2.7.0 introduced and
which is still uncompleted (`GET /api/auth/status` → `setupCompleted:false`).

Plan when picked up:
- **Native OIDC** (2.8.0). Declare a `fleet.ssoClients.cleanuparr` entry
  with `consumers = [ "cleanuparr" ]`, but note the callbacks are *not*
  the shape AUTH.md's forward-auth recipe uses:
  `/api/auth/oidc/callback` and
  `/api/account/oidc/link/callback`. Then drop `auth = "oidc"` from
  `fleet.webApps.cleanuparr`, keeping `isolated` and `healthPath`.
  Leave Exclusive Mode **off** — its documented recovery path is
  "directly modify the database", which collides with this box's
  no-CLI-app-state-mutation rule; the forward-auth gate already keeps
  the local password form unreachable. Add the AUTH.md row either way —
  cleanuparr is currently in no tier at all.
- **Read its stats properly** (2.7.0 added `GET /api/v2/stats`). Follow
  the grocy pattern: dial the public hostname with an `X-Api-Key` header,
  the key in `stacks/daedalus/service-keys.sops`, plus an `authBypassRule`
  of ``HeaderRegexp(`X-Api-Key`, `.+`)`` while `auth = "oidc"` remains.
  The dashboard currently counts these out of Loki instead. Note the v1
  `/api/stats` endpoint stops functioning 1 Sep 2026 — we have no consumer
  of it, so this is a gap to fill, not breakage to fix.
- **Shared pg cluster** (2.10.0 added Postgres). `fleet.appDatabases.cleanuparr`,
  `fleet.bridgeMemberships.cleanuparr = [ "app-db" ]` (safe: the
  isolation assertion rejects only a `"traefik"` membership), and
  `DATABASE_PROVIDER=postgres` + `POSTGRES_HOST=pg`. **One platform edit
  is required**: `stacks/app-db/assets/bootstrap.sh` emits
  `POSTGRES_PASSWORD`/`DB_PASS`/`DB_PASSWORD`/`GF_DATABASE_PASSWORD`/
  `DB_POSTGRESDB_PASSWORD` but not `POSTGRES_PASS`, which is the name
  cleanuparr reads — add it to the always-emitted list. Doing this
  *before* the account exists skips the `migrate-to-postgres` step
  entirely, since the SQLite DB is still empty.

Trigger to revisit: whenever the setup wizard is completed — that is the
moment the free Postgres migration window closes.

## 9. Shelfmark + Calibre-Web: native OIDC and per-user identity

Both currently sit behind bare forward-auth, which AUTH.md ranks last
("native OIDC against Pocket ID > trusted-header behind forward-auth >
bare forward-auth"), and neither has a row in AUTH.md at all.

- **shelfmark** has full native OIDC (`AUTH_METHOD=oidc`, callback
  `/api/auth/oidc/callback`, PKCE S256 automatic, admin from an IdP
  group claim), and v1.3.4 is specifically the release that made it
  diagnosable — Test Connection now fetches the JWKS and fails with
  explicit guidance. Adopting it needs a knob first: `auth` is
  hardcoded to `"oidc"` for every gluetun web UI in
  `platform/gluetun-lib.nix`, so add an `auth` field (default `"oidc"`)
  to the `fleet.gluetunTenants` submodule and thread it through.
  Then `DISABLE_LOCAL_AUTH = "true"` + `OIDC_AUTO_REDIRECT = "true"`.
- **calibre-web** v4 already ships reverse-proxy user auto-creation
  ("configurable auto-creation of users", reading `Remote-Email`). Today
  `authHeaders."Remote-User" = "santi"` maps every family member onto one
  full-admin account, so per-user shelves and read state are impossible.
  Switch to `"Remote-User" = "{{ .claims.preferred_username }}"` +
  `"Remote-Email" = "{{ .claims.email }}"` (both are auto-stripped from
  inbound requests by the generated strip middleware) and enable Auto
  Create Users. Needs a per-user permission-default review first: new
  accounts get Calibre-Web's default role, not admin.

Trigger to revisit: a second person actually wanting their own reading
state, or the next AUTH.md audit.

## 10. Immich + Nextcloud: the last two hand-held OIDC clients

Every other client on the box is declarative (`fleet.ssoClients`,
`stacks/pocket-id/clients.nix`) — 28 of 30. These two are not, and the
reason is the same for both: their OIDC client id and secret live in
the *application's own database*, not in env or a config file. Immich
keeps them in its server settings (admin UI / DB); Nextcloud keeps them
in the `user_oidc` app's provider row. Nothing in this repo can set
them without either writing into an app database directly — which the
box's rules forbid — or driving each admin UI.

So they are the last piece of the restore-from-scratch hole: a fresh
`pocket_id` database re-converges 28 clients on the next boot, and
these two need a human in two admin UIs.

Plan when picked up (per app, ~5 minutes each, needs a browser):
- Declare `fleet.ssoClients.{immich,nextcloud}` with the callbacks the
  live clients already carry — immich needs all three
  (`app.immich:///oauth-callback` for mobile, plus `/auth/login` and
  `/user-settings`), nextcloud both the `/apps/user_oidc/code` and
  `/index.php/apps/user_oidc/code` shapes — `allowedGroups =
  [ "admins" "family" ]`, and `pkce = false` for nextcloud. No
  `consumers`: nothing on this side reads the creds.
- Then paste the new id + secret into each app's own settings (read the
  generated secret out of
  `pocket-id/secrets/client-secrets.env`), and delete the old UUID
  client at the IdP.
- Immich's mobile app has to be re-logged-in afterwards; Nextcloud's
  desktop/mobile sync clients keep working (they hold app passwords,
  not OIDC sessions).

Trigger to revisit: a restore-from-scratch drill, an Immich or
Nextcloud OIDC problem that needs the secret touched anyway, or either
upstream growing env-based OIDC configuration.

## 11. Home Assistant: phase-2 follow-ups
The stack (`stacks/home-assistant`) is up, published on LAN + tunnel,
recorder on the shared pg cluster, Pocket ID SSO wired, onboarded, and
instrumented (scrape + dashboard + alert all live).
What is left:

- **Home name / Location / Region are now YAML-only**, by design: any
  `homeassistant:` key makes Home Assistant refuse UI edits for *all*
  of them (Settings → System → General says so explicitly). So that
  whole page is edited in `assets/configuration.yaml` and applied by
  rebuild — including the fields nobody thinks of as config, like the
  instance name. If a field on that page ever needs to be
  user-editable, the only way back is removing the `homeassistant:`
  block entirely, which also gives up `time_zone` / `internal_url` /
  `external_url`.
- **Assist needs its conversation subentry**: the `local_openai` config
  entry exists and is loaded ("LiteLLM (s2)", pointing at
  `https://litellm.toscanini.me/v1` with a scoped LiteLLM key), but a
  config entry alone creates no agent — the conversation entity is a
  *subentry*, and its form is preference territory (system prompt,
  temperature, whether to hand it HA's LLM API for device control), so
  it was left rather than guessed. Settings → Devices & Services →
  LiteLLM (s2) → Add conversation agent, with:
  - model `gemma-4-12b` (the only chat model on the gateway; the rest
    are STT/TTS/embeddings/image)
  - under "Chat template options", a `chat_template_kwargs` entry of
    `enable_thinking=false` — gemma-4-12b is a reasoning model and
    otherwise spends its token budget thinking instead of answering
    (same trap the n8n RSS workflow hit)
  - `CONF_LLM_HASS_API` only once there are devices worth controlling;
    until phase 2 it grants an agent access to an empty house.
  Both custom components are vendored and version-pinned in nix, but
  everything configured through a config flow lands in `.storage` —
  this subentry included. That is the declarativeness ceiling noted
  above, not an oversight.
- **SSO-only**, in two steps of increasing commitment:
  1. Flip `features.default_redirect` to `true` — skips the welcome
     screen, local login still reachable at `/?skip_oidc_redirect=true`.
     Safe, do this once SSO is verified from LAN and tunnel.
  2. `homeassistant.auth_providers: []` — actually removes the local
     login. This *works* (auth_oidc registers by mutating
     `hass.auth._providers`, not via that option, so it survives), but
     upstream advises against it and
     [discussion #67](https://github.com/christiaangoossens/hass-oidc-auth/discussions/67)
     carries an unresolved report that on 2026.4.2 the flows degrade —
     only `/auth/oidc/redirect` worked, `/auth/oidc/welcome` looped.
     Re-test on the pinned HA version before taking it. Lockout escape
     if it goes wrong is a nix rollback or re-adding the provider, not
     a password. Delete `owner-password.sops` once this lands.
- **Household access**: widen `fleet.ssoClients.home-assistant.allowedGroups`
  to `[ "admins" "family" ]` when there is a dashboard worth sharing.
- **HA's own backup**: ZFS snapshots cover `/config` and the pg cluster
  covers history, but HA's built-in automatic backup (a `.storage`
  setting, UI-only) would add a self-contained restore artifact.

Two errors are logged loudly at every start and both are expected:

- `habluetooth` — needs NET_ADMIN/NET_RAW for adapter management, which
  rootless podman cannot grant. Genuinely inert; an ESPHome Bluetooth
  proxy is the supported answer.
- `aiodhcpwatcher: Cannot watch for dhcp packets` — needs a raw packet
  socket, same reason. **This does NOT disable DHCP discovery**, which
  was the original claim here and is wrong. It is one of the `dhcp`
  integration's five watchers; `NetworkWatcher` still runs aiodiscover,
  sweeping the ARP neighbour table for MAC/IP and resolving hostnames by
  PTR against pi-hole (which, being the LAN's DHCP server, answers with
  the lease hostnames as `<host>.lan`). Verified: Settings → Devices →
  DHCP lists gaming-pc / iPhone / smartvacuum, matching
  `/etc/pihole/dhcp.leases` exactly. What the missing sniffer costs is
  immediacy — discovery happens on ARP refresh rather than the instant a
  lease is issued — and devices whose ARP entry has aged out (a fourth
  lease was absent from Home Assistant for exactly that reason).

## 12. Loose ends carried over from working notes

Small, independent items. Each is a known-open thread rather than a
design decision, so none warrants a section of its own.

**Waiting on the operator, not on code**

- **Cleanuparr go-live.** Everything is configured and verifiably
  working, but global `dryRun` is still true, so nothing is ever
  actually deleted — and, more importantly, Blacklist Sync never pushes,
  leaving qBittorrent's "excluded file names" list **empty**. That is
  the layer that stops fake `.exe`/`.scr` releases at *download* time;
  four such fakes once downloaded to completion and jammed the queue for
  want of exactly it. The old REST route is dead (2.10.x added its own
  account system and every config route 403s), so this is now
  **UI-only**: Settings → General → Dry Run off, then trigger
  `BlacklistSynchronizer` once so the list populates immediately.
- **Minecraft's whitelist and ops are empty** by design; adding usernames
  and rebuilding is the whole remaining step. Its healthchecks check
  `minecraft-backup` also still needs its period set to 1 day / 2 hour
  grace in the UI — self-provisioned checks get wrong defaults.
- **The 25 Tuya bulbs are all offline** at Tuya's own cloud, so they are
  unreachable on WiFi rather than misconfigured in Home Assistant (no
  DHCP lease, no UDP 6666/6667, tcp/6668 closed, no BLE ads). The untried
  fix that avoids touching 25 fixtures: recreate the OLD SSID as a
  2.4 GHz guest network on the router and let them rejoin on their own.
  Re-pairing individually risks new device ids and re-adding everything.
  Note the one responder on the smart-plug subnet is the TV, not a bulb
  (its MAC is in pi-hole's network table).
- **Radarr's `Bluray-2160p` cutoff leaves ~31 movies cutoff-unmet**, so
  it will re-download existing 1080p files in 4K as releases surface
  (~800 GB over the metered VPN). The one-line alternative is
  `until_quality: Bluray-1080p` — identical first-grab behaviour, no
  library churn. Undecided; check `/api/v3/wanted/cutoff` before
  assuming the count is still 31.

**Undiagnosed**

- **The LiteLLM gateway has a standing ~15% failure rate** (90 of 591
  requests over one fortnight), concentrated on particular days rather
  than spread evenly. Nothing surfaced it before the daedalus tab was
  rebuilt, because the old panel only ever showed "failed today". The
  per-day failure marks under that tab's traffic chart are where to
  start.

**Small declarative fixes, deliberately not applied yet**

- **`mkSecretRender` should derive `restartTriggers`** from the
  `sopsFile` store path of every secret its script reads, which would
  make a rotated secret actually reach the box on a rebuild instead of
  needing two manual restarts (see CLAUDE.md). The paths are derivable
  rather than hand-listed. Costs one round of container restarts on the
  rebuild that lands it.
- **Pi-hole's `misc.rateLimit`** is at the FTL default of 1000/60s,
  which all ~75 containers share because they all appear as
  `127.0.0.1`. Raising it to ~5000/60 keeps a runaway-client guard
  without the false positives. Needs a `pihole-ftl` restart = brief LAN
  DNS outage, so ask first.
- **Lemonade's `/metrics` is live and unscraped** (root-level, no auth,
  ~206 lines): per-model request/token counters plus TTFT and tokens/sec
  — backend-side truth the gateway cannot see. Caveat: TTFT and tok/s
  are last-value gauges, not histograms, so build rate panels on the
  `_total` counters and don't expect percentiles.

**In another repo**

- **anansi still has no OIDC provider** — password login remains the only
  path in the running image. The full spec is in
  `anansi-oidc-handoff.md`; it goes live on the next image push via the
  normal deploy poll.
