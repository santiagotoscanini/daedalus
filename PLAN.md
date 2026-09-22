# Daedalus — what's missing, and how to do it

Daedalus is the box's control plane: a TanStack Start app that writes JSON
under `site/` in the operator's NixOS config, a file-drop bridge that lets root
agents act on those writes, and the nix modules that read the JSON back. Today
it runs this one box (`s2-server`) from a dev server against a bind-mounted
checkout, builds the eight first-party apps on the box with Railpack, and
reports to GitHub as a check run and a Deployment.

This file is the **forward-looking** plan only: what is not built yet, why it
matters, and how to build it. What already landed is not recorded here — it
is in git history (the version of this file at `7451bc0` carried every phase outcome),
in `ARCHITECTURE.md` and `BUILDS.md` for the design as built, and in
`~/.claude/plans/piped-gathering-meerkat.md` for the GitHub App + Railpack
build-out (closed 2026-09-13).

## Where things stand (2026-09-22)

Phases 1–11 of the productization plan have landed:
the UI foundation, the read-only then editable Settings, the
repository split (private config `s2-server`, public engine `daedalus`),
`site/` as the one directory the UI writes, nix reading `site.json` and
`apps.json` as the source of the site constants and the app registry, the
secrets vault (Cloudflare token, GitHub App key), builds on the box through
the box's own GitHub App, an `admins` check on every mutation that waits only
for the operator to arm it, and a break-glass login built dormant. Since the
15th: scheduled tasks per app, the app secrets editor, the MCP server, the
Claude session roster with resume, a provenance stamp under `site/`, an
enable switch on all 43 stacks (9a, config `43388f0`) and the control plane
no longer reaching into other stacks at eval time (9c, `046b3ff`). On the
21st the NixOS side moved in: `nix/platform/**` and `nix/stacks/daedalus/**`
live here, on `main` — the repo's only branch — and the operator's
configuration takes them as a flake input. On the 22nd the spine followed —
the eleven stacks a box needs to log in to its control plane are catalog
modules, one image runs the control plane two ways, the engine updates
itself from its own page, and `nix flake init -t …#config` writes a host
that evaluates with all of it on (Phase 11, finished but for the optional
stacks; Phase 10, finished but for the first tag).

