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

## Where things stand (2026-09-21)

Phases 1–9 of the productization plan have landed, and the first half of 10:
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
no longer reaching into other stacks at eval time (9c, `046b3ff`).

| Phase | What | State |
|---|---|---|
| 8 | Auth hardening | built; arming is the operator's hand (see "Owed to the operator") |
| 9 | Nix: enable surface, literals, state out of the tree | landed 2026-09-20/21; residue (asset literals, missing options) listed in the section |
| 10 | App module system and a real build | 10a landed 2026-09-21 (`a6a87ce`); 10b (the build) not started |
| 11 | The engine becomes importable | not started |
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

What 9b did NOT reach, and Phase 11 will trip over:

- **Literals inside assets.** Host scripts and config files the modules
  render still spell the user, uid, home and hostname: `stacks/daedalus/host/
  {env-snapshot,image-snapshot,image-freshness,system-snapshot,apply,
  image-update}.sh`, `stacks/apps/assets/deploy.sh`, `stacks/app-db/assets/
  {bootstrap.sh,traefik-tcp.yml}`, `stacks/pocket-id/assets/client-secrets.sh`,
  `stacks/litellm/assets/{virtual-keys.sh,config.yaml}`, `stacks/registry/
  assets/config.json`, `stacks/verdaccio/assets/config.yaml`,
  `platform/autoupgrade/assets/autoupgrade.sh`, the two shot check drivers,
  and `"s2-server"` in seven Grafana dashboards. The fix is the one the
  scripts already use for some values: pass them as environment from nix.
- **No option exists yet for:** the pool mountpoints (`/s2/...`, in eight
  stacks), the GPU box (`192.168.0.120`, `gaming-pc.local`), the LAN subnet
  (fail2ban), the ACME contact address, the operator's git identity
  (`platform/git`), `github.expectedOwnerId`, the rebuild lock's name.
- **Files that are host data, not engine:** `platform/zfs.nix` and
  `platform/backup.nix` name this box's pools and per-person datasets;
  `platform/claude.nix` reaches `../.claude/`. They need a split before the
  move, not a substitution.

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
  the `drizzle-orm` migrator), and production dependencies. Site identity
  comes from `/site` at runtime. CI on GitHub-hosted runners → ghcr by
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

  **The known blocker** (operator decision 1 below): TanStack Start's build
  output (Nitro is its internal server layer) emitted a fetch handler with no
  `.listen()`, and server-function ids differed between dev (path-derived)
  and build (sha256). Prove the built handler on a current TanStack Start
  first; the id issue may be fixed upstream.

Compatibility: 10a is a refactor with tests (module registry tests, the
existing suite, fixture-driven loader tests that survive a null upstream);
10b is gated by `vite build` producing a working server.

### Phase 11 — The engine becomes importable (2–3 days for the move; then one stack at a time)

One mechanical big-bang with a hard gate, then a gradual migration. First:
`platform/` + `stacks/daedalus/{daedalus.nix,host,assets}` move into the
engine as `nix/`; the engine exports `nixosModules.default`; `/etc/nixos`
imports it as a `git+file:` input pinned in `flake.lock`. Gate: the closure is
IDENTICAL. Then the stacks migrate ONE BY ONE into `nix/modules/<id>` behind
`fleet.modules.<id>.enable`, each its own small rebuild that leaves the box
working. From the big-bang on, an engine-side nix change costs one `nix flake
update daedalus` in the config; the `/rebuild` skill does it when the engine's
HEAD moved.

