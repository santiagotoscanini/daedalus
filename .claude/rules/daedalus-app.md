---
paths:
  - "app/**"
---

# daedalus — developing the control-plane app

TanStack Start + React 19 + Vite 8, drizzle-orm on the shared pg
cluster, pnpm 11, node ≥ 24, TS 6. This is the box's admin UI; it runs
as a `source.mode = "local"` app — the NixOS module that runs it lives
in the s2-server repo (`stacks/daedalus/daedalus.nix`) and bind-mounts
THIS repo's `app/` at /app, running the Vite dev server against it.

## The dev loop (what restarts what)

- `app/**` (routes, components, lib) → **nothing**. Vite is watching;
  saving the file IS the deploy. Verify with `shot quick
  https://daedalus-app.toscanini.me/<page>` — but the SSO gate stops an
  unauthenticated browser at Pocket ID, so for content checks go UNDER
  the gate instead (auth is traefik's job; the dev server trusts its
  caller): `podman exec app-daedalus node -e
  "fetch('http://localhost:3000/<page>').then(r=>r.text()).then(t=>console.log(t.includes('<needle>')))"`
  renders the real SSR page, loaders included. Vite compile errors land
  in `podman logs app-daedalus`. For PIXELS under the gate (visual
  work), run the shotter image on the app's own bridge — vite allows
  the `app-daedalus` host for exactly this:
  `podman run --rm --network=iso-daedalus-net --shm-size=1g -v
  ~santiago/selfhost/shotter:/lab localhost/shotter:pw<ver>-<hash>
  node /opt/lab/runner.mjs --out /lab/runs/<id> --url
  http://app-daedalus:3000/<page> --label <label>` (use the PINNED
  tag from `podman images`, NOT `:latest` — that's a stale pre-stack
  leftover). Expect 2 baseline pageerrors in events.json on every run
  this way: the HMR websocket 302s at the gate, and a pre-existing
  Date.now() hydration mismatch — compare counts against those, not
  against zero.
- `app/package.json` → `sudo systemctl restart podman-app-daedalus`
  (re-runs `pnpm install --frozen-lockfile`; Verdaccio is a hard
  startup dependency, minutes on a cold cache).
- `stacks/daedalus/assets/**` in the s2-server repo (the runtime image
  context) → `nixos-rebuild` there (context hash → new image tag →
  restart).
- `stacks/daedalus/daedalus.nix` in the s2-server repo → `nixos-rebuild`
  there.

**Before calling any change done: `pnpm typecheck`** (runs
`tsr generate && tsc --noEmit`) from `app/`.
`src/routeTree.gen.ts` is generated + gitignored — never edit it; if
routes changed, `pnpm generate-routes` (or typecheck, which runs it).

This clone lives under `~/projects`, which is snapshotted and mirrored;
the remote is still the copy that survives a disk. Commit often.

## Architecture map

