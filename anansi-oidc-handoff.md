# anansi: add Pocket ID (OIDC) sign-in

Handoff spec for the change in `github.com/santiagotoscanini/anansi`.
The server side (s2-server) is **already deployed** — the OIDC client
exists at the IdP and the container already has every variable below in
its environment. Nothing else has to happen on the box; the next image
push goes live through the normal 2-minute deploy poll.

Goal: **Pocket ID is the only way into anansi in production**, the
existing account is reused (matched by email), and email/password stays
available in local dev where there is no IdP.

---

## 1. What the container gets

Injected by the platform (`fleet.apps.anansi.auth.mode = "native"`).
Every value below is live right now — verified with
`podman exec app-anansi env`.

| Variable | Value in production | Where it comes from |
|---|---|---|
| `OIDC_ISSUER_URL` | `https://id.toscanini.me` | podman `--env` |
| `OIDC_CLIENT_ID` | `anansi` | podman `--env` |
| `OIDC_CLIENT_SECRET` | 40-char secret | `--env-file` (sops-encrypted, never in the image or the store) |
| `OIDC_REDIRECT_URI` | `https://anansi.toscanini.me/api/auth/callback/pocket-id` | podman `--env` |
| `OIDC_PROVIDER_ID` | `pocket-id` | podman `--env` |
| `OIDC_PROVIDER_NAME` | `Pocket ID` | podman `--env` |
| `OIDC_SCOPES` | `openid profile email groups` | podman `--env` |

Already there, unchanged: `AUTH_SECRET`, `AUTH_URL`
(`https://anansi.toscanini.me`), `AUTH_TRUST_HOST=true`, `DATABASE_URL`,
`APP_NAME`, `APP_HOSTNAME`, `APP_PUBLIC_URL`, `PORT=3000`.

Two contracts that are registered **at the identity provider** and
cannot be changed app-side without a matching change on the server:

- The redirect URI is registered exactly as
  `https://anansi.toscanini.me/api/auth/callback/pocket-id`. It is
  derived from `OIDC_PROVIDER_ID`, so the Auth.js provider's `id` **must
  be `pocket-id`** — Auth.js builds its callback path as
  `/api/auth/callback/<provider id>`. Read the path from
  `OIDC_REDIRECT_URI` rather than rebuilding it, and the two can't drift.
- The client is **group-restricted to `admins`** at the IdP. A Pocket ID
  account outside that group is refused at the authorize step and never
  reaches anansi.

In local dev none of the `OIDC_*` vars are set. That absence is the
signal to fall back to password login (below) — do not hardcode a
`NODE_ENV` check.

## 2. The IdP, concretely

Pocket ID 2.12, passkey-only, standard OIDC with discovery at
`https://id.toscanini.me/.well-known/openid-configuration`.

- PKCE (`S256`) is enabled on this client — send it.
- Claims available: `sub`, `name`, `given_name`, `family_name`,
  `display_name`, `email`, `email_verified`, `preferred_username`,
  `picture`, `groups`, `auth_time`, `amr`.
- `end_session_endpoint`: `https://id.toscanini.me/api/oidc/end-session`
  (only needed if you want RP-initiated logout — optional, see §7).
- Discovery is fetched lazily, on the first authentication request, so
  the container does not need the IdP to be up at boot. Keep it that way
  — an app that fetches discovery *during startup* needs to be
  registered on the server side (`fleet.sso.discoveryConsumers`) or it
  crash-loops on a cold boot.

## 3. No database migration

`users` and `accounts` already have exactly what the OAuth path needs:
`users.email` is unique, `users.name` is `notNull`, and `accounts`
mirrors `AdapterAccount` (it was created for this and has been empty
since). `passwordHash` becomes dormant in production rather than being
dropped — leave the column and the `changePassword` service alone for
now.

## 4. `src/lib/env.ts`

Add the seven vars as **optional** server vars (`z.string().optional()`,
`OIDC_ISSUER_URL` as `.url()`), and export the derived flag the rest of
the code branches on:

```ts
export const oidcEnabled = Boolean(
  env.OIDC_ISSUER_URL && env.OIDC_CLIENT_ID && env.OIDC_CLIENT_SECRET && env.OIDC_REDIRECT_URI,
)
```

`emptyStringAsUndefined: true` is already set, so a blank var reads as
absent — which is the behaviour this flag wants.

## 5. `src/server/auth/config.ts`

Add the provider; **do not touch** `basePath`, `secret`, `trustHost`,
`session.strategy`, the `jwt`/`session` callbacks, or anything the big
cookie-compatibility comment warns about. Adding a provider does not
change the cookie name, so existing sessions survive the deploy.

```ts
const pocketId = {
  id: env.OIDC_PROVIDER_ID ?? 'pocket-id',   // half of the registered redirect URI
  name: env.OIDC_PROVIDER_NAME ?? 'Pocket ID',
  type: 'oidc',
  issuer: env.OIDC_ISSUER_URL,
  clientId: env.OIDC_CLIENT_ID,
  clientSecret: env.OIDC_CLIENT_SECRET,
  authorization: { params: { scope: env.OIDC_SCOPES ?? 'openid profile email groups' } },
  checks: ['pkce', 'state'],
  // The adapter writes `name` (notNull) and `image`. avatarUrl is the
  // app's canonical avatar and must NOT be overwritten by the IdP's
  // picture — the UI reads avatarUrl, and a user who uploaded one keeps it.
  profile: (p) => ({
    id: p.sub,
    name: p.name ?? p.preferred_username ?? p.email,
    email: p.email,
    image: p.picture ?? null,
  }),
  // Pocket ID is the ONLY provider and it verifies the address, so
  // linking an OIDC identity onto the pre-existing row with the same
  // email is safe here. This is what makes the existing account (and
  // all its goals) carry over instead of a second empty user appearing.
  // It would NOT be safe with a second, unverified provider in the list.
  allowDangerousEmailAccountLinking: true,
} satisfies OIDCConfig<PocketIdProfile>
```