| Phase | What | State |
|---|---|---|
| 8 | Auth hardening | built; arming is the operator's hand (see "Owed to the operator") |
| 9 | Nix: enable surface, literals, state out of the tree | landed 2026-09-20/21; residue (asset literals, missing options) listed in the section |
| 10 | App module system and a real build | 10a landed; 10b landed 2026-09-22 — the one image (its `runtime` stage is the reference box's dev mode), `sops` inside it, the browser walk; only the first `v*` tag remains, and that is the operator's call |
| 11 | The engine becomes importable | the finish line reached 2026-09-22: the spine and seven leaves are in the catalog, a host made from `templates.config` evaluates with a control plane, `developer.engineOverride`, Update daedalus and the schema fixtures are in; 23 optional stacks remain private, and the reference box still names modules one by one |
| 12 | Onboarding, `init`, catalog, release | not started |

Beside the phases, the **Features** section lists what the product is missing
regardless of phase — previews, feature flags, the rest of the app secrets
editor, the app contract as packages, and more — each with its mechanism.

---

## The end state

**From the outside, the install is:** install NixOS → add ONE import (the
`init` command writes it and rebuilds) → open the web UI → configure the
domain, credentials, apps → daedalus writes JSON under `site/` in the user's
own config and rebuilds. The engine exposes a single NixOS module; that module
*reads* the JSON and the sops ciphertext at evaluation time. Daedalus never
generates nix files and never edits nix text: JSON in, system out. The import
has to exist before the web UI does (the UI is a container the module
declares), so the order is import → rebuild → UI, not UI → import. A "web UI
first" installer mode of the same app is a later refinement of `init`.

Two pieces:

```
ENGINE  github.com/santiagotoscanini/daedalus   (public)
  flake.nix           nixosModules.default (THE import), lib, packages.{init,image-stream}, templates.config
  nix/{platform,core,modules/<id>}   every stack gated by fleet.modules.<id>.enable
  app/                the TanStack Start app; src/core + src/modules/<id> (manifest, loaders, views, schema)
  host/               the bridge agents (apply, image-update, deploy-trigger, build, power, workspace, secrets)

CONFIG  the user's own NixOS config at /etc/nixos   (theirs; this box keeps its flake + hardware here)
  flake.nix           inputs.daedalus (pinned by tag)
  configuration.nix   imports daedalus.nixosModules.default; fleet.site.source = ./site; hardware; host specifics
  hardware-configuration.nix, host.nix — whatever the user hand-writes; daedalus never touches these
  site/               THE ONE DIRECTORY DAEDALUS WRITES. Data, not code:
    site.json         UI-WRITTEN: schemaVersion, identity, network, modules{enabled, settings}, integrations, imagePins
    apps.json         UI-WRITTEN: the app registry (schema unchanged; accepted as a RANGE)
    vault/<name>.sops one value per file, sops binary format, UI-written
    .sops.yaml        host key (ssh-to-age derivation) + operator recovery age key
```

Daedalus is a guest in the user's config, fenced to one directory — how every
other NixOS tool (home-manager, disko, sops-nix) integrates: your flake, their
input. A separate site repository was tried and retired: every Apply still had
to commit a `flake.lock` bump into the config repo, so it bought a two-repo
transaction and a "site HEAD vs lock disagree" failure mode without the purity
it promised.

`fleet.site.source` is the eval-time path the module reads JSON from (a flake
user writes `./site`); `fleet.site.path` is the run-time disk path the host
agents WRITE to (default `/etc/nixos/site`). v1 targets flake configs only.

**Source control is the user's business, with one exception.** A flake only
sees git-TRACKED files, so a `site/apps.json` written but never `git add`ed
fails the very rebuild it was written for. Hence three states, all reported on
the Settings tab: not a git work tree (daedalus writes and warns); a work tree
with the commit switch OFF (writes and `git add`s, leaves committing to the
human); a work tree with the switch ON (one commit scoped to `-- site/` per
Apply, push best-effort). The switch is a preference the app passes in each
request, so the agent stays dumb.

**Rollback does not depend on git.** The agent keeps the previous bytes of
every file it overwrites, builds FIRST, switches only if the build passed, and
on a failed switch restores the bytes and switches again. One mechanism for all
three states.

**Commit policy:**

| Change | Stored in | Commit |
|---|---|---|
| Anything nix consumes: domain, network, enabled modules, module settings, integration ids, apps registry, secrets | `site/` in the config repo | written + `git add`ed always; one commit scoped to `-- site/` per Apply when the switch is on |
| Engine version bump | config repo `flake.lock` ("Update daedalus" button) | same switch |
| Anything nix does not consume: theme, UI prefs, onboarding progress, deploy history, notes, drafts | Postgres | none |
| The engine | engine repo | never written by a running system |

**The app, end state.** One image, built by CI on GitHub-hosted runners into
`ghcr.io/santiagotoscanini/daedalus:<semver>@sha256`, pinned by the engine.
Users run it as-is (production bundle, no repo clone needed). Developers set
`DAEDALUS_DEV=1` and bind-mount their checkout to get `vite dev` with HMR from
the same image — the entrypoint decides at runtime, not at build time. Core =
registry, changeset Apply with diff preview, settings, secrets vault,
onboarding, auth, integrations (Cloudflare, GitHub), module registry
(`import.meta.glob` over `src/modules/*/manifest.ts`, splat route), a
capability `Ctx` handed to modules (no `process.env` in loaders), typed HTTP
results. Settings forms come from an in-house renderer over a constrained
JSON-Schema subset (the RJSF spike failed on bundle cost).

**Secrets, end state.** One value per sops file, encrypted **in the container
with public recipients only** (static `sops` binary in the image; `.sops.yaml`
bind-mounted read-only); no private key ever in the container; plaintext never
crosses the bridge directory. Multi-key env files are assembled on the host by
`sops.templates` with `restartUnits`, which closes the rotation false-success
trap structurally. Recipients: the host key via `ssh-to-age` and an operator
recovery age key shown exactly once. Rekey is a root bridge running `sops
updatekeys -y`. Never mount the repo root into the container.

**Onboarding, end state** (every step skippable and re-runnable from
Settings): init CLI on an existing NixOS → LAN setup mode with a journal setup
token → local admin + recovery key → domain + Cloudflare (token verify, zone
pick, probe TXT over DoH, locally-managed tunnel created via API) → Pocket ID
`/setup` then flip the gate to forward-auth + `admins` → install the box's
GitHub App on the account → source control (is `/etc/nixos` a git work tree?
offer the commit-on-change switch; suggest a private remote if it has none) →
first app, whose first push to main builds here.

---

## Rules for every phase

- **Every phase leaves daedalus and the box in a working state.** The server
  is in daily use. No phase may leave the machine half-migrated overnight.
- **Feature flags, not cut-overs.** New behaviour ships beside the old one
  behind a `site.json`/settings toggle or a nix option defaulting to the old
  behaviour; the phase ends by flipping the default once verified, and the
  old path is deleted one phase later. Rollback is a NixOS generation plus
  `git revert`.
- **App-only phases carry zero rebuild risk.** daedalus is `source.mode =
  "local"`, so saving a file is the deploy and `git revert` is the rollback.
- **Gate before switch** for nix phases: `nixos-rebuild build` → `nix store
  diff-closures /run/current-system ./result` (the diff must list only what
  the phase intends) → `nixos-rebuild test` → the container census
  (`podman ps` before and after, `curl` of every `healthPath`) → `switch` →
  commit + push. Phases that touch `stacks/app-db` are marked (pg restart →
  restart pocket-id after).
- No nix phase runs on the same day as an image update or the weekly flake
  autoupgrade (check the timer; disable it for the day).

Why these phases, in one list — the blockers still standing between this box's
dashboard and a product anyone can import:

1. **Authorization is built but not armed**: the `admins` check sits on
   every mutating server function and route behind `auth.enforceAdmins`,
   which is off until the operator flips it from Settings › Developer, so
   anyone past the forward-auth gate can still apply, reboot and reveal
   secrets (→ "Owed to the operator"). The break-glass login exists, dormant.
2. ~~No enable surface in nix~~ — landed as 9a and 9c on 2026-09-20. Twelve
   switches are structural non-flippers (documented in the config repo's
   `module-system` rule); `traefik` and `litellm` among them is the gap that
   matters for a stranger's box, and is a Phase 11 design question.
3. ~~~210 site literals and in-tree machine state~~ — landed as 9b on
   2026-09-21. What is left is literals inside ASSETS and a handful of
   facts with no option yet (Phase 9's section lists them); those, not the
   nix text, are what now stands between the platform and a public engine.
4. **No build**: `vite dev` in production against a bind mount; `vite build`
   never exercised; migrations are manual (→ Phase 10b).
5. **65% of the app is stack-specific dashboards** behind static registries
   and non-exhaustive `switch(tab)`s; `image-repos.ts` is a table of this
   box's containers (→ Phase 10a).
6. **Single-value schema versions** — users' `site/` directories and engine
   versions will drift (→ Phase 11).
7. **Install story**: a recovery doc assuming this hardware (→ Phase 12).

---

## Phases remaining

Order: 8 → 9 → 10 → 11 → 12. 9 and 10 are the long ones; 11's gate (an
identical closure) is the hard one.

### Phase 8 — Auth hardening (built; one hand edit remains)

The `admins`-group check exists on every mutating server function and API
route (32 sites, `core/authz.ts`), traefik forwards the IdP's groups as
`X-Forwarded-Groups` (live since the 2026-09-20 reboot), and the authz tests
pass. It is deliberately disarmed: `auth.enforceAdmins` is a stored setting
(Postgres, not `site.json`) that defaults to off, so the check runs and
reports but does not refuse.

1. **Arm it, in this order.** First confirm that a live request through the
   gate actually carries `admins` — Settings › Developer › Authorization
   shows the groups arriving and refuses server-side to arm from a request
   that does not name `admins` — and only THEN turn `auth.enforceAdmins`
   on. Reversed, an absent header reads as "not an admin" and locks the
   operator out of their own control plane. Operator's hand; nothing for
   the engine to do.
2. **The break-glass local login** — a setup token plus a local login
   (argon2id via `@node-rs/argon2`, sealed session cookie), built and
   dormant behind `site.json` `auth.localLogin` (absent = the route 404s;
   not editable from Settings on purpose; the onboarding wizard turns it on
   for new installs). Untested against a real IdP outage; Phase 12's
   rehearsal is where that happens.

Compatibility: the operator is in `admins`; arming changes nothing for them.
Gate: a test user outside the group gets 403 on Apply — run the suite the
day it is armed.

### Phase 9 — Nix: enable surface, literals, state out of the tree (landed; residue listed)

All three switches have landed. 9a and 9c on 2026-09-20 (config `43388f0`,
`046b3ff`): 43 `fleet.modules.<id>.enable` switches over an explicit import
list, then `fleet.dashboard.<id>` replacing every cross-stack read in
`daedalus.nix`, with immich-off proven to build. 31 of 43 switches flip; the
twelve that do not are structural and listed in the config repo's
`module-system` rule. 9b on 2026-09-21 (config `5022748`..`78e7a68`):

- **Literals.** `platform/operator.nix` declares who runs the box and where
  the checkout lives (`fleet.operator.*`, `fleet.config.repo`); the host
  defines them. About 190 literals across 50 files now read an option —
  the domain, own-hostnames through `fleet.webApps.<n>.hostname`, the user,
  uid, home, runtime dir, the hostname, the GitHub owner. Gate: the toplevel
  derivation byte-identical with the revision pinned, per slice and merged.
- **State.** The pg cluster and per-app credentials, every `AUTH_SECRET` and
  the builder's registry password moved from `stacks/*/secrets` in the
  checkout to `fleet.machineState` under the snapshotted state tree.
  `platform/machine-state.nix` migrates once (copy, compare, delete; refuses
  when two copies differ) and every bootstrap REQUIRES it, because each
  mints a fresh secret when it finds none. pg itself did not restart; its
  24 tenants did, Pocket ID came back, 67 containers before and after.
- **9c's engine half.** Four image versions read from `/export/images.json`
  (`pinnedVersion`, engine `3974248`) and their env bindings are deleted
  from the config. The other `*_VERSION` names are not image tags (a game
  binary, npm packages inside a local image, native NixOS services) and
  stay env reads, each for a stated reason.

What 9b still leaves for Phase 11, after the asset pass (config `b1f4498`,
`HEAD`):

- ~~Literals inside assets~~ — done 2026-09-21. Scripts take the operator,
  hostname and checkout from their wrappers; static configs are templated
  where nix reads them; the nine dashboards share one substitution step.
  Every rendered config came out byte-identical. Two facts got options
  because they had none: `fleet.operator.email` and `fleet.gpuHost`/
  `gpuHostIp`; the commit identity became `fleet.operator.git{Name,Email}`.
  A sweep of `platform/` and `stacks/` for this box's names now returns a
  docstring, a private-range constant and the engine's own upstream URL.
- ~~No option for the pool mountpoints, the rebuild lock's name~~ and
  ~~files that are host data~~ — done 2026-09-21 (config `7f8fd9b`..`e65824d`).
  `host/` holds this box's data: the dataset table and ARC cap
  (`fleet.zfs.*`), which dataset replicates where (`fleet.backup.replications`),
  the bulk-data roots (`fleet.data.<name>`, read by nine stacks) and the
  Claude MCP ciphertext (`fleet.claude.mcpSopsFile`). `platform/` keeps the
  mechanisms. Identical derivation throughout.
- **Still naming the box**, each needing a change that is allowed to differ:
  Grafana's `System/{storage,home-server,network}.json` hardcode
  `device=~"s2-pool.*"`/`"rpool.*"` in PromQL (wants a dashboard variable);
  `stacks/daedalus/host/system-snapshot.sh` spells `rpool/$child` (should come
  from the replication table through the wrapper); two app-level usernames
  (`calibre-web`'s `Remote-User`, LiteLLM's `PROXY_ADMIN_ID`) are a person's
  handles with no option; the LAN subnet in fail2ban (host file, fine) and
  `github.expectedOwnerId` (a security constant the host must define).
- **Design notes the split produced, for the move itself:** option
  DESCRIPTIONS do not enter the closure but comments inside shell heredocs
  do; `fleet.data` names are an informal contract (`tv`, `books`, `photos`,
  `minecraft` are read by stacks, and `books` by three of them); the dataset
  table and `fleet.data` spell each mount twice; `builder.nix` silently
  requires a dataset mounted at its root; `host/` files are ordinary modules
  the engine's example config must show being imported.

### Phase 10 — App module system and build (1–2 weeks, app only)

- **10a Registry — landed 2026-09-21 (engine `a6a87ce`).** Every category
  page is a directory under `src/modules/<id>/` found by
  `import.meta.glob`: a manifest, a data half whose loaders are a record
  keyed by the manifest's tab ids and receive a `Ctx` (no `process.env`
  under `src/modules/`, enforced by the boundary test), a view half with
  the matching record, and the release sources of the containers it
  fronts. Each tab names the nix modules it fronts; the rail is derived
  from `/export/modules.json` through `lib/modules/active.ts` and offers
  everything until the box publishes that file. The old three-record
  registry, nav table and type map are gone. Left for later, each small:
  - ~~`/export/modules.json` from nix~~ — published since config `666e9d6`
    (2026-09-21); the rail now follows the box's switches.
  - ~~`lib/dashboard/categories/idp.ts` as a core identity reader~~ — it is
    `core/identity/pocket-id.ts`, read through `Ctx` by Home's Sign-in
    (`modules/home/data/signin.ts`) and Network's Proxy.
  - ~~`defineFlow` extracted from `apply-flow.ts`/`update-flow.ts`~~ — it is
    `host/flow.ts`: the gate and the skeleton both flows were.
  - ~~Typed HTTP results~~ — `lib/http-result.ts`; the two scriptable doors
    (apply, image-update) answer through it.
  - ~~`env.ts` as the single validated schema with LiteLLM optional~~ —
    `host/env.ts`: only DATABASE_URL is required, `Ctx.env`/`Ctx.secret` are
    typed against its rows, and LiteLLM is `ctx.gateway`, null without one.
  - The data files still call `host/prom`, `host/loki` and `host/keys`
    directly rather than through `Ctx`; the capability set covers env,
    hosts, secrets, snapshots and the store, and those three clients are
    the remaining seam to fold in before a module can be tested against a
    fake `Ctx` alone.
