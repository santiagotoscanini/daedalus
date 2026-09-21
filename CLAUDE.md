# daedalus — the engine repo

Notes for a Claude Code session working here. Read this, then let the
path-scoped rules load as you touch files.

## What this repo is, and is not

- **Is:** the Daedalus app (`app/`, TanStack Start + React 19 + Vite 8,
  drizzle-orm, Tailwind v4 + shadcn) and its public landing site
  (`website/`, a standalone pnpm project deployed to GitHub Pages by
  `.github/workflows/website.yml`). Public: `santiagotoscanini/daedalus`.
- **Also is:** the app builder. Since 2026-09-12 daedalus owns the fleet's
  image builds — the box's GitHub App takes the push webhook, the queue and
  the `build` bridge verb live in `app/src/lib/` (`builds.ts`,
  `build-queue.ts`) and `app/src/host/` (`build-bridge.ts`, the half that
  touches the disk), the driver that dispatches them and
  reports back in `app/src/core/builds/` (`scheduler.ts`, `report.ts`), and
  results reach GitHub as a check run plus a Deployment. The app repos carry
  no workflow files; a `railpack.json` is the normal build path, and a repo's
  own Dockerfile is still a supported strategy.
- **Also is:** the NixOS side. `nix/platform/**`
  (the OS-level base) and `nix/stacks/daedalus/**` (`daedalus.nix`, the
  builder, the host agents `host/*.sh` — apply, deploy, build, image and
  site bridges, the snapshot scripts — and the runtime image context
  `assets/`), exported by the root `flake.nix` as
  `nixosModules.{platform,daedalus,default}`. The operator's private
  configuration takes it as a flake input pinned by rev. It lives on
  `main` with everything else — this repo has exactly ONE branch, always
  — at the root beside `app/`. On the operator's box this clone is
  bind-mounted into the running app: a save under `app/` is a live
  deploy, the dev server does not watch `nix/`, so nix work here is safe
  as long as it stays out of `app/`.
  Anything that changes how the container is built, what env it gets, or
  what host fact reaches it is a `nix/` change: `nix fmt` + `nix flake
  check`, commit on `main`, push,
  then `nix flake update daedalus` + a rebuild in the configuration.
  Read `nix/README.md`, and `.claude/rules/nix-engine.md` loads on
  `nix/**`. It is NOT yet a module a stranger can import and evaluate —
  the stacks it rides on are still in the private configuration (plan
  Phase 11); do not describe it as finished.
- The `website/` docs page inventories the operator's external setup.
  Keep it honest about what the linked repo contains.

## The dev loop

On the box, the running container bind-mounts this clone's `app/` at
`/app` (`source.mode = "local"`) and runs the Vite dev server against
it. What a change needs:

- `app/src/**` → nothing. Saving the file is the deploy; Vite compile
  errors land in `podman logs app-daedalus`.
- `app/package.json` → `sudo systemctl restart podman-app-daedalus`
  (re-runs `pnpm install --frozen-lockfile`; Verdaccio is a hard
  startup dependency, minutes on a cold cache).
- routes added/renamed → `pnpm generate-routes`, or `pnpm typecheck`,
  which runs it. `app/src/routeTree.gen.ts` is generated and
  gitignored; never edit it.
- schema changes → `pnpm db:generate` / `pnpm db:migrate`.
- anything under `nix/` → `nix fmt` + `nix flake check`, commit on `main`, push, then
  `nix flake update daedalus` and a rebuild in the configuration repo.

No node/pnpm on the host: everything runs inside the container.

## Verify before calling it done

```
podman exec app-daedalus sh -lc 'cd /app && pnpm typecheck'
podman exec app-daedalus sh -lc 'cd /app && pnpm exec biome check .'
podman exec app-daedalus sh -lc 'cd /app && pnpm vitest run'
```

Content under the SSO gate (the dev server trusts its caller):

```
podman exec app-daedalus node -e \
  "fetch('http://localhost:3000/<page>').then(r=>r.text()).then(t=>console.log(t.includes('<needle>')))"
```

Pixels under the gate — the shotter image on the app's own bridge, with
the PINNED tag from `podman images` (`:latest` is a stale leftover):

```
podman run --rm --network=iso-daedalus-net --shm-size=1g \
  -v ~santiago/selfhost/shotter:/lab localhost/shotter:<pinned tag> \
  node /opt/lab/runner.mjs --out /lab/runs/<id> \
  --url http://app-daedalus:3000/<page> --script /lab/drivers/<driver>.mjs --label <label>
```

Read `events.json` in the run dir before trusting the PNGs. Two
pageErrors per load is the documented baseline (the HMR websocket 302s
at the gate; a pre-existing Date.now() hydration mismatch) — compare
against that, not zero.

## The rules are the guides

`.claude/rules/daedalus-app.md` (loads on `app/**`) is the architecture
map, the data-flow rules (snapshot mounts, env schema, file-drop
bridges, the escalating-retry ladder) and the style rule.
`.claude/rules/daedalus-ui.md` (loads on `app/src/components/**`,
`app/src/routes/**`, `app/src/*.css`) is how to write a component:
the three stylesheets, the cascade layer order, the colour-literal ban.
`.claude/rules/nix-engine.md` (loads on `nix/**` and `flake.nix`)
is the law for the NixOS side: no box identity, the engine
declares and the host defines, no container pins, the two-repo dev loop.
They are THE style and architecture guides; this file only points at
them. When they disagree with code you find, the rule wins and the code
is the bug.

## Commits

Commit often, as `santiago`. This clone is one of the box's project
workspaces: a timer fast-forwards it every 30 minutes and after every
deploy, but leaves a dirty or diverged tree alone, so local work is
never overwritten. The clone lives under `~/projects`, which is
snapshotted and mirrored; the remote is still the copy that survives a
disk. Pushing is the operator's call unless told otherwise.
