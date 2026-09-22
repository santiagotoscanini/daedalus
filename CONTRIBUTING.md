# Contributing

Daedalus runs on the machine it manages, and the rest of this repository
describes it that way: the container bind-mounts `app/`, the NixOS module
hands it a database and two dozen host snapshots, and saving a file is the
deploy. None of that is needed to work on it.

The app runs on a laptop with Node 24, a throwaway Postgres and one
environment variable. Every command below was run from a fresh clone with
no host present — inside a `node:24` container against a `postgres:17`
container, because the box itself has no node. On a machine with Node 24
they are the same commands.

## Checks, with nothing running

```
cd app
pnpm install --frozen-lockfile --registry https://registry.npmjs.org/
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

`corepack enable` first if you don't have pnpm; `packageManager` pins
11.18.0, and `engineStrict` makes Node 24 a hard requirement rather than a
warning.

**The `--registry` flag is not optional.** `pnpm-workspace.yaml` sends
every install to the author's Verdaccio, which has no public DNS record.
What pins a tarball is the lockfile's integrity hash, not the host that
served it, so npmjs delivers the same bytes — this is exactly what CI does
(`.github/workflows/ci.yml`). Leave the flag off and pnpm does not fail
fast: it retries every lockfile entry against a name that does not resolve,
one minute apart, printing `ENOTFOUND … Will retry in 1 minute` for
minutes. The 7-day `minimumReleaseAge` cooldown is re-verified on every
install, `--frozen-lockfile` included; it costs about three seconds and
needs no configuration.

Install is 264 packages and 189 MB, done in seconds. Lint, typecheck, test
and build take under fifteen seconds together; 857 tests pass and 2 skip —
those two read the host's `/etc/nixos` and skip everywhere else. Nothing in
the four opens a database or a socket. The clone stays clean afterwards:
`routeTree.gen.ts`, `dist/` and `.output/` are all gitignored.

## Running it

```
docker run -d --name daedalus-dev-db -p 127.0.0.1:5432:5432 \
  -e POSTGRES_USER=daedalus -e POSTGRES_PASSWORD=devpass \
  -e POSTGRES_DB=daedalus postgres:17

cd app
export DATABASE_URL=postgres://daedalus:devpass@127.0.0.1:5432/daedalus
pnpm db:migrate    # six tables into an empty database
pnpm dev           # http://localhost:3000
```

(Verified with podman; the flags are identical.)

`DATABASE_URL` is the only variable you must set. `src/host/db.ts` reads it
at module scope, so without it every route — `/api/healthz` included —
answers 500 with `DATABASE_URL is not set`. The dev server does not exit;
it serves 500s until you give it one. Every other row of the schema in
`src/host/env.ts` is optional: unset, the page that wants it says so (the
LiteLLM tab reads "not configured"), and a malformed one is warned about
once and read as unset.

`/` redirects to `/apps`, and `/apps` is the one page that fails out of the
box: its loader throws `NIX_MANIFEST_PATH / NIX_REGISTRY_PATH are not set`
and the section renders a failure panel with a Retry button. Two empty
files satisfy it:

```
echo '{"schemaVersion":1,"nixManaged":{},"operatorSecretApps":[]}' > /tmp/manifest.json
echo '{"schemaVersion":2,"apps":{}}' > /tmp/registry.json
export NIX_MANIFEST_PATH=/tmp/manifest.json NIX_REGISTRY_PATH=/tmp/registry.json
```

After which `/apps` renders its empty state — 0 running, and Add an app.

## What a laptop sees

Every other route answers 200 with no further setup. The category pages
(`/c/home`, `/c/system`, `/c/network`, `/c/ai`, `/c/media`, `/c/gaming`,
`/c/monitoring`), `/apps/new`, `/settings` and `/claude` all render whole:
the rail, the panels, the prose. What is missing is the readings. Those
come from host snapshots at paths like `/system/system.json` and from
Prometheus and Loki, and the snapshot reader treats an absent file as
absent — the panels show `—` and `no data`, never a zero. Settings renders
with its site fields locked, because `site/site.json` has not been written
and there is no committed value for an edit to differ from.

That is the app behaving correctly, not degrading: a panel here is required
to distinguish "no" from "couldn't ask". It also means a local run cannot
tell you whether a host reading is right — only that the page holds
together without one.

## There is no login locally

The deployed app has no auth of its own. Traefik's forward-auth sits in
front of it and passes `X-Forwarded-User` and `X-Forwarded-Email`; the app
trusts them because the bridge it sits on has traefik as its only other
member. Locally nothing sets those headers and nothing blocks you — every
route answers. The one visible difference is the account button at the foot
of the rail, which reads `Account` with no name: `fetchAccount` catches the
lookup failure and returns null, because a shell that cannot say who you
are still has to render. Setting the headers by hand buys nothing without a
Pocket ID to read them against.

## HMR does not connect

`vite.config.ts` pins the HMR socket to `wss://$APP_HOSTNAME:443`, because
on the box the browser reaches Vite through traefik and would otherwise dial
a port nothing listens on. On a laptop nothing listens on that either, so
the browser logs `failed to connect to websocket` and never live-reloads.
The server half is unaffected — a saved file is picked up on the next
request. Reload the page yourself.