- **10b Build — one image, runtime dev flag.** One Dockerfile, one image, one
  `docker run`. A multi-stage build: the `build` stage runs `vite build`
  (`ssr.noExternal: true`, srvx entry with the rejection guard, a build check
  that fails on `__vite-browser-external`, npmjs registry in CI); the final
  stage ships only the bundled output, `drizzle/` (migrations at start via
  the `drizzle-orm` migrator), and production dependencies. ~~Site identity
  comes from `/site` at runtime~~ — landed, from the container env rather
  than `/site`: `host/site.ts` reads `BASE_DOMAIN`, `GITHUB_OWNER`,
  `REGISTRY_HOST`, `GRAFANA_URL` per request (the `VITE_` spellings second,
  until the config renames its bindings), the root loader hands the browser
  the same value, and `pnpm build` fails if a canary bound to any of them
  turns up in `dist/`. `/site/site.json` was the wrong generation — it is
  what was last saved, not what is serving. CI on GitHub-hosted runners → ghcr by
  digest.

  **The dev flag:** `DAEDALUS_DEV=1` makes the entrypoint run `pnpm install
  && pnpm dev` against the bind-mounted source instead of the bundled output.
  Default (no flag): the user runs the container and never clones the repo —
  how Phase 12's `init` installs daedalus. With the flag + a bind mount at
  `/app`: `vite dev` with HMR. This replaces today's `source.mode = "local"`
  nix constant: the decision moves from nix eval time to container runtime,
  so switching is `systemctl restart` with an env change, not a rebuild.
  `source.mode` in nix simplifies to a boolean that controls whether the
  container gets the bind mount and the env var. Proof before the first
  release: a `shot` walk of the built image against a throwaway Postgres.

  **The blocker is cleared** (engine `e31b110`, 2026-09-21). On TanStack Start
  1.168 / vite 8 the build emits a fetch handler by design; `app/server.mjs`
  serves it with srvx (the adapter the framework's own preview uses), runs
  the drizzle migrator before the port opens, serves `dist/client` with
  immutable caching, and carries the same unhandled-rejection guard as dev.
  Server-function ids are `sha256(file--fn)` in a build and path-derived in
  dev; they never match across modes and need not — the client and server
  of ONE build agree (80 of 80, asserted by `scripts/check-build.mjs`, which
  `pnpm build` runs). Built: 690 ms to healthy and 203 MB; dev: 4 s and
  1.5 GB. Two things to check behind traefik: the framework's CSRF middleware
  wants `Sec-Fetch-Site: same-origin` or a matching `Origin`, and a tab left
  open across a deploy that MOVES a file calls ids that no longer exist
  until it reloads.

  **The image landed** (branch `w-image`, 2026-09-21). `Dockerfile` at the
  root, digest-pinned `node:24-slim`, `NPM_REGISTRY` a build arg defaulting
  to npmjs (the box passes Verdaccio); `docker-entrypoint.sh` picks the mode
  at start. 257 MB — 22 MB over the base — and ~30 s to build cold. The run
  stage's `node_modules` is `pnpm install --prod`, which is why
  `package.json`'s `dependencies` is now only the four packages the server
  resolves at run time and everything the build bundles moved to
  `devDependencies`; `check-build` enforces both directions. The dev branch
  costs the image 113 kB of corepack shims: pnpm and the toolchain come from
  the mounted tree (baking pnpm in measured +37 MB). Proven with podman
  against a throwaway `postgres:16-alpine`: migrations at start, healthz,
  `/apps` and `/settings` carrying a `BASE_DOMAIN`/`GITHUB_OWNER` given at
  `podman run` — and a different pair on the next run of the same image —
  a server function called by its built id, `podman stop` in 0.2 s; then the
  same image with `DAEDALUS_DEV=1` and a tree at `/app` serving through Vite.
  `.github/workflows/image.yml` publishes to ghcr on a `v*` tag only and has
  never run.

  What remains of 10b, in order:
  1. ~~**The nix side.**~~ — done 2026-09-22 (engine `db281f9`, config
     `41fbd90`), with one design change from the paragraph above: the box does
     NOT pull the published image. The Dockerfile gained a `runtime` stage
     (node, corepack's shims, sops, the entrypoint — everything but the
     bundle; the final stage builds on it), and a dev-mode box builds THAT
     stage on its own with `--target runtime` from a `lib.fileset` context of
     exactly `Dockerfile` + `docker-entrypoint.sh`, so the image's tag moves
     when the runtime changes and never when a route is edited — the property
     the old `assets/Containerfile` existed for, now with one Dockerfile.
     `source.mode`/`source.contextDir` became `source.dev` + `source.path`
     on every app (the image is always the app's; dev mode decides how it
     runs: the mount, `DAEDALUS_DEV=1`, `--user 0:0`, `NPM_REGISTRY` from
     `fleet.builder.npmMirrorHost`); `mkLocalImage` takes a build file and a
     target; the control plane's module has `fleet.daedalus.dev` (the box
     sets it) and `fleet.daedalus.image` (default: the engine's ghcr image at
     the version `app/package.json` declares, so pinning the engine pins the
     control plane). The sops bind mount is gone; the old Containerfile and
     entrypoint are deleted. Switched and verified: the container runs
     `localhost/app-daedalus-dev:runtime-<hash>`, healthz 200, `sops 3.13.3`
     from the image. The config still binds the `VITE_` spellings.
  2. ~~**`sops` in the image.**~~ — done 2026-09-21: a `sops` stage fetches
     the getsops 3.13.3 linux/amd64 release with `ADD --checksum` (version
     and sha256 are the stage's two ARGs; a mismatch fails the build) and the
     run stage copies it to `/usr/local/bin/sops`, where `core/vault.ts`
     execs it. Encrypt-only by construction — the image holds no age
     identity. 52 MB, so the image is 309 MB. The box's module dropped its
     own bind mount with (1).
  3. ~~**The `shot` walk**~~ — done 2026-09-21: `scripts/image-walk.sh` +
     `scripts/image-walk.mjs`, repeatable and run before a tag. Builds the
     image, checks its sops, starts it against a throwaway `postgres:16-alpine`
     with an identity given as env, walks `/`, `/apps`, `/settings`,
     `/c/system`, `/apps/new` and arms + disarms Settings › Developer ›
     Authorization with the forward-auth headers set from the driver
     (`admins`), refuses on any console error, page error, failed same-origin
     request or 5xx in `events.json`, then runs the dev branch over a copy of
     `app/` until Vite serves. First green run `20260921-222805-image-walk`:
     every assertion passed, the recording empty but for the Grafana panel a
     bare image cannot reach (its own `GRAFANA_URL`).
  4. **The first tag.** Publishing the first public image is the operator's
     decision: bump `app/package.json`, tag `v<version>`, push the tag. The
     ghcr package is private until its visibility is changed by hand. amd64
     only — the run stage holds the build platform's argon2 binary.

Compatibility: 10a is a refactor with tests (module registry tests, the
existing suite, fixture-driven loader tests that survive a null upstream);
10b is gated by `vite build` producing a working server.

### Phase 11 — The engine becomes importable (the finish line is reached; the leaves remain)

**Landed 2026-09-21 — the big-bang move, with an IDENTICAL closure.**
`platform/**` and `stacks/daedalus/**` left the operator's configuration and
are this repo's `nix/platform/**` and `nix/stacks/daedalus/**` (engine
`3aae896`; `c703ee3` for the upgrade's named inputs). The root `flake.nix`
exports `nixosModules.{platform,daedalus,default}` and
`lib.path`. The configuration (its `d829416`) takes the engine as the input
`daedalus` — `git+file://<the local clone>?ref=main` (`?ref=engine-nix` until
the branch was published, below), pinned by rev in
its `flake.lock` — and sets `specialArgs.enginePath = "${daedalus}/nix"`. The
gate held: the system store path was the same before and after. The prep that
made that possible is in the configuration's history (no relative path crosses
into the engine; credentials, pools, data roots and the `.mcp.json` ciphertext
became host-handed options; the gluetun pins became `fleet.gluetun.*`; the
weekly upgrade moves only `fleet.autoupgrade.inputs`, never the engine). Docs
for the tree: `nix/README.md`; the authoring rule: `.claude/rules/nix-engine.md`.

