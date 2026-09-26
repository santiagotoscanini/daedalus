---
paths:
  - "app/**"
---

# daedalus — developing the control-plane app

TanStack Start + React 19 + Vite 8, drizzle-orm on the shared pg
cluster, pnpm 11, node ≥ 24, TS 6. This is the box's admin UI; the NixOS
module that runs it is this repo's `nix/stacks/daedalus/daedalus.nix`.

The dev loop (what a change needs, what restarts what) and the
verification commands — typecheck, biome, vitest, a page fetched under the
SSO gate, pixels through the shotter image, the two baseline page errors —
are in the root `CLAUDE.md`, which is always loaded. They are not repeated
here.

## Architecture map

- `src/routes/` — TanStack file-based routes: `__root.tsx`,
  `index.tsx` (redirects to `/apps`), `c.$category.tsx` (the category
  dashboard shell), `apps.index.tsx` / `apps.$name.tsx` (loader + frame
  only; its tab bodies live in `src/components/apps/*`) /
  `apps.new.tsx`, `apps_.$name.builds.$id.tsx` (one build: its log,
  facts and cancel), `settings.tsx`, `claude.tsx`, `profile.tsx`,
  `login.tsx` (the break-glass local login, a 404 unless site.json turns
  it on — `core/local-login.ts`), and `settings_.github.callback.ts`,
  where GitHub returns the App manifest's `?code&state`. The `api.*.ts`
  server routes are only what an
  outside caller needs — healthz, the deploy hook (zot's push event),
  the GitHub push webhook, a node agent's hello, app-icon,
  profile-picture, and the two image servers — `shot-run` for a
  shotter run's frames and `deploy-shot` for an app's post-deploy
  screenshot. No route is a "scriptable twin" of a button: the UI's
  writes go through server functions (`src/server/**`) and an agent's
  through the MCP tools at `/mcp` (`host/mcp/`) — those are the two
  doors onto a flow.
- **The dashboard modules — `src/modules/<id>/`**: one directory per
  category page (actions, ai, database, gaming, home, media, monitoring,
  network, system),
  found by `import.meta.glob`, never listed. Each holds `manifest.ts`
  (pure data: label, lede, rail `order`, the tabs with their probes,
  spans and the `nix` module ids each tab fronts), `releases.ts` when it
  fronts containers (their release sources, merged into
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
  env, secret, gateway, exportPath, snapshot, store, http, prom, loki,
  github, hosts, site, modules). `ctx.prom` and `ctx.loki` are the only way a module
  reads PromQL or LogQL, and `ctx.github.app` / `ctx.github.anon` the
  only way it reads GitHub — the boundary test refuses a value import of
  `host/prom`, `host/loki` or `host/keys` under a module's `data/`.
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
  two-clock stale-serving contract) are pure and live in `lib/`;
  `host/prom.ts` (PromQL + promEscape) and `host/loki.ts` (LogQL,
  one-patient-attempt budget) read their base URL from the env, so they
  live in `host/`. `lib/format.ts` (isomorphic formatters) is importable
  from a component; the DASH_* secrets accessor is `host/keys.ts`, apart
  from it on purpose.
- `src/core/` — server-only decisions, imported dynamically like
  `lib/repo/*`. `ctx.ts` is the capability set above; `auth.ts` /
  `authz.ts` are who is calling and whether they may (`assertAdmin`,
  and `assertMachineActor` for the MCP token); `builds/` is the
  scheduler, dispatch, sweep and GitHub reporting. `core/settings/` is the
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
  box that daedalus commits (`fleet.site.path`; site.json reaches it only
  through an Apply). `file.ts` renders the exact bytes the
  host writes; `index.ts` compares them against the digests
  `/repo/repo.json` publishes, which is what "in sync" means on the
  tab. **apps.json is not rendered here at all**: only an Apply writes
  it, from the apps table, so the tab reports it without a comparison.
  `settings/types.ts` and `auth-names.ts` are the client-safe files in
  `core/`; a component imports nothing else from it.
- `src/server/` — server functions, one file per area (registry,
  builds, settings, site, modules, updates, …), each starting from a
  `server/fn.ts` builder: `readFn`, `adminFn` (the admin check runs as
  middleware before the handler) or `publicFn`, and `server/fn.test.ts`
  fails on a POST that is neither `adminFn` nor on the short `publicFn`
  list. The seam a route imports STATICALLY, so its module top level
  must stay client-safe: anything that needs the machine is `await
  import(...)`ed inside the handler, which the Start plugin erases from
  the client build. A static import of such a module (a `node:`
  builtin, the database or `process.env`, directly or through what it
  imports) puts it in the browser chunk of every route that uses the
  function; `host/boundary.test.ts` fails on it.
- `src/lib/repo/` — drizzle repositories (apps, builds, deployments,
  github deliveries, nodes, settings);
  `src/host/schema.ts` + `host/db.ts` for the database side
  (`pnpm db:generate` / `db:migrate` for schema changes; drizzle.config
  points at `src/host/schema.ts`).