- `src/routes/` — TanStack file-based routes: `__root.tsx`,
  `index.tsx` (redirects to `/apps`), `c.$category.tsx` (the category
  dashboard shell), `apps.index.tsx` / `apps.$name.tsx` (loader + frame
  only; its tab bodies live in `src/components/apps/*`) /
  `apps.new.tsx`, `apps_.$name.builds.$id.tsx` (one build: its log,
  facts and cancel), `settings.tsx`, `claude.tsx`, and
  `settings_.github.callback.ts`, where GitHub returns the App
  manifest's `?code&state`. The `api.*.ts` server routes are healthz,
  the registry's apply/export/import, image-update, the deploy hook
  (zot's push event), the GitHub push webhook, app-icon,
  profile-picture, and the two image servers — `shot-run` for a
  shotter run's frames and `deploy-shot` for an app's post-deploy
  screenshot.
- **The dashboard modules — `src/modules/<id>/`**: one directory per
  category page (ai, gaming, home, media, monitoring, network, system),
  found by `import.meta.glob`, never listed. Each holds `manifest.ts`
  (pure data: label, lede, rail `order`, the tabs with their probes,
  spans and the `nix` module ids each tab fronts), `releases.ts` (the
  release sources of the containers it fronts, merged into
  `lib/dashboard/image-repos.ts`), `data/` (server-only: `index.ts`
  exports `load = defineLoader(manifest, { <tab>: (ctx) => … })` and
  a `Tabs` map; one file per tab; `shared.ts` for cross-tab helpers)
  and `view/` (client: `index.tsx` exports `views = defineViews(manifest,
  { <tab>: Component })`; one file per tab). The two records are keyed
  by the manifest's tab ids, so a tab without its loader or view is a
  compile error. The contract is `lib/modules/{manifest,tabs}.ts`; the
  registries are `lib/modules/registry.ts` (manifests, client-safe),
  `host/modules.ts` (loaders, lazy) and `components/modules/boards.tsx`
  (views, eager). A new module = a new directory; nothing else changes.
- **Loaders reach the machine only through `Ctx`** (`core/ctx.ts`:
  env, secret, gateway, snapshot, store, http, loki, hosts, modules).
  `ctx.env` and `ctx.secret` take only names `host/env.ts` declares;
  `ctx.gateway` is LiteLLM, or null on a box without one. No
  `process.env` under `src/modules/` — the boundary test refuses it.
  `ctx.modules.enabled(id)` reads `/export/modules.json`
  (`fleet.modules.<id>.enable`, once the box publishes it; every module
  counts as enabled until then) and `lib/modules/active.ts` derives
  the rail from it: a tab is offered while any of its `nix` modules is
  enabled, a module while it has a tab left.
- `core/identity/pocket-id.ts` is the Pocket ID reader two modules share
  (clients, accounts, groups, settings, the audit log): Home's Sign-in tab
  (`modules/home/data/signin.ts` is its loader) and Network's Proxy tab both
  read it, because a module must not import another module's data. Its
  functions take the `Ctx` — host, key and http come from it. The last of
  `lib/dashboard/categories/` went with it.
- **`src/lib/` versus `src/host/` — the split the path names**:
  a module goes in `src/host/` if it needs the machine (a `node:`
  builtin, the database, or `process.env`) or statically imports
  something that does; `src/lib/`'s top level is pure and a component
  may import values from it. `lib/repo/**` (drizzle), `lib/dashboard/**`
  (the cross-module readers: images, github, host facts) and
  `lib/apps/**` are server-only too and stay in `lib/` because their
  own names already say so; `src/modules/*/data/**` is a server region
  by the same rule, and `src/modules/*/view/**` is client code. **New rule for
  a new file: if it reaches for the host, it goes under `src/host/`** —
  `src/host/boundary.test.ts` walks the real import graph and fails
  otherwise, naming the file and the edge.
- **The shared fetch layer**: `lib/http.ts` (retry ladder, request
  coalescer, pool) and `lib/cache.ts` (swrCache / swrValue, the
  two-clock stale-serving contract) are pure and stayed in `lib/`;
  `host/prom.ts` (PromQL + promEscape) and `host/loki.ts` (LogQL,
  one-patient-attempt budget) read their base URL from the env and did
  not. `lib/format.ts` (isomorphic formatters) is importable from a
  component precisely because `host/keys.ts` — the DASH_* secrets
  accessor, the one `process.env` read it used to carry — was split out
  of it.
- `src/core/` — the productization core (plan, Phases 2+). `ctx.ts` is
  the capability set a reader is handed instead of `process.env`
  (env, secrets, snapshots, the preferences store, http, loki) —
  server-only, imported dynamically like `lib/repo/*`; every module
  loader receives one from Phase 10 on. `core/settings/` is the
  read-only reader behind `/settings` (`index.ts` assembles env +
  /export + snapshots into `BoxSettings`; `integrations.ts` is the
  deferred, 5-min-cached live token checks; `external-apps.ts` reads
  the off-box list from the store with `lib/external-apps.ts` as seed;
  `profile.ts` is the Profile tab — the signed-in person's Pocket ID
  account, resolved from the forward-auth headers and written through
  Pocket ID's admin API (every write re-sends isAdmin/disabled/
  emailVerified; the file header says why);
  `zones.ts`, `timezones.ts` and `nixos.ts` feed General's two pickers
  and its Engine card: the Cloudflare zones the API token can see,
  tzdata's `zone.tab` from /export, and the release's support window,
  channel and notes).
  `core/site/` is the site repository — the JSON description of this
  box that daedalus creates and commits (`fleet.site.path`, the
  `site-request.json` bridge). `file.ts` renders the exact bytes the
  host writes; `index.ts` compares them against the digests
  `/repo/repo.json` publishes, which is what "in sync" means on the
  tab. **apps.json in it is copied from `/export/applied.json`, never
  re-rendered from the apps table**: the mirror's claim is that it holds
  what the running system was BUILT from, and between an edit and an
  Apply those two legitimately differ.
  `types.ts` is client-safe; nothing else in `core/` is.