**Published 2026-09-21 — one branch.** The move was made on a local-only
branch, `engine-nix`, in a worktree of its own, pending the operator's review
of what a public `nix/` tree says. Reviewed and approved the same day:
fast-forwarded into `main`, pushed, the branch and the worktree deleted, the
configuration's input retargeted to `?ref=main`. **This repo has exactly one
branch, `main`, always.** `nix/`, `flake.nix`, `flake.lock` and `statix.toml`
sit at the root beside `app/`; a fresh clone now contains every rev a host's
lock can name, which closed the "platform layer exists on one machine only"
gap in the configuration's recovery runbook.

From here an engine-side nix change costs `nix fmt` + `nix flake check`, a
commit on `main` and a push, plus one `nix flake update daedalus` in the
configuration; its `/rebuild` skill detects a moved engine.

**Design notes — decisions the move made, so they are not re-litigated.**

- **Import ORDER is why the reference box does not import
  `nixosModules.default`.** List-typed options (`prometheusScrapes`, firewall
  ports, `assertions`) concatenate in module order, so the order of the import
  list is part of the closure. Before the move, the daedalus stack sat in its
  alphabetical slot AMONG the stacks; `nixosModules.default` would import it as
  a block, ahead of or behind all of them, and reorder those lists — a
  different closure, which the identical-closure gate forbids. So the box still
  names every engine module one by one, as `(enginePath + "/platform/…")` and
  `(enginePath + "/stacks/daedalus/…")`, in the old positions.
  `nixosModules.default` is the interface for everyone else; the box adopts it
  in a deliberate, separately-gated rebuild once the stacks have moved and
  there is nothing left to interleave with.
- **The engine's modules take nothing from its inputs.** The host picks nixpkgs, imports sops-nix,
  and hands `nixpkgs-unstable` in as a `specialArg`. The flake's two inputs
  (`nixpkgs`, `treefmt-nix`) serve only its own `nix fmt` / `nix flake check`,
  and a host makes both `follows` its own so its lock gains nothing. (The earlier plan's "nixpkgs
  following daedalus" is dropped.)
- **`enginePath` is a `specialArg`, not `_module.args`** — host stacks import
  the by-path libraries at module-import time, before a config exists.
- **A local `git+file` input reads commits, and only a named update moves
  it.** An unattended job is the wrong thing to discover what was committed
  in a clone.
- **No oci-container digest pin under `nix/`** — a catalog module reads the
  host-defined `fleet.images.<container>`:
  the update agent rewrites a `.nix` file in place and cannot write into a
  flake input. (`build-agent.nix`'s node image and `railpack.nix`'s frontend
  are not oci-containers; bumped by hand.)

**The finish line, reached 2026-09-22.** A host made from the engine's
template (`nix flake init -t …#config`) evaluates to a whole system with a
control plane to log in to: the reverse proxy, the identity provider, the
shared cluster, the registry, the resolver, the tunnel, logs, metrics, the
two monitors and the apps platform — the control plane's own container
included — are catalog modules, every one switched on in the template, and
`nix flake check` evaluates that template as written. Eleven stacks
crossed in one day, each under the identical-derivation gate, in this
order: `app-db` (engine `3e2d070`), `traefik` (`3969bd3`), `pocket-id`
(`ce47489`), `registry` (`f612aa7`), `logging` (`46e3a03`), `monitoring`
(`967e82b`), `apps` (`35c7a1c`), `pihole` (`5cbcaca`), `cloudflared`
(`0495b71`), `gatus` + `healthchecks` (`596f6b2`). What each move taught is
in `.claude/rules/nix-engine.md` §7; the decisions, so they are not
re-litigated:

- **The identity interface is the platform's.** `platform/registries.nix`
  ("shrinks to nothing") became `platform/identity.nix` and keeps
  `fleet.sso.*` + `fleet.ssoClients` for good: many readers, one
  implementation — the same split `publishing.nix` makes for `webApps`. A
  registry with one consumer (`fleet.appDatabases`) lives in that consumer.
- **`catalogModules` lists files, not stacks.** The module system merges a
  module's own `imports` ahead of everything at the level above it
  (measured), so a module that imported its siblings reordered the host's
  unit dependencies. Each file keeps its own slot, in the flake and in the
  host's list.
- **What other stacks contributed to a stack's rendered config is a
  registry.** The shipper's drop rules and file sources became
  `fleet.logDrops` and `fleet.logFiles`, each entry with its owner (the
  remote-control transcript drop rides `platform/claude-rc.nix`; zot's
  config dump, which prints the deploy hook's token, is dropped by the
  registry module). The registry's retirement list became
  `fleet.modules.registry.retireRepositories`; the build agent's npm mirror
  became `fleet.builder.npmMirrorHost`, contributed by the stack that runs
  the mirror.
- **Policy without a narrow default has no default.** `gatus.allowedSubjects`
  is required: without it the gate admits every account. Conventional
  labels (`id`, `status`, `hc`) are `mkDefault`s a host overrides on the
  webApp entry.
- **A host's secrets keep their basenames** under `host/sops/<id>/`: the
  basename is in the sops manifest's store path, so a directory per module
  is what keeps a move closure-neutral.
- **The generic dashboards template the NIC** (`@lanInterface@`); the two
  that name pools are the host's, through `fleet.grafanaDashboardsByFolder`.
- **The GPU box and the router's address are the site's** (`gpu-host.nix`,
  nullable; `fleet.gateway` from site.json, never
  `networking.defaultGateway`, which a DHCP host lacks).
- **Engine-shipped default pins: declined** (item 2 below). A pin in the
  engine could never be moved by the control plane's updater, and two
  sources of truth for one image would drift; the host keeps every pin, and
  Phase 12's `init` resolves the first set.
- **Tag versus clone (item 6): decided by what the input is for.** The
  reference box uses the local clone because its `app/` is a runtime
  dependency and its lock must be able to name a commit that only exists
  on the box; the template uses `github:santiagotoscanini/daedalus`, and
  `engine-update.sh` accepts either. A `?ref=v<tag>` pin is a host's choice
  and the same update path applies.

**What remains of Phase 11.**

1. **The other stacks, one by one**, none of them needed for a box to run:
   twenty-three in the reference host's configuration (media and its
   janitors, home automation, the AI cluster, VPN tenants, the
   books pair, a few tools). Seven leaves went first (`grocy`,
   `intel-gpu-exporter`, `metube`, `myspeed`, `verdaccio`, then `factorio`
   and `wg-easy` with their secrets; engine
   `f15f037` and after, with `checks.full-catalog` — the template host plus every
   leaf — as the proof, since the template itself stays the spine). Next:
   the media janitors (`recyclarr`, `scraparr`, `janitorr`, `cleanuparr`
   with the media family), the books pair (`calibre-web` + `shelfmark`),
   the database tenants, the AI cluster as one group, then the netns
   owners and their tenants together (`downloads`, `argus-vpn`, `tv`).
   Until they move, the reference host names the engine's modules one by
   one through `enginePath` (import order, §6) and adopts
   `nixosModules.default` afterwards in a deliberate, separately-gated
   rebuild.
