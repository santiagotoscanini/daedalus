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

Status: IN PROGRESS. Done 2026-07-17: Pocket ID live (stacks/pocket-id, id.toscanini.me, LAN+tunnel); oidc-auth@file middleware (vendored traefik-oidc-auth v0.20.1, localPlugins); `myStack.webApps.<name>.auth = "oidc"` knob gates websecure+cfweb routers; gated so far: homepage, prometheus, metube, myspeed, stirling-pdf, pihole (password still set — blank after passkey verify), traefik dashboard (widget moved to internal :8080 api.insecure). Remaining: *arrs batch (External + api bypass), Tier 1 native-OIDC apps, Tier 2 header-auth apps. Audit date 2026-07-17.

## Tier 1 — native OIDC (app is a Pocket ID client)

| Service | Current auth | Plan | Notes |
|---|---|---|---|
| immich | local email/password | native OAuth settings | add `app.immich:///oauth-callback` redirect URI (mobile); disable password login after verifying; API keys / homepage widget unaffected |
| nextcloud | local users | official `user_oidc` app | `--unique-uid=0` + UID-mapping `preferred_username` so existing accounts are reused; sync clients fine via Login Flow v2; `/login?direct=1` = recovery |
| grafana | admin user/pass (sops) | generic OAuth ([Pocket ID example](https://pocket-id.org/docs/client-examples/grafana)) | `auto_login`; keep `[auth.basic]` enabled — homepage widget uses user/pass API; `/login?disableAutoLogin` = recovery |
| gatus | none | built-in `security.oidc` | MUST set `allowed-subjects` (our sub UUID) or any IdP account gets in |
| wealthfolio | argon2 password (`WF_AUTH_PASSWORD_HASH`) | native OIDC (`WF_OIDC_*`) | docs name PocketID; set `WF_OIDC_ALLOWED_SUBS` |
| litellm | UI user/pass + master key | `GENERIC_CLIENT_ID`/`GENERIC_*` SSO | free ≤5 users since v1.76.0; API Bearer keys untouched — never forward-auth `/v1` |
| verdaccio | htpasswd | [verdaccio-openid](https://github.com/kuoruan/verdaccio-openid) plugin | forward-auth would break npm CLI; plugin issues real registry tokens via `npm login --auth-type=web` |
| n8n | owner email/password | [cweagans/n8n-oidc](https://github.com/cweagans/n8n-oidc) external hook ([announcement](https://www.cweagans.net/2025/12/announcing-n8n-oidc/)) | community project (Dec 2025) — n8n's own OIDC is enterprise-only; keep webhooks (`/webhook*`, `/rest/oauth2-credential/callback`) out of any middleware |
| anansi / ipcrawl | own `AUTH_SECRET` sessions | wire app auth to Pocket ID (generic OIDC provider) | self-built — change in the app repos, not here |

## Tier 2 — forward-auth + trusted header (auto-login, no second screen)

| Service | Current auth | Plan | Notes |
|---|---|---|---|
| healthchecks | Django email/password | `REMOTE_USER_HEADER` ([Pocket ID example](https://pocket-id.org/docs/client-examples/healthchecks)) | bypass `/ping/*`, `/api/*`, `/badge/*` — hc-ping jobs authenticate by UUID |
| grocy | internal user/pass | `AUTH_CLASS=ReverseProxyAuthMiddleware` + `REVERSE_PROXY_AUTH_HEADER` | linuxserver image: set via settingoverride file (PHP-FPM scrubs env unless `clear_env=no`); narrow `DEFAULT_PERMISSIONS` — unknown header names auto-create as ADMIN; `GROCY-API-KEY` still works (widget OK) |
| calibre-web | local users | "Allow Reverse Proxy Authentication" + header name | user must pre-exist; separate un-authed router for `PathPrefix(/opds)` — e-readers speak Basic auth (calibre-web's own Basic guards it) |

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
| factorio-admin | local user/pass (sops), OFSM unmaintained | OPEN: login can't be disabled → forward-auth means the box's ONLY double login. Alternative: leave outside Pocket ID like jellyfin. Decide at implementation |

## Waiting on upstream (keep current auth until release — no double login)

| Service | Current auth | Waiting for |
|---|---|---|
| seerr | Jellyfin-credential login | native OIDC — merged in [PR #2715](https://github.com/seerr-team/seerr/pull/2715), milestoned v3.5.0; testing thread [discussion #2721](https://github.com/seerr-team/seerr/discussions/2721). Adopt on stable release |
| wg-easy | v15 local account (+TOTP) | native OIDC — [issue #1923](https://github.com/wg-easy/wg-easy/issues/1923) (also tracked as #2374). Adopt when shipped |

## Out of scope — stays on native auth

| Service | Why |
|---|---|
| jellyfin | native mobile/TV clients can't do OIDC (plugin covers web only, and the 9p4 plugin was archived May 2026); Seerr authenticates users via Jellyfin passwords. Decision: keep Jellyfin's own auth everywhere — easy logins on TVs/devices matter more than SSO here. Do NOT forward-auth this hostname |

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