- `src/server/` — server functions (category, lemonade, registry,
  settings). The seam a route imports STATICALLY, so its module top
  level must be client-safe: **every value import here is `await
  import(...)` inside the handler**, which the Start plugin erases from
  the client build. A static import of `host/`, `core/`, `lib/repo/` or
  `lib/dashboard/` from this directory puts that module in the browser
  chunk of every route that uses the server function; `host/boundary.test.ts`
  fails on it.
- `src/lib/repo/` — drizzle repositories (apps, deployments);
  `src/host/schema.ts` + `host/db.ts` for the database side
  (`pnpm db:generate` / `db:migrate` for schema changes; drizzle.config
  points at `src/host/schema.ts`).
- `src/host/` — everything that needs the machine: the bridge and one
  module per verb (`bridge.ts`, `apply.ts`, `apply-flow.ts`,
  `deploy.ts`, `image-update.ts`, `update-flow.ts`, `site-request.ts`,
  `power-request.ts`, `claude-rc-request.ts`, `build-bridge.ts`), the
  database (`db.ts`, `schema.ts`), the env schema and the snapshot
  readers (`env.ts`, `env-snapshot.ts`, `nix-manifest.ts`,
  `workspaces.ts`), the credential-carrying clients (`keys.ts`,
  `prom.ts`, `loki.ts`, `metrics.ts`, `access.ts`, `registry.ts`,
  `github-token.ts`, `github-repos.ts`, `github-app-crypto.ts`,
  `app-icon.ts`, `vpn-egress.ts`), and `host/contract/`.
- **The contract, in two halves.** `src/lib/contract/` is the pure
  half — `decode.ts` (the combinators; `lib/repo` and `lib/dashboard`
  decode with them too) and `version.ts` (the registry schema version).
  `src/host/contract/` is the half that opens files: `snapshot.ts` (the
  one reader for every host-published file) and `domains/*.ts` (one
  reader per `/export` domain).

## Data-flow rules

- Host facts arrive via **read-only mounts**, every one of them `:ro`:
  the versioned `/export` domains, the env snapshot at /env-snapshot,
  image labels and freshness at /images, SMART/ZFS/generations at
  /system, Remote Control's state at /claude, the DHCP reservations at
  /dhcp, deploy state at /deploy-state, project workspace clones at
  /workspaces, build logs at /builds, the GitHub App's webhook secret at
  /github and its installation token at /github-token, shotter's run
  archive at /shotter (contributed by the shotter stack, not
  `daedalus.nix`), the nix manifest at /registry/manifest.json, the
  encrypt-only `sops` binary at /usr/local/bin/sops, and the
  CONFIGURATION repository's git facts at /repo — remote, head, dirty
  counts, drift, last Apply commit, plus the site directory's state and
  a digest per managed file, never the tree itself. (The engine clone's
  own git facts come from /workspaces, not /repo.) The committed site
  directory is at /site, read-only like the rest even though it is the
  one directory daedalus writes — the writes go through the bridge —
  and since Phase 5 its site.json is THE source of the site constants
  nix builds with, so the settings tabs edit against it. **/apply is the
  only writable mount**, apart from /app, which is this clone itself.
  Never reach around them (no SSH-ing the host, no reading host paths
  directly) — if a page needs a new host fact, extend the matching
  snapshot script in the s2-server repo's `stacks/daedalus/host/` and
  its nix wiring.
- Config values come from env vars bound in `daedalus.nix` (in the
  s2-server repo's `stacks/daedalus/`; `src/host/env.ts` is the schema: one
  row per variable, read with `env.get('NAME')`, and a name that is not
  a row does not compile. A new variable is a new row first. Only
  DATABASE_URL is required; the rest read as undefined, or their row's
  fallback, when unset or malformed)
  — never hardcode hostnames, IPs, versions, or tokens in TypeScript;
  the nix side already knows them and binds them so they can't drift.
- Secrets (service API keys) arrive via rendered env files
  (`DASH_*`). The app only ever GETs with them.