2. ~~**Engine-default pins.**~~ — decided against 2026-09-22 (above).
3. ~~**`developer.engineOverride`**~~ — done 2026-09-21/22: the app half
   (`4d97cf6`) and the host half (`90e2cd4`: `host/lib.sh
   site_engine_override`, `apply.sh` builds and TESTS against the clone,
   `image-update.sh` refuses).
4. ~~**The schema fixtures**~~ — done 2026-09-21/22: `fixtures/site/v<N>/`
   and `fixtures/apps/v<N>/apps.json`, read by the app's
   `host/contract/fixtures.test.ts` and by `checks.fixtures`
   (`nix/tests/fixtures.nix`); the template's `site/site.json` is the
   current site fixture, byte-equal and asserted.
5. ~~**An "Update daedalus" button**~~ — done 2026-09-21/22: the eleventh
   bridge verb (`engine-request.json` → `daedalus-engine-update` →
   `engine-status.json`), `stacks/daedalus/engine-update.nix` +
   `host/engine-update.sh`, the Engine card on System › Updates,
   `POST /api/engine-update`. Refuses an override, a dirty lock and a
   diverged clone; fast-forwards, re-resolves, builds, commits the lock,
   switches, verifies the control plane through the proxy, reverts on
   failure, pushes. The repo snapshot publishes the lock's `daedalus` node
   (schema 6). Not yet exercised end to end on the box.
6. ~~**Tag-pinning**~~ — decided 2026-09-22 (above).
7. ~~**`templates.config`**~~ — done 2026-09-22 (`113648f`): the host the
   checks evaluate is the host a stranger starts from. The reshape of the
   reference host's own tree (`host/`, `docs/`) is that repository's
   business and rides with item 1.

Gate for what remains, unchanged in spirit: every step is a
`nixos-rebuild build` whose closure difference is exactly the step's stated
intent; the engine's `nix flake check` is green; an Apply still writes only
under `site/`.

### Phase 12 — Onboarding, init, catalog, release (1–2 weeks)

Wizard over the Phases 3–8 pieces (each step re-runnable from Settings);
`packages.init` (`nix run github:santiagotoscanini/daedalus#init`: asks
hostname + admin user, writes the CONFIG flake from `templates.config`, runs
`nixos-generate-config`, creates `site/` in the config with `.sops.yaml` from
the host key, rebuilds, prints the LAN URL + setup token); pi-hole DHCP
default off in the template; every catalog module gets manifest + schema +
docs + a `healthPath` whose absence is a 5xx; docs site; `v0.1.0` tag; this
box pins it. Rehearsal: a throwaway VM or spare machine goes from NixOS
minimal to a published app using only `init`, the UI and the documented
external steps.

---

## Features

What the product is missing regardless of phase. Grouped by kind, not
priority; each can be done independently unless noted.

