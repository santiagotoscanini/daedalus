# daedalus — the engine repo

Notes for a Claude Code session working here. Read this, then let the
path-scoped rules load as you touch files.

## What this repo is

- **The app** (`app/`, TanStack Start + React 19 + Vite 8, drizzle-orm,
  Tailwind v4 + shadcn) and its public landing site (`website/`, a
  standalone pnpm project deployed to GitHub Pages by
  `.github/workflows/website.yml`; its docs page inventories the
  operator's external setup — keep it honest about what this repo
  contains). Public: `santiagotoscanini/daedalus`.
  The landing's services field ("Everything it touches") reads ONE file,
  `website/src/data/services.ts`. An entry means the engine or the reference
  box really runs or reaches that service; add or remove one by editing the
  file, and nothing on the page prints a count. Each entry names its vendored
  official mark (`website/src/assets/icons/<id>.*`) and where it came from
  (the credits table); a service with no official mark is left out, never
  given a monogram, and the Daedalus mark never appears in that section. The
  site build fails if a `nix/modules/<id>` has no entry (give a module with no
  mark of its own `hidden: true`) or an entry has no icon file.
- **The app builder.** The box's GitHub App takes the push webhook; the
  queue and the build verb's app half are `app/src/lib/` (`builds.ts`,
  `build-queue.ts`), `app/src/host/build-verb.ts` and
  `app/src/core/builds/` (`scheduler.ts`, `report.ts`). App repos carry no
  workflow files — [BUILDS.md](BUILDS.md).
- **The NixOS side** (`nix/`): `platform/`, `stacks/daedalus/` (the control
  plane, the builder, the controller and root helper, the root verbs'
  `host/*.sh`) and the catalog `modules/<id>/`, exported by the root
  `flake.nix` as one module, `nixosModules.default`. `example-host/`
  evaluates as a whole host in `nix flake check`; most of the reference
  host's stacks are still in its private configuration — `nix/README.md`
  "What is NOT done yet" is the list; do not describe the engine as
  finished.
- **The agent** (`agent/`) and **the session host** (`session-host/`), each
  with its README and `gate.sh`.

This repo has exactly ONE branch, `main`, always. Never create another.

## The dev loop

The operator's box runs the production image, built on the box from the
engine rev its configuration locks (`fleet.daedalus.source = "local"`).
Nothing in this checkout is live: `app/` and `nix/` alike reach the box
only through a commit.

1. Edit, run the gates below, commit on `main` (as `santiago`; stage by
   path), `git push origin main` — pushing is the normal step, because a
   host's lock must only ever name a rev a fresh clone contains.
2. In the configuration (`/etc/nixos`): `nix flake update daedalus`, then
   its rebuild loop. The image is built as a pre-switch check: a failed
   build refuses the switch and the running image stays. System › Updates
   › Engine is step 2 as one button, reverting if the control plane does
   not come back.

What a change also needs:

- `app/package.json` → `dependencies` holds only what the built server
  resolves at run time; everything the build bundles, React included, is a
  `devDependency` — CONTRIBUTING.md "Building and running the built
  server" says why, and `check-build` enforces it.
- routes added/renamed → `tsr generate` (the typecheck gate runs it).
  `app/src/routeTree.gen.ts` is generated and gitignored.
- schema changes → `pnpm db:generate`; migrations apply at server start.
- `nix/`, `Dockerfile`, `docker-entrypoint.sh` → `nix fmt` + `nix flake
  check`; `.claude/rules/nix-engine.md` loads on `nix/**`.

`fleet.daedalus.source = "dev"` (a bind-mounted `app/` under `vite dev`)
exists for a host that wants one; this box does not use it.

## Verify before calling it done

No node on the host. The app's gate runs in a throwaway container over
the clone's installed `node_modules` (an overlay, so nothing is written to
it); a `package.json` change needs that install refreshed first:

```
podman run --rm -v <clone>:/w -v <clone>/app/node_modules:/w/app/node_modules:O \
  -w /w/app -e CI=true docker.io/library/node:24 bash -c \
  'node_modules/.bin/biome check . && node_modules/.bin/tsr generate && node_modules/.bin/tsc --noEmit && node_modules/.bin/vitest run'
```

`agent/gate.sh` and `session-host/gate.sh` are the Rust gates.

Pages under the SSO gate: `shot daedalus`, which drives the shotter image
against `app-daedalus` with the reader token (the request gate,
`app/src/core/request-gate.ts`, lets a GET carrying it read with no
identity). Reads only: a driver that presses a button is refused.

```
shot daedalus quick /<page> [label]
shot daedalus run <driver>.mjs [label]
```

Read `events.json` in the run dir before trusting the PNGs; the baseline
is zero page errors.

## The rules are the guides

- `.claude/rules/daedalus-app.md` (loads on `app/**`): the architecture
  map, the data-flow rules, the style rule.
- `.claude/rules/daedalus-ui.md` (loads on components, routes, module
  views and the stylesheets): how to write a component.
- `.claude/rules/nix-engine.md` (loads on `nix/**`, `flake.nix`,
  `example-host/**`): no box identity, the engine declares and the host
  defines, no container pins.
- `ARCHITECTURE.md` and `BUILDS.md` are the design for a reader outside
  the code (the MCP server serves both to agents).

When they disagree with code you find, the rule wins and the code is the
bug.

## Commits

Commit often. This clone is one of the box's project workspaces: a timer
fast-forwards it every 30 minutes, but leaves a dirty or diverged tree
alone, so local work is never overwritten.
