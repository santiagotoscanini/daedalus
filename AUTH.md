# AUTH.md — single sign-on reference (Pocket ID + passkeys)

Every browser login on the box goes through one OIDC provider —
[Pocket ID](https://github.com/pocket-id/pocket-id) (passkey-only,
`id.toscanini.me`, published on websecure + cfweb so remote apps can
log in through the tunnel) — plus one Traefik forward-auth middleware
([sevensolutions/traefik-oidc-auth](https://github.com/sevensolutions/traefik-oidc-auth),
chosen for its `HeaderRegexp` bypass rules: API-key traffic can skip
auth by header, not just by path) for apps without native OIDC.

Rule of preference: native OIDC against Pocket ID > trusted-header
behind forward-auth > bare forward-auth. No double logins: services
whose local login can't be disabled and have OIDC coming upstream WAIT
for the official implementation instead — seerr does that today
(FUTURE.md #1; wg-easy graduated to Tier 1 with v15.4.0), and jellyfin
+ factorio-admin are permanently out of scope (below).

This file is the operator reference for the box's auth: the
per-service mechanism map (Tiers 1-3), the group access model, and the
recipe to onboard a new service or household member.

## Tier 1 — native OIDC (app is a Pocket ID client)

| Service | Mechanism | Escape hatch / notes |
|---|---|---|
| immich | native OAuth; password login disabled; mobile uses the `app.immich:///oauth-callback` redirect URI | API keys unaffected |
| nextcloud | official `user_oidc` app, UID-mapped `preferred_username` (existing accounts reused); sync clients via Login Flow v2 | `/login?direct=1` |
| grafana | generic OAuth with `auto_login`; `[auth.basic]` stays enabled (daedalus + the admin API use user/pass from sops) | `/login?disableAutoLogin` |
| gatus | built-in `security.oidc` with `allowed-subjects` (sub UUID allow-list — without it any IdP account gets in) | — |
| wealthfolio | native OIDC (`WF_OIDC_*`, `WF_OIDC_ALLOWED_SUBS`); **confidential** client — `WF_OIDC_CLIENT_SECRET` via `consumers`, PKCE on top; OIDC-only, no password hash set | mint `WF_AUTH_PASSWORD_HASH` per the module header |
| litellm | `GENERIC_*` SSO (free ≤5 users), auto-redirect to Pocket ID | API Bearer keys untouched — never forward-auth `/v1` |
| verdaccio | verdaccio-openid plugin baked into the custom image; web UI + `npm login --auth-type=web` | htpasswd + existing CLI tokens still work; registry API ungated so `npm install` is unaffected |
| n8n | cweagans/n8n-oidc hook (pinned commit, bind-mounted hooks.js); SSO lands as owner | `/signin?showLogin=true`; webhooks untouched |
| anansi | `fleet.apps.anansi.auth.mode = "native"` — Auth.js OIDC provider against Pocket ID, existing account matched by email; the platform supplies OIDC_* + OIDC_CLIENT_SECRET | own `AUTH_SECRET` sessions; DB password hashes are dormant, not a login path |
| wg-easy | native generic OIDC (v15.4.0+, `OAUTH_PROVIDERS=oidc`), openid-client with PKCE + `client_secret_post`; `OAUTH_AUTO_REGISTER` creates the Pocket ID account as admin (upstream has no roles yet — safe only because the client is `admins`-only); `OAUTH_AUTO_LAUNCH` skips the form. **Requires `email_verified: true` in userinfo** (every provider, no override) — tick "Email verified" on the user in Pocket ID or the callback 401s "Email is not verified" | `/login?auto_launch=false` shows the password form — the pre-OIDC local admin; set `DISABLE_PASSWORD_AUTH=true` in the module after the first successful passkey login. The tunnel (:51820) is unaffected by UI auth |
| home-assistant | [hass-oidc-auth](https://github.com/christiaangoossens/hass-oidc-auth) vendored from a pinned tag as a read-only `custom_components` bind mount (not HACS); confidential client, Pocket ID's `admins` group maps to the HA admin role | HA's own login stays enabled — onboarding needs it and it is the break-glass. Long-lived access tokens (companion app, `/api/*`) are untouched |

## Tier 2 — forward-auth + trusted header (auto-login, no second screen)

| Service | Mechanism | Escape hatch / notes |
|---|---|---|
| healthchecks | `REMOTE_USER_HEADER` = the middleware's X-Forwarded-Email | `/ping/*`, `/api/*`, `/badge/*` bypassed — hc-ping jobs authenticate by UUID |
| grocy | header auth via settingoverrides bind-mount, maps to `admin` | `/api` bypass keeps GROCY-API-KEY callers working |
| calibre-web | reverse-proxy header auth (Remote-User), maps to `santi` | `/opds` + `/kobo` bypassed for e-reader Basic auth; widget dials container-direct |

Tier-2 apps trust the identity header blindly, so each runs `isolated`
(private iso-<name>-net bridge, traefik the only peer) and the
middleware strips client-supplied copies of the header on bypassed
paths.

## Tier 3 — forward-auth only (local auth disabled or nonexistent)

| Service | Local auth state |
|---|---|
| traefik dashboard | none — a `service = "api@internal"` webApp; bridge-only :8080, no host port |
| prometheus | none — no host port; grafana + scrapes dial container-direct over the bridges |
| pihole | FTL password blanked (see the module's webserver comment for the accepted trade-off) |
| sonarr / radarr / prowlarr | `AuthenticationMethod=External` in config.xml; `X-Api-Key`/`/api` bypass keeps Seerr, recyclarr and widgets working |
| bazarr | auth None (never Basic — it breaks API-key calls) |
| qbittorrent | localhost bypass (the gluetun port-forward hook needs it) + subnet whitelist — no login |
| nzbget | empty `ControlPassword` — auth disabled; *arrs use blank creds |
| metube | none (WebSocket passthrough works through traefik defaults) |
| myspeed | password unset (its own auth sends the password as a plaintext header — worthless) |
| stirling-pdf | none — its native OIDC is paywalled; forward-auth is the maintainers' endorsed path |
| argus | none — no user model at all; `fleet.apps.argus.auth.mode = "proxy"`, `/favicon.ico` bypassed so gatus and the auto-deploy check reach the app |

## Waiting on upstream

**seerr** keeps its current local login until it ships native OIDC (no
double login in the meantime). Tracked in `FUTURE.md` #1 with the
upstream issue links and the adopt-it recipe.

## Out of scope — stays on native auth

| Service | Why |
|---|---|
| jellyfin | native mobile/TV clients can't do OIDC (plugin covers web only, and the 9p4 plugin was archived May 2026); Seerr authenticates users via Jellyfin passwords. Decision: keep Jellyfin's own auth everywhere — easy logins on TVs/devices matter more than SSO here. Do NOT forward-auth this hostname |
| factorio-admin | OFSM unmaintained (since 2021); its login can't be disabled and it has no OIDC/header support, so the only options were a double login (unwanted) or leaving it out. Decision: leave outside Pocket ID, keep its local user/pass (sops). LAN-only admin UI; game UDP port is unrelated |

## Access control — Pocket ID groups (per-client)

Authorization is enforced in Pocket ID itself, before any app, via per-client
`isGroupRestricted` + allowed groups. Two groups:

- **admins** — santito. Allowed on ALL clients.
- **family** — santito (+ household members as they register). Allowed only on
  the shared apps below.

Every OIDC client (native-OIDC AND forward-auth — each has its own client) is
restricted:

- **family apps** (allow admins + family): immich, nextcloud, calibre-web,
  grocy, stirling-pdf, metube, myspeed
- **admin-only** (allow admins): grafana, prometheus, traefik-dashboard, gatus,
  healthchecks, litellm, n8n, verdaccio, wealthfolio, pihole, anansi, argus,
  home-assistant, and the whole TV stack (qbittorrent, nzbget, prowlarr, radarr,
  sonarr, bazarr)

home-assistant is admin-only only until its phase-2 dashboards exist; widening it
is one line (`allowedGroups` in the stack's `fleet.ssoClients` entry), and
hass-oidc-auth then lands `family` members as ordinary (non-admin) HA users.

A user not in an allowed group gets `access_denied` at the Pocket ID authorize
step (verified with a throwaway family-only user: blocked on gatus, allowed on
myspeed). Adjust membership/allowed-groups in the Pocket ID admin UI or API
(`PUT /api/oidc/clients/<id>/allowed-user-groups` + set `isGroupRestricted`).
Each app also enforces its own per-user data isolation (sofi sees only her own
immich/nextcloud data).

Onboarding a household member: create their Pocket ID account, add to `family`,
tick "Email verified" on the user (wg-easy rejects an unverified email, and
other native-OIDC apps may too), and (for nextcloud) set their `nextcloud_uid`
custom claim = their NC username.

## Cross-cutting (implementation checklist)

- cfweb entrypoint: trust cloudflared's forwarded headers or OIDC
  redirects loop (`X-Forwarded-Proto: http` → wrong callback URI).
  Middleware goes on BOTH routers of every dual-router pair.
- traefik-oidc-auth is fetched at traefik startup — vendor via
  `localPlugins` (pi-hole sinkholes some registries; don't make boot
  network-dependent).
- Pocket ID: keep `EMAIL_ONE_TIME_ACCESS_*` OFF (passkey-only);
  per-client "allowed groups" = coarse authorization before any app.
- Per-service clients: every gated app is its OWN Pocket ID client
  (consent + audit log show the service name; per-client group
  restrictions possible). New clients are DECLARED, not clicked —
  `fleet.ssoClients.<name>` in `stacks/pocket-id/clients.nix`:
  1. Nothing — the secret is machine-generated.
     `sso-client-secrets.service` mints `SSO_SECRET_<NAME>` (64 hex,
     name uppercased, dashes to underscores) on the rebuild that
     declares the client, into
     `/home/santiago/selfhost/pocket-id/secrets/client-secrets.env`.
     The client ID is the attr name itself.
  2. Declare the client. For a `fleet.apps` entry that is one option —
     `auth.mode = "proxy"` (forward-auth) or `"native"` (the app is the
     client); anything else declares `fleet.ssoClients.<name>` directly,
     with `traefikForwardAuth = true` for the middleware shape or
     `consumers = [ "<container>" ]` to hand the app its
     OIDC_CLIENT_SECRET.
  3. Rebuild. `pocket-id-clients.service` creates or updates the client
     at the IdP (`callbackURLs`, `allowedGroups`, secret) and the
     renders under `/run/sso-clients/` hand the same secret to traefik
     or to the app. Logos are still a manual
     `POST /api/oidc/clients/<id>/logo` (multipart `file`, PNG from
     cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/<app>.png).
- Forward-auth clients are not written out at all: a
  `fleet.webApps.<n>.auth = "oidc"` entry IS the declaration, and
  `clients.nix` derives the client from it (hostname → launch +
  `/oidc/callback`, `authGroups` → allowed groups). The consent screen's
  copy is the one thing with no mechanical source, so each stack sets
  `displayName`/`description` on its own `fleet.ssoClients.<n>` entry.
  Nothing else is per-app work — the secret used to be, and is not.
- **Every client on the box is declarative except immich and
  nextcloud**, whose OIDC config lives in their own application
  database rather than in env (FUTURE.md #10).
- Rotating any client secret: delete its line from
  `pocket-id/secrets/client-secrets.env`, rebuild (the generator mints a
  new one and the sync pushes it to the IdP), then `systemctl restart
  podman-traefik` — the middleware holds the old value in memory until
  it is bounced by hand. Native-OIDC consumers restart on their own
  (their rendered env file is a unit dependency).
- Lockout paths: SSH by IP always works; NixOS generation rollback;
  per-app escapes noted per row above.
- Order per service: gate first → verify from LAN + tunnel → only then
  disable the local password. One service at a time.
- Machine-to-machine traffic (widgets, Grafana→prometheus/loki,
  Seerr→*arrs, recyclarr, prometheus scrapes) is container-direct or
  via host.containers.internal — it never traverses traefik, so
  bypass rules are defense-in-depth, not load-bearing. Gatus probes DO
  traverse traefik but assert `[STATUS] < 500`; a 302 to Pocket ID passes.