1. **Preview deployments — a URL per branch, for vibecoding, testing and
   play.** Push a branch of plutus and a minute later
   `plutus-<branch>.toscanini.me` is running that commit; push again and it
   updates in place; delete the branch (or close the PR) and it is gone.
   Main-only builds today; the seams are in place (`builds.lane`,
   `prNumber`, `candidate` publish mode, `pull_requests:write` granted). The
   four-stage design (P1 checks → P2 required check → P3 previews → P4 fork
   policy) is in `~/.claude/plans/piped-gathering-meerkat.md`; what follows
   are the decisions that plan left open.
   - **Hostname keyed by branch, not by sha.** `plutus-<branch>.<d>` is one
     label (the wildcard certificate matches one label only), stays stable
     across pushes so bookmarks and the derived Pocket ID client's redirect
     URI survive, and the deployed sha is shown on the preview's card and in
     the GitHub Deployment. A sha-keyed name (`plutus-a1b2c3d`) would mint a
     new hostname, DNS record, tunnel route and OIDC client on every push.
     Optional later: "pin this build" keeps a `plutus-<sha7>` alive beside
     the branch preview for comparing two revisions.
   - **Runtime-managed, not nix-declared.** Previews come and go too often
     for a rebuild each: a `daedalus-preview@` template unit, a writable
     traefik file-provider directory (one router per preview, behind the
     same forward-auth), pi-hole records through its API. `lab` by default
     (LAN/VPN only); a per-preview switch to `live` publishes it through the
     tunnel for showing someone.
   - **Database: a fresh copy, never production.** Each preview gets its own
     database and role (`plutus_<branch>`), created from the **latest
     logical dump of production** (the backups feature) so it has real data
     to play with, then the branch's own migrations run forward on the copy
     via the app's `start.mjs`. Empty + `db:seed` when the app declares it or
     the operator asks. Production is never read live and never written.
   - **Migrations are the hard part, so make them visible.** The build page
     for a branch shows the migration delta against main ("adds 0004_x,
     0005_y"); the preview's first boot applies them to the copied data,
     which is the earliest possible signal that a migration breaks on real
     rows. Rule for merging: migrations must be **expand/contract** —
     additive on the way in, cleanup in a later commit — because production
     deploys are deploy-and-report with no schema rollback, and a
     revert-to-previous-image after a failed health check would run the old
     code against the new schema. The check run says so when a migration
     drops or renames.
   - **Secrets: a preview env group.** Previews never see production
     credentials: `DATABASE_URL` points at the copy, `AUTH_SECRET` is fresh,
     everything else comes from a per-app `previewEnv` allowlist (LiteLLM
     keys, map tokens) that the operator fills once. P4: fork PRs are held
     until an operator approves that exact head sha.
   - **Lifecycle:** created on the first push to a branch of an app with
     previews enabled (or on PR open, per app setting), redeployed on push,
     destroyed on branch delete / PR close, after 7 idle days, or by LRU
     beyond a box-wide cap. GitHub gets a Deployment with
     `environment: plutus-<branch>`, `transient_environment: true`, and a
     PR comment with the link edited in place. The preview list lives on the
     app's page with sha, age, database size, and Destroy.
   - **Pairs with feature flags (item 8):** a half-built feature can merge
     to main behind a flag that is on in previews and off in production,
     which is what makes trunk-based work with one box and no staging.

2. **Post-deploy checks for all apps.** Only anansi (26 probes) and voyra
   (15 probes) have post-deploy assertion drivers in
   `stacks/shotter/assets/checks/`. The remaining five apps (iris, hermes,
   plutus, chismed, argus) have no automated post-deploy verification
   beyond the deploy script's HTTP status check.

3. **argus e2e suite.** Needs a seeded database; deliberately excluded from
   the post-deploy checks because its e2e writes to the database and its
   other two checks compare a PR to a base branch.

4. **Self-hosted Gitea with two-way GitHub mirroring.** A Gitea instance on
   the box that mirrors every project repo to and from GitHub
   (https://docs.gitea.com/usage/repository/repo-mirror/). When GitHub is
   down the operator can still push, review, and merge — and Gitea runs CI
   on its own, so builds and checks keep working during an outage. The
   mirror is two-way: pushes land on both sides once connectivity returns.
   Implementation: a new `stacks/gitea` module, Gitea's built-in mirror
   feature pointed at each GitHub repo, and Gitea's Actions runner for CI
   (reuses the box's existing BuildKit and Railpack tooling where possible).

5. **Dev mode toggle for the engine.** Today `source.mode = "local"` is a
   nix constant — switching between the dev server (bind-mount + `vite dev`,
   for working on the app) and the real production image requires editing
   `daedalus.nix` and rebuilding. Daedalus should expose this as a toggle
   in Settings > Developer: flip to dev mode when working on the engine,
   flip back to the built image when done. The toggle writes to
   `site.json` (so it survives a reboot but is easy to revert), and the
   rebuild happens through the existing Apply path. Prerequisite: Phase
   10b (the production build must exist before there is something to
   toggle to).

6. **Windows agent for the GPU box.** A Rust service on the gaming PC (the
   Lemonade model server), designed 2026-09-22 around the one problem the
   box has today: the machine goes to sleep after a few days and takes
   every AI workload with it. Phase one is two jobs, and small on purpose.
   - **Keep awake, unconditionally.** A Windows service running as SYSTEM
     that creates a power request (`PowerCreateRequest` +
     `PowerSetRequest(PowerRequestSystemRequired)`) at start and holds it
     for its lifetime — visible in `powercfg /requests` with a reason
     string. On every start it also converges the power plan
     (`standby-timeout-ac 0`, `hibernate-timeout-ac 0`, hibernate off) as
     a second line of defence. No idle policy, no display hold, no
     listening port. Starts at boot before login, restarts on failure.
     Sleep-on-purpose from the UI is a later exception, not the rule. A
     power request does NOT stop a Windows Update restart; if
     `Get-WinEvent` (Kernel-Power 42/41/109) shows that is what has been
     happening, the fix is the update policy, and the agent only reports.
   - **Prove it is awake.** A heartbeat every minute over an outbound
     WebSocket to `/api/agent/ws` on the box — an auth-bypass path with
     its own bearer token, the deploy hook's pattern — carrying version,
     uptime and the hold state. daedalus shows "held awake by agent vX
     since …"; five missed heartbeats raise the alert nothing raises
     today: the machine slept or the service died. That is phase one's
     whole telemetry.
   - **Update itself.** The agent version is a pin in `site.json` beside
     the image pins, moved from System › Updates with its changelog like
     everything else. The agent reads the pin on each heartbeat, downloads
     the release asset from GitHub, verifies an ed25519 signature against
     a key compiled into the binary, renames the running exe aside, moves
     the new one in and restarts the service. A failed verification or an
     unreachable daedalus leaves the current version running; rollback is
     moving the pin back. Ships in phase one because it is the one thing
     that cannot be added later without a walk to the machine.
   - **Install once.** One PowerShell line shown in the UI, carrying a
     fifteen-minute enrollment token: installs the service, writes the
     box's address to ProgramData, exchanges the token for a long-lived
     agent token stored DPAPI-encrypted, reports hostname and MAC, starts.
   - **Repo and release.** `agent/` in this monorepo (its protocol is
     coupled to daedalus's API), tag `agent-v*`, a workflow on a Windows
     runner building the MSVC target and publishing the asset plus its
     signature. Crates: `windows`, `windows-service`, `tokio`,
     `tokio-tungstenite`, `serde`, `ed25519-dalek`.
   - **Later phases, in order.** (2) Telemetry: a `/metrics` listener
     firewalled to the box, read by Prometheus alongside Lemonade's own
     `/metrics` (live and unscraped today) — GPU load and VRAM from
     Windows performance counters first, AMD temps and power via ADLX
     after; nix generalizes `fleet.gpuHost{,Ip}` into
     `fleet.remoteMachines.<name>` (host, ip, mac, ports) that litellm,
     gatus, lemonade-logs and the dashboards read; a `System › Machines`
     tab. (3) Power buttons: hold with a duration, release, restart, shut
     down, and wake by magic packet from the box — with the sleep-aware
     alert (`up == 0` unless daedalus expects it asleep). (4) Lemonade
     supervision and updates through a session helper launched into the
     logged-on desktop with the user's token, because the tray app runs
     there today and whether ROCm works from session 0 is untested.

7. **Git commit attribution from the signed-in user.** Today every
   `site/` commit is authored by "daedalus" regardless of who pressed
   Apply. The forward-auth headers carry the operator's email (and could
   carry a display name via `preferred_username`). Pass the identity
   through the bridge request and use `--author="Name <email>"` in the
   git commit, so GitHub shows "Santiago Toscanini authored and daedalus
   committed" instead of "daedalus committed".

8. **Feature flags via a self-hosted service, wired per app.** Run
    **Flipt** as a stack (single Go binary; its flags can be **declarative
    from a file or a git repo**, so the flag definitions live in the config
    repo like everything else; OpenFeature-compatible SDKs for Node; UI
    behind Pocket ID via `webApps`; storage on the shared cluster through
    `fleet.appDatabases.flipt`). daedalus does not reimplement flags; it
    wires them: a `fleet.flagClients.<app>` in the spirit of
    `fleet.litellmKeys` gives each app a namespace and injects `FLIPT_URL`
    + a client token into its env, and the preview runtime sets the
    evaluation context (`environment: preview|production`, `branch`) so a
    flag can be on in every preview and off in production. The app page
    shows the app's flags with a link into Flipt's UI. Alternatives
    considered: Unleash (heavier, own schema, fine if the UI matters more
    than file-backed flags), Flagsmith and GrowthBook (heavier still, Mongo
    for the latter), PostHog (a product-analytics suite, far more than
    needed). Simple, professional, and the missing half of trunk-based
    development with one box and no staging.

9. **App variables and secrets: convert, rotate, scope.** An app's
   environment is two lists: **variables** — plain text in `apps.json`
   `env`, committed in clear, diffed in the Apply preview — and
   **secrets** — write-only, one sops file per app under `site/vault/apps/`,
   set and removed one key at a time through the bridge with a host-side
   merge and shown as "set <date> by <actor>" from git. The rule the
   container's identity forces still governs every addition here: it has an
   encrypt-only sops identity and no decryption key, so it can never
   display a value or re-emit a file — it can only hand the host a new value
   for one key. What the editor still lacks:
   - **Convert to secret.** The value moves from `apps.json` into the sops
     file in one Apply; the old plaintext remains in git history, and the
     UI says so rather than pretending otherwise. **Convert to variable**
     stays deliberately absent — a secret cannot be read back, only removed
     and re-created as a variable by typing it.
   - **Rotate the machine-generated ones.** `AUTH_SECRET` and the app's
     database password are "delete the file + rebuild" today (CLAUDE.md,
     Secrets); a Rotate button per app is one more bridge verb doing exactly
     that, with a confirm. Like `secret-set`, the new verb joins the
     `redact` fixtures and the secrets-grep drill before it ships.
   - **The runtime/build-time flag and the preview scope.** Both kinds carry
     a runtime/build-time flag, so a real build-time secret goes to the
     build agent as a BuildKit secret rather than a placeholder, and a
     preview-scope switch — the preview env group is the same list scoped
     to previews. Both wait on item 1.

10. **The app contract as packages, published to the box's own Verdaccio.**
    daedalus defines a contract with its apps — which env names are
    injected, what `/api/healthz` answers, how migrations run at start, how
    auth works, where flags come from — and today every app re-implements
    it by hand: six different `start.mjs` (four of them the same
    migrations-fallback shape), the same `check:bundle` grep pasted into
    five `package.json`s, a 100–250-line `env.ts` per app validating mostly
    the same names, and a copy of iris's hybrid auth (`@auth/core` against
    Pocket ID + bcrypt local login + invite codes) in every app that has
    users. Publish the contract as small `@daedalus/*` packages instead;
    Verdaccio already allows scoped publishes from authenticated users, so
    nothing on the box changes. Ranked by duplicated lines removed:
    - **`@daedalus/auth`** — the hybrid auth as a package: the Pocket ID
      OIDC provider config, session, invite gating, the `Actor` type; plus a
      **proxy mode** that trusts the forward-auth headers when the app runs
      behind `auth = "oidc"` and fails closed when they are absent, so an app
      without per-user records can drop its own login entirely. One place to
      fix a security bug instead of seven.
    - **`daedalus-start`** (a bin) — replaces every `start.mjs`: find the
      migrations dir by `meta/_journal.json`, run drizzle's migrator, refuse
      to boot if none is found, then start. The silent-migration-skip trap
      the cutover found becomes impossible to reintroduce.
    - **`@daedalus/env`** — a typed schema of the platform-injected names
      (`DATABASE_URL`, `AUTH_SECRET`, `PORT`, `HOST`, `LITELLM_*`, `FLIPT_*`,
      `DAEDALUS_ENV=preview|production`); each app's `env.ts` shrinks to its
      own extras, and a renamed platform variable fails in one place.
    - **`@daedalus/health`** — the `/api/healthz` handler: DB ping, revision,
      uptime; the shape gatus and `deploy.sh` already expect.
    - **`@daedalus/flags`** — OpenFeature + the Flipt provider with the
      evaluation context set from env; item 8 becomes one import per app.
    - **`@daedalus/log`** — structured stdout in the shape Alloy's
      level-inference expects (podman's journald priority is a lie), with the
      redaction rules; Loki levels become right for every app at once.
    - **`@daedalus/ai`** — the LiteLLM client with gateway/key/model from env
      and the thinking-model `max_tokens` gotcha baked in.
    - **`daedalus-check-bundle`** (a bin) — the leak grep, versioned once.
    - **Shared configs** — `@daedalus/tsconfig`, `@daedalus/biome-config`,
      the `.prettierignore` entries for `.output`/`routeTree.gen.ts` that
      cost the chismed cutover a commit.

    **Mechanism:** a `libs/` workspace (in the engine repo, or its own
    `daedalus-libs` repo), each package small enough to read in one sitting
    with its own tests; a third build strategy beside `railpack` and
    `dockerfile` — **`publish`** — so a push runs the checks and `pnpm
    publish` to Verdaccio through the same webhook, queue, token-revoke and
    check-run path as an image build. Versions via changesets; apps pin
    exact versions; the app page shows "auth 1.3.0 (latest 1.4.0)" from the
    lockfile the build already reads — bumping stays a commit in the app
    repo (daedalus has `contents:read`; Renovate is a standing no). The
    genuinely generic ones (`auth`, `health`, `log`) should also be
    publishable to npmjs under a public scope with Verdaccio as the cache,
    because Verdaccio is LAN/VPN-only and GitHub-hosted CI cannot reach it.
    **Not this:** a UI kit — the apps' designs are deliberately different.

11. **Self-hosted GitHub Actions runners, managed from daedalus.** The old
    runner stack was deleted because it was the deploy path; runners are
    still worth having for everything else — the free plan gives a fixed
    number of minutes for private repos, and heavy CI (browser e2e, argus's
    seeded-database suite from item 3, release builds) burns through it.
    Bring runners back as a daedalus feature with a firm policy: **runners
    run CI, never fleet images** — the box's build path stays the only way
    an image reaches zot.
    - **Ephemeral, on demand, per job.** Subscribe to `workflow_job`; on
      `queued` with a matching label, mint a JIT runner config and start one
      rootless podman container (`--ephemeral`, dedicated uid, resource
      limits, the same owner-match egress fence the builder uses, no
      secrets beyond the single-use JIT token); it takes exactly that job and
      exits; `completed` records the usage. No idle runners, no long-lived
      registration, nothing to leak between jobs. A configurable cap on
      concurrent runners, and a queue view when the cap is hit.
    - **A second, narrow GitHub App.** Registering a runner needs
      `administration:write` on the repository (verify against the current
      API doc) — far broader than the build App's `contents:read`, so it
      gets its own App (`daedalus-runners`) installed only on repos that
      opt in, created through the same manifest flow and sealed in the same
      vault. Attaching a repo = installing that App on it; the panel lists
      installed repos and their label sets.
    - **The panel:** runners now (idle / busy / starting), jobs queued and
      running with links to GitHub, per-repo **minutes this month** against
      the plan's allowance (so the saving is visible), history, failures
      (a runner that never picked up its job, a job killed by the cap).
      Metrics through `fleet.prometheusScrapes` — `runners_busy`,
      `jobs_queued`, `job_minutes_total{repo}` — so Grafana and the
      existing alerting see them; runner logs through the journal to Loki.
    - **Later:** a Windows runner on the gaming PC through the companion
      agent (item 6) for Windows builds; a `gpu` label for jobs that want
      the model server. macOS stays on GitHub (santree's signed releases).

---

## Operator decisions still open

1. ~~Production runtime for the engine~~ — decided by evidence on 2026-09-21:
   the built server works (Phase 10b). This box stays in dev mode through
   the flag; everyone else gets the image.

2. **`~/.claude/projects` transcript pruning.** These transcripts can contain
   secrets a session read. The claude-rc journal keeps its own copy ≤1 month
   (root-only). Open question: exclude or prune them from ZFS
   snapshots/backups.

3. **License for the engine.** No `LICENSE` file exists in the engine repo
   yet. MIT or Apache-2.0; default MIT. Needed before Phase 12's `v0.1.0`.

## Owed to the operator

Hand edits the UI cannot make for itself:

1. **The MCP server's credentials — opt-in, not owed.** Decided 2026-09-21: the
   server is built and reachable at `/mcp`, and nothing calls it until the
   operator wants a Claude session driving daedalus through it. Then three
   edits: mint a write token in
   Settings › Developer (it is shown once); add a `daedalus` entry to
   `.claude/mcp.json.sops` in `/etc/nixos` carrying that token as a bearer
   header; add `"daedalus"` to `enabledMcpjsonServers` in
   `.claude/settings.json`. The last two live in the config repo, so the
   usual `git add` and rebuild apply — `platform/claude.nix` renders the
   `.mcp.json` symlink at activation.
2. ~~**Arming the admins gate**~~ — armed 2026-09-22 on the reference host
   (`auth.enforceAdmins` is on; every mutation now requires `admins`).
3. ~~**Re-enter the off-box projects**~~ — done 2026-09-22: the four rows
   (santree, santree-cli, the daedalus landing page, the portfolio) that
   lived only in the engine's source as a seed are settings now
   (Settings › Projects), entered by hand on the
   reference host.
4. **The first tag** (Phase 10b, item 4) and **the license** (open
   decision 3) — one act, when the operator chooses: bump
   `app/package.json`, add `LICENSE`, tag `v<version>`, push the tag;
   `image.yml` publishes the image to ghcr, private until its visibility is
   changed by hand. From then on a host not in dev mode runs
   `fleet.daedalus.image` as the engine defaults it.
5. ~~**Try Update daedalus once from the page**~~ — ran end to end on
   2026-09-22 (f69a42f → c7c6bc6, 32 s, lock committed and pushed, the
   control plane came back).

## Engine polish

TypeScript, identified but not acted on:

- Audit for places where `as` casts hide real type narrowing opportunities.
- `satisfies` where appropriate (config objects, exhaustive checks).
- `noUncheckedIndexedAccess` — would catch record-access bugs at the cost of
  `!` on every array index; assess whether the codebase is ready.
- Template literal types for the bridge verb strings (type-safe file names).
- Branded types for app names, sha hashes, build ids (prevent mixing
  `string` values that mean different things).
- `using` declarations (TC39 explicit resource management) for locks and
  cleanup — TanStack Start's Vite plugin may not support this yet.
- `exactOptionalPropertyTypes` — assess viability.
- Review whether `isolatedDeclarations` and `verbatimModuleSyntax` are worth
  enabling.

Small items:

- The repo picker consolidation: `lib/github-repos.ts` has its own `token()`
  that would degrade to public repos if the `gh` CLI token ever went — the
  App installation token should be the only source.
- The engine logs nothing when it re-adopts a running build after a restart.
- The webhook log line omits the superseded count.
- Build-page live log during long checks may appear empty (markers arrive at
  stage boundaries, not mid-stage).
- `polish-walk.mjs` driver in `<stateRoot>/shotter/drivers/` has a stale
  "Runner" heuristic that false-flags 2 pages — verification tooling belongs
  in the repo, not app state.

## Documentation

What exists: `ARCHITECTURE.md` (5 Mermaid diagrams), `BUILDS.md` (the build
lifecycle), `CONTRIBUTING.md` (tested from a fresh clone). Missing:

- **Website docs rendering.** The decision was "ARCHITECTURE.md as source of
  truth + website renders a curated subset." The website half is not done —
  Mermaid rendering on the static site was investigated and deferred (the
  diagrams live as code blocks in the repo; the site would need a build-time
  Mermaid→SVG pass or a client-side renderer).
- **Bridge API reference.** The file-drop request shapes (apply, build,
  cancel, site-write, secret-apply, secret-set, workspace-clone,
  deploy-trigger, image-update, export-publish, task-run, claude-resume)
  have no standalone doc beyond the code and `apply.sh`'s subject cases.
- **Operational runbook** for the build pipeline beyond what BUILDS.md
  covers — what to do when a build hangs, how to force-rebuild, how to read
  the build log, how to cancel.
- `website/src/routes/docs.tsx` is ~90% s2-server operator knowledge
  published from the engine, and its "in-repo runbook" links 404 (they point
  at `docs/*.md` in a repo that has none). Rewrite for a stranger's box or
  cut.

## Verification owed (cross-cutting)

- A `just census` target: `podman ps` census, `systemctl --failed`, every
  `healthPath` curl, and a `diff-closures` helper.
- ~~A nightly `git bundle` of the config repo~~ — `platform/config-bundle.nix`
  (config `42a5dae`): a verified `--all` bundle into the snapshotted state
  tree at 03:47.
- Contract tests: `apps.json`/`site.json` fixtures per schema version parse
  in nix (`nix eval`) and in the app (vitest); migrations fixture-driven.
- The no-secret-in-logs test: no vault value or bridge secret appears in
  status files, build logs or the app's stdout (confirm one exists; add it
  to CI if not).
- Standing practice: closure diffs and the census after every nix phase;
  container truth, not unit state; `shot run` drivers with `events.json`
  read before pictures; an authz test beside every new mutation, and the
  suite re-run the day the gate is armed.

## Registry and disk

- `REGISTRY_CI_USER`/`REGISTRY_CI_PASSWORD` still sit unused in
  `stacks/registry/env.sops` — strip them on the next sops edit (the `ci`
  htpasswd user is gone; these are dead keys).
- zot was at 33 GB and falling after retention was enabled; monitor.

## Security residuals (from the adversarial reviews)

Known and accepted, not forgotten:

- The deploy hook's token appears in zot's own startup log line (it prints
  its configuration at INFO with only the OIDC secret masked). Dropped from
  Loki by `fleet.logDrops.zot-config-dump` (2026-09-22); the journal itself
  still holds the line for its retention window, readable by root and the
  `systemd-journal` group. Rotating the token is `sops host/sops/registry/env.sops`.
- The router's retail name was a literal in the public engine for three
  commits (2026-09-21); it is an option now. Low sensitivity; rewriting
  published history is the operator's call.
- A build step that escapes its sandbox lands as `buildkit` — the daemon
  user, which can see the zot push credential the buildctl session passes.
  Mitigations: rootless user namespace, the egress fence, `builder` has no
  delete permission.
- A repo's own mise cache can carry files into its next `railpack prepare`
  (per-build cache copy or a throwaway uid are the candidates).
- A hostile base image's ONBUILD cache mounts are invisible to the scan (all
  seven apps are Railpack now, so this is theoretical).
- Repo rename should be carried by id, not name (the clone and three GitHub
  hyperlinks still resolve by name).
- Dataset mount failure alert is silent — `daedalus-builds-mounted` checks
  hourly and mails, but the mount itself is `nofail`.
- `stacks/home-assistant/assets/configuration.yaml` keeps a home address in
  cleartext "because the repo is private" — that reasoning already failed
  once (the repo was public for a month). Move it to a secret.

---

## Not in v1

Out-of-tree modules; multiple domains or non-wildcard certs; alternative
proxy/IdP/DNS; ISO installer and nixos-anywhere; third-party app stores;
Cloudflare Access; Cloudflare account/Zero Trust org creation (no public API);
Registrar API (beta); generated-secrets-as-sops (Clan-vars style) — later;
`fetchPnpmDeps` nix package as an alternative to the image; non-flake configs.
And, decided after evaluating Coolify (2026-09-15): no second container
engine, no control plane whose state lives outside git, no one-container-per-
database model — the features worth having from that comparison are items 1,
8 and 9 above.

## Risks

- TanStack Start is still "RC" by its own docs; pin exact versions. Its build
  is stricter than its dev server: a client file that reaches
  `@tanstack/react-start/server` through any import is refused at build and
  never in dev, so `pnpm build` belongs in the check every change runs.
- Two-commit Apply (site commit + lock commit, from Phase 11): a crash
  between them leaves the lock behind the site; `apply.sh` reconciles on the
  next run and Settings shows "site ahead of lock".
- Phase 9b touches app-db (the pg cascade) — alone, off-hours.
- Cloudflare: locally-managed tunnels sidestep the `PUT …/configurations`
  api-token issue; keep them. GitHub: the box authenticates as its own App's
  installation, so the repo picker lists exactly the repositories the App
  was granted; `GITHUB_REPO_TOKEN` is the one override, for listing a
  repository the App has not been given yet.
- Non-flake (channel-based) configs cannot import the engine in v1; `init`
  always writes a flake.
- Previews (feature 1) run branch code with a copy of production data on the
  same box: the preview env allowlist and the fork-approval gate are what
  keep that safe, and both must exist before previews are on by default.
- `--init` is not a default in `mkRootlessContainer`. Found while diagnosing
  why `mcp-yazio` died weekly: node as PID 1 never reaps orphaned
  grandchildren, so every session leaked one pid until the container's 2048
  ceiling. Fixed for yazio alone. `app-plutus` has the identical bug (35
  chromium zombies, months from its ceiling), and any node-as-PID-1
  container that spawns processes will. The general fix is one line touching
  all 68 containers — left as the operator's call, not a drive-by.
  Update 2026-09-21: the apps platform got it (`stacks/apps`, config
  `42a5dae`) — eight containers we build, all node as PID 1. The default for
  the other sixty is still the operator's call.
- The weekly `flake.lock` bump can move nixfmt and leave `/etc/nixos`
  treefmt-dirty, which fails `nix flake check` — Phase 11's gate. It was
  cleared on 2026-09-20 (`70a299b`, empty closure diff as proof), and will
  recur; check after every autoupgrade. `nix fmt -- --ci` writes before it
  fails; it is not a read-only check, so run it on a tree you mean to commit.
- **The autoupgrade commits the lock BEFORE it builds.** On 2026-09-21 it
  pulled a sops-nix whose `go.mod` had moved to Go 1.26, failed to build it
  against 25.11's Go 1.25, and exited with HEAD unbuildable — every
  `nixos-rebuild` on the box would have failed until someone noticed. Fixed
  in `platform/sops.nix` by overriding the package's Go inputs to the 1.26
  toolchain stable ships (config `7cb0aa2`; drop at 26.05). The script's
  order was the real defect, fixed in config `666e9d6`: it now updates, builds,
  and only then commits and stages, restoring the old lock on a failed build. The engine's own autoupgrade (Phase 11, "Update
  daedalus") must be written build-first from the start.
