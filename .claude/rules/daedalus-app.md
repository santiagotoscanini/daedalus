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
- **The mirrored category convention**:
  `src/lib/dashboard/categories/<name>` (data/query layer) ↔
  `src/components/category/<name>` (render layer), one pair per
  category (ai, gaming, home, media, monitoring, network, system —
  idp sits under `categories/` too). A big category is a DIRECTORY:
  one file per tab id from nav.ts, the data union + tab dispatcher in
  `index.ts`, the view dispatch in `index.tsx`, cross-tab helpers in
  `shared.ts(x)` (leaf modules — never in the index, cycle risk). A
  small category stays a single file pair. The split rule: >3 tabs
  and >~1,000 lines → directory.
- **The category registry**: `lib/dashboard/category-data.ts`
  (CategoryDataMap + CategoryPayload, TYPE-only), `server/category.ts`
  LOADERS (dynamic-import thunks), `components/category/registry.tsx`
  VIEWS (static components). `src/lib/dashboard/nav.ts` declares
  categories/tabs. A new category = nav entry + all three records;
  the compiler enforces agreement.
- **The shared client layer**: `lib/http.ts` (retry ladder, request
  coalescer, pool), `lib/prom.ts` (PromQL + promEscape), `lib/loki.ts`
  (LogQL, one-patient-attempt budget), `lib/cache.ts` (swrCache /
  swrValue, the two-clock stale-serving contract), `lib/format.ts`
  (isomorphic formatters), `lib/keys.ts` (the DASH_* secrets
  accessor — the one process.env read, kept out of format.ts so
  components can import it).
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
  settings).
- `src/lib/repo/` — drizzle repositories (apps, deployments);
  `src/lib/schema.ts` + `db.ts` for the database side
  (`pnpm db:generate` / `db:migrate` for schema changes).
- `src/lib/contract/` — the decode layer for everything the host
  publishes (`/export` domains, snapshots, the registry schema
  version).

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
  s2-server repo's `stacks/daedalus/`; `src/lib/env.ts` is the schema)
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
  `daedalus-github-token` → `github-token-status.json`. `lib/bridge.ts`
  is the one implementation of the mechanics (temp + rename, payload
  written before the request that points at it).
  A dedicated flow module in `lib/` exists for exactly two of them —
  `apply-flow.ts` and `update-flow.ts` — because apply and image-update
  are the verbs whose button and `api.*` route would otherwise be two
  hand-copied bodies. The rest write their bridge straight from their
  own module (`deploy.ts`, whose redeploy button and zot push event
  both call its `requestDeploy`; `build-bridge.ts`, `site-request.ts`,
  `workspaces.ts`, `power-request.ts`, `claude-rc-request.ts`,
  `core/github-app.ts`).
  `build-request.json` is the one the box's own builder watches:
  `daedalus-build.service` picks it up, writes progress back to
  `/apply/build-status.json` (heartbeated; stale past 90 s) and its log
  to `/var/log/daedalus-builds/<id>.log`, which is the `/builds` mount
  above.
- External-service reads follow the escalating-retry rule: retry only
  thrown requests with a `[400, 800, 1500, 2500]` ms ladder (the
  rootless-port first-SYN stall), never retry a busy upstream (Loki
  gets ONE patient attempt).

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
