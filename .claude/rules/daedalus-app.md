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
  saving the file IS the deploy. Check the browser.
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
  `apps.$name.tsx` / `apps.new.tsx` (the app-registry UI), and
  `api.*.ts` server routes (healthz, deploy hook, registry
  apply/export/import, app-icon).
- **The mirrored category convention**:
  `src/lib/dashboard/categories/<name>.ts` (data/query layer) ↔
  `src/components/category/<name>.tsx` (render layer), one pair per
  category (ai, gaming, home, media, monitoring, network, system).
  `src/lib/dashboard/nav.ts` is the category/tab registry — a new
  category registers there. Known asymmetry: `idp.tsx`'s data lives in
  `src/lib/dashboard/idp.ts` (not under `categories/`).
- `src/server/` — server functions (category, lemonade, registry).
- `src/lib/repo/` — drizzle repositories (apps, deployments);
  `src/lib/schema.ts` + `db.ts` for the database side
  (`pnpm db:generate` / `db:migrate` for schema changes).

## Data-flow rules

- Host facts arrive via **read-only /run snapshot mounts** (env at
  /env-snapshot, image labels at /images, SMART/ZFS at /system, CI at
  /ci, deploy state at /deploy-state) and the nix manifest at
  /registry/manifest.json. Never reach around them (no SSH-ing the
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
  request.json / deploy-request.json / ci-request.json) — the
  container deliberately holds no host privilege.
- External-service reads follow the escalating-retry rule: retry only
  thrown requests with a `[400, 800, 1500, 2500]` ms ladder (the
  rootless-port first-SYN stall), never retry a busy upstream (Loki
  gets ONE patient attempt).

## Style

Match the existing code: server functions + repos, no client-side
secrets, tables/tiles composed from the shared UI primitives already
in `src/components/`. Comments follow the repo rule: only constraints
the code can't show.