## What you cannot do here

Apply, deploys, builds, image updates and the logs panel all go through
file-drop bridges that the NixOS module mounts into the container, and that
module is not in this repository yet (`PLAN.md`, Phase 11). The pages
render and the write paths are not exercisable locally. Changes to them are
best reviewed as code plus a test; `pnpm test` covers the bridge, build and
contract logic without a host.

## Building and running the built server

The box runs `vite dev`; this is the other way to run the same app, and what
a released image will do (`PLAN.md`, Phase 10b).

```
cd app
pnpm build          # scripts/build.mjs: vite build, then scripts/check-build.mjs
DATABASE_URL=postgres://postgres:x@localhost:5432/postgres pnpm start
```

`pnpm build` writes `dist/client` (hashed browser assets plus everything
from `public/`) and `dist/server/server.js`. That second file is a fetch
handler — `export default { fetch }` — and listens on nothing, by design of
TanStack Start; `server.mjs` is the listener. In order, it registers the
unhandled-rejection guard, applies `drizzle/` with drizzle's migrator (the
same ledger `pnpm db:migrate` writes, so a database migrated by hand is
picked up where it stands, and a failed migration exits non-zero before a
port opens), then serves `dist/client` and hands everything else to the
handler. `PORT` (3000) and `HOST` (0.0.0.0) are the only settings of its
own. `/assets/*` is `immutable` for a year; the `public/` files keep their
names between builds and get an hour.

`check-build.mjs` fails the build on three things `vite build` exits 0
over: a Node module stubbed into a browser chunk (`__vite-browser-external`
— the page renders, then throws on a click), a server-function id in a
client chunk that the server manifest does not list, and the box's identity
inlined into either bundle. For the third, `scripts/build.mjs` binds a
canary to `BASE_DOMAIN`, `GITHUB_OWNER`, `REGISTRY_HOST`, `GRAFANA_URL` and
their old `VITE_` spellings before Vite runs, and no canary may appear
anywhere in `dist/`; a bare `vite build && node scripts/check-build.mjs`
says that check was skipped. Ids are path-derived in
dev and `sha256(file--function)` in a build, so the two modes never share
one, and moving a file changes its id in both — a tab opened before a
deploy that moved a file gets a failed call until it reloads.

A build bundles every dependency into `dist/server` except
`@node-rs/argon2` (a native addon). Running it therefore needs only
`srvx`, `drizzle-orm`, `postgres` and `@node-rs/argon2` installed — 12 MB —
not the 189 MB dev install. **That is what `dependencies` in `package.json`
means here**: the packages the server resolves at run time, which
`pnpm install --prod` gives the image. React, the router, radix, zod and the
rest are `devDependencies` because the build consumes them. `check-build`
holds both directions — a run-time import missing from `dependencies` fails
the build, and so does a `dependencies` entry nothing resolves. A new
package goes in with `pnpm add -D` unless `server.mjs` imports it or
`vite.config.ts` externalises it.

The box's identity is not decided at build time: `src/host/site.ts` reads
`BASE_DOMAIN`, `GITHUB_OWNER`, `REGISTRY_HOST` and `GRAFANA_URL` from the
container env per request, and the browser gets the same value in the root
loader's data (`useSite()`). Unset, they read `localhost` /
`unknown-owner` — at run time, on that box, not baked into the image. One
thing is still not right for an image run somewhere without the box's proxy:
forward-auth headers are the only identity, so without a proxy in front
every write refuses. Server functions also require a same-origin request: a `curl`
needs `-H 'Sec-Fetch-Site: same-origin'` or it gets a bare 403.

## The image

One `Dockerfile` at the repository root, one image, and
`docker-entrypoint.sh` decides at start which of two things it is.

