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
- **Homepage tile** (2.7.0 added `GET /api/v2/stats`, built for
  Homepage's `customapi`). Follow the grocy pattern: a `customapi`
  widget against the public hostname with an `X-Api-Key` header, the key
  in `stacks/homepage/env.sops`, plus an `authBypassRule` of
  ``HeaderRegexp(`X-Api-Key`, `.+`)`` while `auth = "oidc"` remains.
  Note the v1 `/api/stats` endpoint stops functioning 1 Sep 2026 — we
  have no consumer of it, so this is a gap to fill, not breakage to fix.
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

## 10. Migrate the hand-created OIDC clients onto `fleet.ssoClients`

The declarative client mechanism exists (`stacks/pocket-id/clients.nix`
+ `pocket-id-clients.service`), but only **2 of the 30 clients** at the
IdP use it — anansi and ipcrawl, via `fleet.apps.<name>.auth.mode`.
Everything else still carries server-generated credentials that were
created by hand: 18 forward-auth pairs as
`POCKET_OIDC_<NAME>_CLIENT_{ID,SECRET}` in `stacks/traefik/env.sops`,
plus the native-OIDC stacks (grafana, immich, nextcloud, gatus, litellm,
n8n, verdaccio, wealthfolio, open-webui, zot) holding theirs in their
own `env.sops`.

So the restore-from-scratch hole is 28/30 open: a fresh `pocket_id`
database still means recreating almost every client through the REST
recipe in AUTH.md before SSO works at all.

Plan when picked up, one app at a time (each migration IS a secret
rotation — the client id changes from a server UUID to the attr name,
so the app is logged out mid-flight):
- Add `SSO_SECRET_<NAME>` to `stacks/pocket-id/clients.sops`.
- Declare `fleet.ssoClients.<name>` with the app's real callback URLs
  and `allowedGroups` (mirror what the live client has — read it back
  with `GET /api/oidc/clients/<uuid>` first, `isGroupRestricted` and the
  group list included). Set `traefikForwardAuth = true` for a
  forward-auth app, or `consumers = [ "<container>" ]` for a native one.
- Drop the old pair from the stack's `env.sops`, point the app at the
  new id, rebuild, verify a real login, then delete the old client at
  the IdP (`DELETE /api/oidc/clients/<uuid>`) so the two don't drift.
- Logos are still manual (`POST /api/oidc/clients/<id>/logo`) — the new
  client starts without one.

Trigger to revisit: any restore-from-scratch drill, a client secret
rotation that has to happen anyway, or the next AUTH.md audit.