Provider list — password login only where there is no IdP:

```ts
providers: oidcEnabled ? [pocketId] : [credentialsProvider],
```

That single line is what makes production OIDC-only (no second
credential path on a publicly-exposed surface) while `pnpm dev`, the
Playwright flows and `scripts/capture-screens.sh` keep working
unchanged against `santi@test.local`.

Optional hardening (the IdP already enforces this, so it is
defense-in-depth): a `signIn` callback returning `false` when
`profile.groups` doesn't include `admins`.

## 6. Starting the flow

The credentials flow runs in-process because it has no external
redirect. OIDC does, so sign-in has to end with the **browser** at the
IdP's authorize URL. Keep the shape of `src/server/auth/actions.ts` —
run Auth.js in-process with `raw` + `skipCSRFCheck`, replay its cookies
(the PKCE verifier / state / nonce cookies MUST land on the response, or
the callback fails with a state mismatch), and return the redirect URL
for the client to navigate to:

```ts
export async function startOidcSignIn(callbackUrl: string): Promise<string> {
  const request = getRequest()
  const headers = authRequestHeaders(request)
  const protocol = new URL(request.url).protocol
  const url = createActionURL('signin', protocol, headers, process.env, authConfig)
  url.pathname += `/${env.OIDC_PROVIDER_ID ?? 'pocket-id'}`

  const response = await Auth(
    new Request(url, { method: 'POST', headers, body: new URLSearchParams({ callbackUrl }) }),
    { ...authConfig, raw, skipCSRFCheck },
  )
  applyCookies(response)          // state + PKCE cookies — load-bearing
  return response.redirect        // -> https://id.toscanini.me/authorize?...
}
```

Wrap it in a server fn next to `signIn`/`signUp` in
`src/server/fn/auth.fn.ts` and have the client do
`window.location.href = url` (a full navigation, not a router push —
the target is another origin).

The callback needs no new route: `src/routes/api.auth.$.ts` already
handles `/api/auth/callback/*`, and its `withForwardedOrigin` rewrite is
exactly what makes this work behind Traefik's TLS termination (the
request reaches Nitro over plain http; without the rewrite the
`__Secure-` cookie name and the callback origin would both be wrong).

## 7. Routes and UI

- `/login`: when `oidcEnabled`, redirect to the IdP instead of rendering
  the form. Do it in `beforeLoad`, after the existing already-signed-in
  check, and preserve `?next=`.
  **Guard against the loop**: if the URL carries `?error=` (Auth.js
  sends failures back to `pages.signIn`), render a message with a
  "try again" link rather than bouncing straight back to the IdP. An
  `access_denied` — the shape a non-`admins` account gets — would
  otherwise spin forever.
  When `oidcEnabled` is false, keep today's form exactly as-is.
- `/register`: with OIDC on, self-registration is the IdP's job and an
  open register page on a publicly-exposed app is a liability. Gate the
  route on `!oidcEnabled` (redirect to `/login` otherwise) and drop the
  "create an account" switch from `LoginScreen` in the same condition.
  `signUp` / `registerUser` stay in the code for dev and seeding.
- Sign-out: unchanged. `signOutSession()` clears the local cookie; the
  Pocket ID session is separate and intentionally left alone (24h, and
  it is what makes SSO across the other apps silent). If you want a full
  logout, redirect to `end_session_endpoint` afterwards — optional, and
  worth a deliberate decision rather than a default.
- The `/oauth/*` MCP surface is unaffected: it authorizes against
  whatever session exists, and the session cookie is byte-identical
  either way.

## 8. Docs

`CLAUDE.md` in the repo says auth is "Credentials provider — email +
password only". Update that section to describe both paths (OIDC in
deployed environments, password in local dev), and keep the
`santi@test.local` recipe — it stays true for `pnpm dev`.

## 9. How to verify

Local (no `OIDC_*` set): `pnpm dev` → `/login` renders the form,
`santi@test.local` signs in, `/register` works. Nothing changed.

Against the IdP, one of:

- point a local run at production values (`.env` with the seven vars,
  plus a temporary extra `callbackURL` on the client — ask, that is a
  one-line server-side change), or
- push to main and watch the real deploy:
  `journalctl -fu app-anansi-deploy.service` on s2-server. The deploy
  health-checks `/api/healthz` through Traefik, so a broken boot fails
  the unit loudly instead of quietly serving 500s.

What to check after deploying:

1. `https://anansi.toscanini.me/login` bounces to
   `https://id.toscanini.me/authorize?client_id=anansi&...`.
2. Passkey → lands back on `/app`, signed in **as the existing user**
   (the goals are there, not an empty account).
3. `select provider, provider_account_id from accounts;` has exactly one
   row, pointing at the existing `users.id` — that is the account-link
   working. A *second* users row with the same email means
   `allowDangerousEmailAccountLinking` didn't take.
4. `https://anansi.toscanini.me/api/healthz` still returns 200
   unauthenticated (gatus and the deploy check both depend on it).