- Writes to the box go through the file-drop bridges — one request file
  written into `/apply`, a host `.path` unit watching it, one status
  file written back; the container deliberately holds no host
  privilege. Ten verbs, as request file → host unit → status file:
  `request.json` → `daedalus-apply` → `status.json`;
  `image-request.json` → `daedalus-image-update` → `image-status.json`;
  `deploy-request.json` → `daedalus-deploy-trigger` →
  `deploy-status.json`; `build-request.json` → `daedalus-build` →
  `build-status.json`; `build-cancel-request.json` →
  `daedalus-build-cancel` → no status of its own (it stops the build
  `build-status.json` names, and only that one); `site-request.json` →
  `daedalus-site-write` → `site-status.json`; `workspace-request.json`
  → `daedalus-workspace-clone` → `workspace-status.json`;
  `power-request.json` → `daedalus-power` → `power-status.json`;
  `claude-rc-request.json` → `daedalus-claude-rc` →
  `claude-rc-status.json`; `github-token-request.json` →
  `daedalus-github-token` → `github-token-status.json`. `host/bridge.ts`
  is the one implementation of the mechanics (temp + rename, payload
  written before the request that points at it).
  A dedicated flow module in `host/` exists for exactly two of them —
  `apply-flow.ts` and `update-flow.ts` — because apply and image-update
  are the verbs whose button and `api.*` route would otherwise be two
  hand-copied bodies. Both are arrangements of `host/flow.ts`:
  `defineGate` (the lock, the `running` check, the pickup window) and
  `defineFlow` (check input → refuse busy → prepare → publish, in that
  order). WHO may call stays with each door, and the routes turn the
  outcome into a response with `lib/http-result.ts` — whose dialect
  `/api/deploy` and `/api/github/webhook` deliberately do not speak
  (zot and GitHub are their readers). The rest write their bridge straight from their
  own module (`deploy.ts`, whose redeploy button and zot push event
  both call its `requestDeploy`; `build-bridge.ts`, `site-request.ts`,
  `workspaces.ts`, `power-request.ts`, `claude-rc-request.ts`,
  `core/github-app.ts`) — all of them under `host/`.
  `build-request.json` is the one the box's own builder watches:
  `daedalus-build.service` picks it up, writes progress back to
  `/apply/build-status.json` (heartbeated; stale past 90 s) and its log
  to `/var/log/daedalus-builds/<id>.log`, which is the `/builds` mount
  above.
- External-service reads follow the escalating-retry rule: retry only
  thrown requests with a `[400, 800, 1500, 2500]` ms ladder (the
  rootless-port first-SYN stall), never retry a busy upstream (Loki
  gets ONE patient attempt).
- **Stages are a four-rung ladder, spelled out in exactly one place —
  the `APP_STAGES` tuple in `lib/stage.ts`**: `declared` → `off` →
  `lab` → `live`, each adding to the last. `declared` runs nothing at
  all (no container, no deploy unit, no ingress) while still
  materializing the app's postgres role, data dir and `AUTH_SECRET`,
  so **a new app is created `declared`, and creating one is not gated
  on anything**: `createApp` forces it and `validateNewApp` refuses
  any other value, because the box only builds apps already present in
  the committed `apps.json` and an entry above `declared` whose image
  does not exist fails the switch and reverts its own Apply. The order
  is create → Apply → build → promote → Apply, and the promotion is
  offered on the app's page rather than left to be remembered. When
  reading a stage, ask the question you mean — `stageRuns` or
  `stageExposed` — never `!== 'off'`, which counts a declared app as
  exposed.
- The create form (`routes/apps.new.tsx` + `lib/readiness.ts`)
  **reports; it does not gate**. A missing image is the expected state
  of a new app, and a repo with neither a `railpack.json` nor a
  `Dockerfile` is a warning — Railpack can work zero-config, even
  though no app here has. Anything that would block creation again
  needs a better reason than either of those had.

## Style

Match the existing code: server functions + repos, no client-side
secrets, tables/tiles composed from the shared UI primitives already
in `src/components/`. Comments follow the repo rule: only constraints
the code can't show.

Anything visual — a component, a route, a stylesheet — has its own
rule: **`.claude/rules/daedalus-ui.md`**, which loads alongside this
one. Tailwind v4 + shadcn over runtime-swappable tokens; the cascade
layer order is load-bearing, colour literals are banned outside
`theme.css`, and `src/styles.css` only ever shrinks.
