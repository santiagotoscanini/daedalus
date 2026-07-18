# AUTH.md — single sign-on plan (Pocket ID + passkeys)

Target: every browser login on the box goes through one OIDC provider
— [Pocket ID](https://github.com/pocket-id/pocket-id) (passkey-only,
`id.toscanini.me`, published on websecure + cfweb so remote apps can
log in through the tunnel) — plus one Traefik forward-auth middleware
([sevensolutions/traefik-oidc-auth](https://github.com/sevensolutions/traefik-oidc-auth),
chosen for its `HeaderRegexp` bypass rules: API-key traffic can skip
auth by header, not just by path) for apps without native OIDC.

Rule of preference: native OIDC against Pocket ID > trusted-header
behind forward-auth > bare forward-auth. No double logins: services
whose local login can't be disabled and have OIDC coming upstream WAIT
for the official implementation instead.

Status: COMPLETE (2026-07-18). Every web UI authenticates through Pocket ID (passkeys, 24h session) except the two apps tracked in FUTURE.md (seerr, wg-easy — waiting on upstream OIDC) and the two permanent out-of-scope ones below (jellyfin, factorio-admin). This file is now the operator reference for the box's auth: the per-service mechanism map (Tiers 1-3), the group access model, and the recipe to onboard a new service or household member.

## Tier 1 — native OIDC (app is a Pocket ID client)

| Service | Current auth | Plan | Notes |
|---|---|---|---|
| immich | local email/password | native OAuth settings | add `app.immich:///oauth-callback` redirect URI (mobile); disable password login after verifying; API keys / homepage widget unaffected |
| nextcloud | local users | official `user_oidc` app | `--unique-uid=0` + UID-mapping `preferred_username` so existing accounts are reused; sync clients fine via Login Flow v2; `/login?direct=1` = recovery |
| grafana | admin user/pass (sops) | generic OAuth ([Pocket ID example](https://pocket-id.org/docs/client-examples/grafana)) | `auto_login`; keep `[auth.basic]` enabled — homepage widget uses user/pass API; `/login?disableAutoLogin` = recovery |
| gatus | none | built-in `security.oidc` | MUST set `allowed-subjects` (our sub UUID) or any IdP account gets in |
| wealthfolio | argon2 password (`WF_AUTH_PASSWORD_HASH`) | native OIDC (`WF_OIDC_*`) | docs name PocketID; set `WF_OIDC_ALLOWED_SUBS` |
| litellm | UI user/pass + master key | `GENERIC_CLIENT_ID`/`GENERIC_*` SSO | free ≤5 users since v1.76.0; API Bearer keys untouched — never forward-auth `/v1` |
| verdaccio | DONE (2026-07-17) | verdaccio-openid plugin baked into a custom image (verdaccio:6.7.4 + plugin via image-build oneshot); Pocket ID SSO for web UI + npm login --auth-type=web; htpasswd + existing CLI tokens still work; registry API ungated so npm install unaffected |
| n8n | DONE (2026-07-17) | cweagans/n8n-oidc hook (pinned commit, bind-mounted hooks.js); owner email aligned to santiago@toscanini.me so SSO lands as owner; password fallback via /signin?showLogin=true; webhooks untouched |
| anansi / ipcrawl | own `AUTH_SECRET` sessions | wire app auth to Pocket ID (generic OIDC provider) | self-built — change in the app repos, not here |

## Tier 2 — forward-auth + trusted header (auto-login, no second screen)

| Service | Current auth | Plan | Notes |
|---|---|---|---|
| healthchecks | Django email/password | `REMOTE_USER_HEADER` ([Pocket ID example](https://pocket-id.org/docs/client-examples/healthchecks)) | bypass `/ping/*`, `/api/*`, `/badge/*` — hc-ping jobs authenticate by UUID |
| grocy | DONE (2026-07-17) | header auth via settingoverrides bind-mount, maps to existing `admin` (sofi deleted); `/api` bypass keeps GROCY-API-KEY |
| calibre-web | DONE (2026-07-17) | Pocket ID gate + reverse-proxy header (UI: Allow Reverse Proxy Auth, header Remote-User); maps to existing `santi`; /opds + /kobo bypassed for e-reader Basic auth; widget dials container-direct |

## Tier 3 — forward-auth only (local auth disabled or nonexistent)

| Service | Current auth | Change behind the gate |
|---|---|---|
| homepage | none | — (auth-blind by design) |
| traefik dashboard | none (`:9080` insecure API) | move to `api@internal` router; closes the unauthenticated host port |
| prometheus | none | Grafana dials container-direct, unaffected. DECISION: host port 9090 stays open for external scrapers = LAN auth bypass — close or accept |
| pihole | password, app password for widget | blank admin password once gated; widget dials `host.containers.internal:8080` direct |
| sonarr / radarr / prowlarr | forms login | `AuthenticationMethod=External` in config.xml (Servarr wiki FAQ); bypass rule for `X-Api-Key`/`/api` — Seerr, recyclarr, widgets keep working |
| bazarr | forms | set auth None (never Basic — breaks API-key calls) |
| qbittorrent | user/pass | already bypasses localhost (gluetun PF hook needs it); add whitelist for the pasta gateway subnet → login gone |
| nzbget | ControlUsername/Password (sops) | empty `ControlPassword` disables auth; *arrs use blank creds |
| metube | none | — (needs WebSocket passthrough; traefik default OK) |
| myspeed | none | leave its password unset (its auth sends plaintext password as a header — worthless) |
| stirling-pdf | none | native OIDC is paywalled ($99/mo tier) — forward-auth is the maintainers' endorsed path |

## Waiting on upstream

**seerr** and **wg-easy** keep their current local login until each ships
native OIDC (no double login in the meantime). Tracked in `FUTURE.md` #1
with the upstream issue links and the adopt-it recipe.

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
  grocy, stirling-pdf, homepage, metube, myspeed
- **admin-only** (allow admins): grafana, prometheus, traefik-dashboard, gatus,
  healthchecks, litellm, n8n, verdaccio, wealthfolio, pihole, and the whole TV
  stack (qbittorrent, nzbget, prowlarr, radarr, sonarr, bazarr)

A user not in an allowed group gets `access_denied` at the Pocket ID authorize
step (verified with a throwaway family-only user: blocked on gatus, allowed on
myspeed). Adjust membership/allowed-groups in the Pocket ID admin UI or API
(`PUT /api/oidc/clients/<id>/allowed-user-groups` + set `isGroupRestricted`).
Each app also enforces its own per-user data isolation (sofi sees only her own
immich/nextcloud data).

Onboarding a household member: create their Pocket ID account, add to `family`,
and (for nextcloud) set their `nextcloud_uid` custom claim = their NC username.

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
  restrictions possible). Rollout recipe per service:
  1. `POST /api/oidc/clients` (header `X-API-KEY` = STATIC_API_KEY from
     `stacks/pocket-id/env.sops`) with `name` = display name,
     `description`, `launchURL` = `https://<hostname>` (My Apps page),
     `callbackURLs` = `logoutCallbackURLs` =
     `https://<hostname>/oidc/callback`, `pkceEnabled: true`,
     `skipConsent: true` (own infra); then
     `POST /api/oidc/clients/<id>/secret` and
     `POST /api/oidc/clients/<id>/logo` (multipart `file`, PNG from
     cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/<app>.png —
     same art the homepage tiles use).
  2. Append `POCKET_OIDC_<NAME>_CLIENT_{ID,SECRET}` (name uppercased,
     dashes to underscores) to `stacks/traefik/env.sops`.
  3. Set `auth = "oidc"` on the webApp entry; rebuild. env.sops-only
     changes do NOT restart traefik (same path) — `systemctl restart
     podman-traefik` by hand.
- Lockout paths: SSH by IP always works; NixOS generation rollback;
  per-app escapes noted per row above.
- Order per service: gate first → verify from LAN + tunnel → only then
  disable the local password. One service at a time.
- Machine-to-machine traffic (widgets, Grafana→prometheus/loki,
  Seerr→*arrs, recyclarr, prometheus scrapes) is container-direct or
  via host.containers.internal — it never traverses traefik, so
  bypass rules are defense-in-depth, not load-bearing. Gatus probes DO
  traverse traefik but assert `[STATUS] < 500`; a 302 to Pocket ID passes.