- `src/host/` — everything that needs the machine: the bridge and one
  module per verb (`bridge.ts`, then e.g. `apply.ts`, `build-bridge.ts`,
  `deploy.ts`, `image-update.ts`, `engine-update.ts`, `secret-set-request.ts`
  — the full set is below), the flows (`*-flow.ts`), the MCP server
  (`mcp/`), the database (`db.ts`, `schema.ts`), the env schema and the snapshot
  readers (`env.ts`, `env-snapshot.ts`, `nix-manifest.ts`,
  `workspaces.ts`), the credential-carrying clients (`keys.ts`,
  `prom.ts`, `loki.ts`, `metrics.ts`, `access.ts`, `registry.ts`,
  `github-token.ts`, `github-repos.ts`, `github-app-crypto.ts`,
  `app-icon.ts`, `vpn-egress.ts`), and `host/contract/`.
- **The contract, in two halves.** `src/lib/contract/` is the pure
  half — `decode.ts` (the combinators; `lib/repo` and `lib/dashboard`
  decode with them too), `fields.ts` (the shared request-field
  decoders) and `version.ts` (the registry schema version).
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
  and its site.json is THE source of the site constants nix builds
  with, so the settings tabs edit against it. The engine repository's
  root is at /engine, for the two design documents the MCP server
  serves (`host/mcp/docs.ts`). **/apply is the
  only writable mount**, apart from /app, which is this clone itself.
  Never reach around them (no SSH-ing the host, no reading host paths
  directly) — if a page needs a new host fact, extend the matching
  snapshot script in `nix/stacks/daedalus/host/`
  and its nix wiring.
- Config values come from env vars bound in `daedalus.nix` (in
  `nix/stacks/daedalus/`; `src/host/env.ts` is the schema: one
  row per variable, read with `env.get('NAME')`, and a name that is not
  a row does not compile. A new variable is a new row first. Only
  DATABASE_URL is required; the rest read as undefined, or their row's
  fallback, when unset or malformed)
  — never hardcode hostnames, IPs, versions, or tokens in TypeScript;
  the nix side already knows them and binds them so they can't drift.
- **Configuration is a run-time fact, never `import.meta.env`.** Vite
  inlines `import.meta.env.VITE_*` into BOTH bundles at build time, and an
  image is built once for every box — the boundary test refuses the read
  anywhere in `src`, and `pnpm build` (`scripts/build.mjs`) binds a canary
  to each identity variable and fails if one turns up in `dist/`. The
  box's identity — base domain, GitHub owner, registry host, Grafana URL —
  is a `Site` value (`lib/site.ts`: the type, `siteFrom` with the
  placeholder-shaped fallbacks, and pure helpers that TAKE the site:
  `defaultImage(site, name)`, `appRepo`, `stripBaseDomain`,
  `registryHostPattern`; `lib/hostname.ts`'s `hostnameError` and
  `effectiveHostname` take it first too). There is ONE reader,
  `host/site.ts` `readSite()`, over the env rows `BASE_DOMAIN`,
  `GITHUB_OWNER`, `REGISTRY_HOST`, `GRAFANA_URL` — each falling back to its
  old `VITE_` spelling, and deliberately not to `/export/site.json` or
  `/site` (the file header says why). A module loader reads `ctx.site`;
  other server code calls `readSite()` at the entry point and passes the
  value down; a component calls `useSite()` (`lib/site-context.tsx`),
  which the root route fills from its awaited loader (`fetchShell`,
  which carries `fetchSite`), so the
  value is in the server's HTML and hydration matches. No module-level
  constant may hold any of it.
- Secrets (service API keys) arrive via rendered env files
  (`DASH_*`). The app only ever GETs with them.
- Writes to the box go through the file-drop bridges — one request file
  written into `/apply`, a host `.path` unit watching it, one status
  file written back; the container deliberately holds no host
  privilege. The verbs (request file → host unit → status file) are the
  table in `ARCHITECTURE.md` § The bridge; the host half of each is in
  `nix/stacks/daedalus/`. `host/bridge.ts` is the one implementation of
  the mechanics (temp + rename, payload written before the request that
  points at it), and each verb's app half is one module under `host/`
  named for it (`apply.ts`, `build-bridge.ts`, `deploy.ts`,
  `image-update.ts`, `engine-update.ts`,
  `workspaces.ts`, `power-request.ts`, `claude-rc-request.ts`,
  `claude-session-request.ts`, `secret-set-request.ts`, `task-run.ts`,
  `version-update.ts`, `claude-code-update.ts`) — except
  `github-token-request.json`, which `core/github-app.ts` writes.
  The verbs that take a lock and a busy check before they publish are
  arrangements of `host/flow.ts` — `defineGate` (the lock, the `running`
  check, the pickup window) and `defineFlow` (check input → refuse busy
  → prepare → publish, in that order): `apply-flow.ts`,
  `update-flow.ts`, `engine-flow.ts`, `claude-code-flow.ts` and the flow
  inside `version-update.ts`. The first three are also what the MCP
  write tools call, so a button and a tool share one body. WHO may call
  stays with each door. `deploy.ts`'s `requestDeploy` is shared the same
  way by the redeploy button and zot's push event (`api.deploy.ts`).
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
