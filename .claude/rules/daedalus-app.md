---
paths:
  - "stacks/daedalus/app/**"
---

# daedalus — developing the control-plane app

TanStack Start + React 19 + Vite 8, drizzle-orm on the shared pg
cluster, pnpm 11, node ≥ 24, TS 6. This is the box's admin UI; it runs
as a `source.mode = "local"` app — the container bind-mounts THIS
directory at /app and runs the Vite dev server against it.

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
- `assets/**` (the runtime image context) → `nixos-rebuild` (context
  hash → new image tag → restart).
- `daedalus.nix` → `nixos-rebuild`.

**Before calling any change done: `pnpm typecheck`** (runs
`tsr generate && tsc --noEmit`) from `stacks/daedalus/app/`.
`src/routeTree.gen.ts` is generated + gitignored — never edit it; if
routes changed, `pnpm generate-routes` (or typecheck, which runs it).

⚠ /etc/nixos lives on rpool/root — NO ZFS snapshots, NOT in the
syncoid mirror. The only copy of this app outside this disk is what
has been pushed. Commit often.

## Architecture map

- `src/routes/` — TanStack file-based routes: `__root.tsx`,
  `c.$category.tsx` (the category dashboard shell), `apps.index.tsx` /
  `apps.$name.tsx` (loader + frame only; its tab bodies live in
  `src/components/apps/*`) / `apps.new.tsx`, and `api.*.ts` server
  routes (healthz, deploy hook, registry apply/export/import,
  app-icon).
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
- `src/server/` — server functions (category, lemonade, registry).
- `src/lib/repo/` — drizzle repositories (apps, deployments);
  `src/lib/schema.ts` + `db.ts` for the database side
  (`pnpm db:generate` / `db:migrate` for schema changes).
- `src/lib/contract/` — the decode layer for everything the host
  publishes (`/export` domains, snapshots, the registry schema
  version).

## Data-flow rules

- Host facts arrive via **read-only /run snapshot mounts** (env at
  /env-snapshot, image labels at /images, SMART/ZFS at /system, CI at
  /ci, deploy state at /deploy-state, project workspace clones at
  /workspaces) and the nix manifest at /registry/manifest.json. Never reach around them (no SSH-ing the
  host, no reading host paths directly) — if a page needs a new host
  fact, extend the matching snapshot script in `stacks/daedalus/host/`
  and its nix wiring.
- Config values come from env vars bound in `daedalus.nix`
  (`src/lib/env.ts` is the schema) — never hardcode hostnames, IPs,
  versions, or tokens in TypeScript; the nix side already knows them
  and binds them so they can't drift.
- Secrets (service API keys) arrive via rendered env files
  (`DASH_*`). The app only ever GETs with them.
- Writes to the box go through the file-drop bridges (`/apply`
  request.json / deploy-request.json / ci-request.json /
  power-request.json / image-request.json) — the container
  deliberately holds no host privilege. Each has one flow module in
  `lib/` (`apply-flow.ts`, `update-flow.ts`) that BOTH doors — the
  button and the `api.*` route — go through, so the two cannot drift.
- External-service reads follow the escalating-retry rule: retry only
  thrown requests with a `[400, 800, 1500, 2500]` ms ladder (the
  rootless-port first-SYN stall), never retry a busy upstream (Loki
  gets ONE patient attempt).

## Style

Match the existing code: server functions + repos, no client-side
secrets, tables/tiles composed from the shared UI primitives already
in `src/components/`. Comments follow the repo rule: only constraints
the code can't show.