1. Reshape the engine with `git mv` into `nix/`, `app/`, `host/`, `website/`,
   `docs/`; `flake.nix` exports `nixosModules.default`, `lib`,
   `templates.config`; `nix flake check` passes with no site present (Phase
   9's gating makes this possible).
2. `/etc/nixos` shrinks to the CONFIG shape: `flake.nix` (input `daedalus` by
   tag, nixpkgs following daedalus), `configuration.nix` importing
   `daedalus.nixosModules.default` with `fleet.site.source = ./site`,
   `hardware-configuration.nix`, `host.nix` (hostname, hostId, static IP, zfs
   pools, the hand-managed CNAME notes), `.claude/`, `HARDWARE.md`,
   `lemonade.md`, `AUTH.md`, `FUTURE.md`. Everything else comes from the
   engine input. `site/` does not move. `fleet.imagePins` (site override map,
   engine defaults via `mkDefault`) replaces `image-update.sh`'s `.nix`
   rewriting.
3. `developer.engineOverride` in `site.json` makes the agents pass
   `--override-input daedalus git+file:///home/santiago/projects/daedalus` +
   `--no-write-lock-file` so engine work is testable before a tag.
4. CLAUDE.md Rule 1, the skills (`/rebuild`, `/add-stack`,
   `/update-images`), `.claude/settings.json` allow list and `bash-guard.sh`
   are rewritten for the two-piece loop (`site/` via the UI, everything else
   in `/etc/nixos` by hand, engine work in `~/projects/daedalus`).
5. `nix flake check` and the schema fixtures join the engine's `ci.yml` (the
   engine's CI runs on GitHub-hosted runners, never the box's own, so it
   answers while the box is down).

Gate (the only hard one): `nixos-rebuild build --flake /etc/nixos` with the
engine pinned to its first tag produces a closure identical to the running
system; the engine's `nix flake check` is green; an Apply still writes only
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

6. **Windows companion agent for remote machines.** A lightweight agent
   installed on the gaming PC (the Lemonade model server) that reports
   hardware telemetry daedalus cannot see today: GPU utilization and
   temperature, CPU usage, RAM, BIOS/firmware version, disk health, and
   whether the machine is awake. It also accepts commands from daedalus:
   keep the display/machine awake (suppress sleep), restart, and
   shutdown — so the operator can manage the AI workload machine from the
   daedalus UI without walking to it or opening RDP. Windows-only for
   now; a Linux agent is a future expansion.
   - **Telemetry:** Prometheus-compatible `/metrics` endpoint (or a push
     to the box's Prometheus via remote-write) exposing GPU load/temp/VRAM
     (NVML or WMI), CPU per-core usage, RAM, disk SMART, BIOS version,
     uptime, and sleep/wake state.
   - **Commands:** a small authenticated API (or a polling model where the
     agent checks daedalus for pending commands) for wake-lock, restart,
     shutdown, and cancel-wake-lock.
   - **UI:** a new page or section in daedalus showing the remote
     machine's live metrics, hardware summary, and the power buttons.
   - **Packaging:** a single `.exe` or MSI installer; runs as a Windows
     service; auto-updates from a GitHub release (the engine repo or its
     own repo). Written in Go or Rust for a single static binary with no
     runtime dependency.

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

1. **Production runtime for the engine.** The engine runs in dev mode
   (`source.mode = "local"`, Vite dev server). A production build was
   attempted but TanStack Start's build output (which uses Nitro internally
   as its server layer) emitted a fetch handler with zero `.listen()` calls,
   and server-function IDs changed between dev and build (path-derived vs
   sha256 — moving a file broke every call). Proposal: prove the built
   handler against a throwaway Postgres on a current TanStack Start version
   (the ID issue may be fixed upstream). **Why it matters:** dev mode is fine
   for one user, but HMR noise, no tree-shaking, slower cold starts.
   Unrelated to the other seven apps — they each have their own `start.mjs`
   and build fine through Railpack. This is Phase 10b's gate.

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
2. **Arming the admins gate** — Phase 8, item 1, in the order given there.

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
- A nightly `git bundle` of the config repo into `${fleet.stateRoot}`
  (`/etc/nixos` is not snapshotted; the GitHub remote is the only other copy).
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
  output is Phase 10b's known blocker (decision 1).
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