```
# from the repository root; npmjs is the default registry, as in CI
podman build -t daedalus .

# through a local npm mirror (Verdaccio or the like) that the build container
# reaches by the host gateway — a cold npmjs install can trip a LAN DNS rate limit
podman build -t daedalus \
  --add-host=registry.example.internal:host-gateway \
  --build-arg NPM_REGISTRY=https://registry.example.internal/ .
```

The `build` stage installs with `--frozen-lockfile`, runs `pnpm build` (the
canaries and `check-build` included), then reinstalls with `--prod` from the
store the first install filled. The final stage is `node:24-slim` plus
`dist/`, `drizzle/`, `server.mjs`, `package.json` (the engine's version is
read from it), that 12 MB `node_modules` and a static `sops` (52 MB, below):
309 MB, 74 MB over the base. About 30 s cold against npmjs, 40 s through
Verdaccio. The registry switch costs nothing in safety — the lockfile holds
integrity hashes and no tarball URLs, and `minimumReleaseAge` and
`allowBuilds` are read from `pnpm-workspace.yaml` whichever registry answers
(the cooldown needs each package's publish time, which npmjs serves and
Verdaccio proxies).

The `sops` stage is the one thing in the image that is not the app: Settings ›
Integrations › Cloudflare › Replace token seals the new token to the
recipients in `/site/.sops.yaml` before it leaves the container, so the
plaintext never lands on the bridge directory. The image holds no age
identity, which makes that binary encrypt-only by construction — it can write
a secret it can never read back. It is the upstream release for linux/amd64,
pinned by version and sha256 in the Dockerfile (`SOPS_VERSION`,
`SOPS_SHA256`; the comment above them says how to bump) and fetched with
`ADD --checksum`, so a mismatch fails the build rather than shipping.

**Production** — the default. Nothing is mounted; identity arrives as env:

```
podman run -d --init --name daedalus --network <net> \
  -e DATABASE_URL=postgres://… \
  -e BASE_DOMAIN=example.test -e GITHUB_OWNER=someone \
  daedalus
```

Migrations apply before the port opens; a missing `DATABASE_URL` or a failed
migration exits 1. It runs as `node` (uid 1000). `--init` because node as
PID 1 reaps nothing — `server.mjs` handles SIGTERM itself, so `podman stop`
takes 0.2 s with or without it.

**Dev** — the same image, `DAEDALUS_DEV=1` and a source tree at `/app`:

```
podman run -d --init --name daedalus-dev --user 0:0 --network <net> \
  -e DAEDALUS_DEV=1 -e DATABASE_URL=postgres://… \
  -v "$PWD/app":/app daedalus
```

The entrypoint runs `pnpm install --frozen-lockfile` and then `pnpm dev`
in the mount. The image carries corepack's shims (113 kB) and no pnpm and no
dev dependency: the pnpm version is the mounted `package.json`'s to name and
is fetched once into `/app/.corepack`; Vite and everything else come from
the mount's own install. Baking pnpm in would cost 37 MB and pin the wrong
thing. `--user 0:0` under rootless podman, where container root IS the host
user and uid 1000 owns nothing in your checkout — the entrypoint says so
instead of letting pnpm fail. With rootful docker, leave it off if your uid
is 1000. `NPM_REGISTRY` overrides the registry `pnpm-workspace.yaml` names;
`PNPM_STORE_DIR` moves the store (default `/app/.pnpm-store`, beside
`node_modules` so pnpm can hardlink). With the flag set and nothing at
`/app`, it warns and serves the bundle. Dev mode runs no migrations —
`pnpm db:migrate`, as before.

`.github/workflows/image.yml` publishes `ghcr.io/<owner>/daedalus:<version>`
and `:sha-<short sha>` when a `v*` tag is pushed, and only then; the tag
must match `app/package.json`'s version. On a pull request that touches the
image files it builds and pushes nothing.

`scripts/image-walk.sh` is the proof to run before a tag: it builds the
image, checks the `sops` it carries, starts it against a throwaway
`postgres:16-alpine` on a private podman network with an identity given as
env, drives a real browser over `/`, `/apps`, `/settings`, `/c/system`,
`/apps/new` and one authenticated write (the forward-auth headers set by the
driver, `scripts/image-walk.mjs`), refuses on any console error, page error,
failed same-origin request or 5xx the browser recorded, and then runs the
same image with `DAEDALUS_DEV=1` over a copy of `app/` until Vite answers.
The browser is `shot`, the author's headless-Chromium CLI (a podman wrapper
around Playwright whose run directory — PNGs, `events.json`, `summary.json`
— is the evidence); `NPM_REGISTRY` and `PODMAN_ARGS` (`--add-host`, `--dns`)
reach the build and the dev install, as the script's header shows.
