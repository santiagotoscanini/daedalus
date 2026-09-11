# Daedalus productization — the migration plan

The incremental plan for turning the box's dashboard into a product: a public
engine that any NixOS machine imports, configured from its own UI. Written
2026-09-08 as draft v3, executed phase by phase since; each phase carries an
**Outcome** paragraph once it lands, and the table below is the index.

## Status (2026-09-11)

| Phase | What | State |
|---|---|---|
| 1 | Tailwind v4 + shadcn foundation | landed 2026-09-08 |
| 2 | Settings page, read-only | landed 2026-09-09 (s2-server `4d83fc1`) |
| 3b | Repository split: private s2-server config, public daedalus engine | landed 2026-09-10 (s2-server `ff17fb1`) |
| 3 | `site/` directory in the config repo, written from the UI | landed 2026-09-10 (s2-server `8f77a00`, engine `870493b`) |
| 4 | Nix reads the app registry from `site/` | landed 2026-09-10 (s2-server `b09957f`, engine `4c64c81`) |
| 5 | `site.json` is the source of the site constants, editable | landed 2026-09-10 (s2-server `c6ad8d0`, engine `2aceab5`, `ac60f42`) |
| 6 | Secrets vault v1: the Cloudflare token | in progress (started 2026-09-11) |
| 7 | GitHub: device flow, HTTPS pushes, JIT runners | not started |
| 8 | Auth hardening | not started |
| 9 | Nix: enable surface, literals, state out of the tree | not started |
| 10 | App module system and build | not started |
| 11 | The engine becomes importable | not started |
| 12 | Onboarding, init, catalog, release | not started |

Open inside Phase 5: the Apply BUTTON has not been pressed from the UI. The
`chismed`/`voyra` drift that made every UI Apply carry an unwanted change is
gone: on 2026-09-11 the operator decided both stay public, and their draft
stage was put back to `live` through `saveApp`, so the apps table matches
`site/apps.json` again. The Apply of 2026-09-10 went through the bridge by
hand and ended `done / no-change`.

Cross-cutting items from §4 not yet done: the `just census` target, the
nightly `git bundle` of the config repo into the state root, the nix+app
contract tests over shared JSON fixtures. The no-secret-in-logs test arrives
with Phase 6.

Outside the plan, landed 2026-09-10 after the boot-time outage (s2-server
`5ccb538`, `6a5cc1d`, `ceb09f6`): `podman-rootless-ready` creates the
operator's rootless user namespace once before any container unit joins it;
the zot→daedalus deploy hook has its own traefik router with a rate limit;
pi-hole's per-client rate limit is raised; both GitHub tokens reach curl via
rendered `--config` files (re-rendered by `restartUnits` when the sops secret
changes) instead of `-H` arguments visible in `ps`. The curl-config renders
are the shape Phase 7 step 2 will reuse when the token becomes UI-managed.

Outside the plan, landed 2026-09-11:

- **One Cloudflare API token** (s2-server `0b8e0e1`, engine `398374b`). Three
  credentials had drifted — a DNS token copied into two env files, an account
  token Cloudflare no longer accepted (the tunnel panels had gone silently
  blank), and ddclient on the Global API Key. Now one token (Zone:Read,
  DNS:Edit, Account "Cloudflare One Connector: cloudflared" Read; all zones)
  lives only in `stacks/cloudflared/env.sops`; traefik, route-sync, ddclient
  and daedalus read it from there (s2-server `6966a4d` dropped the last
  alias). A refused Cloudflare read now says which permission is missing
  (`getJsonResult`, `cfReadError`). This shrinks Phase 6: the rotate-together
  set it was written against no longer exists.
- **Settings › Profile** (engine `f451143`, `c67cfe9`): the signed-in person's
  Pocket ID account, read and written through Pocket ID's admin API (the
  operator's choice of source); the account is resolved from forward-auth
  headers, including a new `X-Forwarded-User` = `sub`, which is also the
  first half of Phase 8's `actorOf(request)`. The rail's Settings row became
  an account menu (Profile, Settings, theme, passkeys, sign out).
- **The control plane's address is a site field** (s2-server `25e7c59`,
  engine `f451143`): `identity.controlPlane` under the domain, with
  `webApps.<n>.aliases` keeping the old name served until the operator
  confirms the new one from it. One of Phase 9b's literals, done early.

## What remains, in order

**Phase 6 — the first UI-managed secret** (revised 2026-09-11 for the single
token). The site directory gains `.sops.yaml` (the host and operator age
recipients) and `vault/cloudflare-api-token.sops`, a binary sops file
holding the raw token — `vault/`, not `secrets/`, because across the config
repo `secrets/` is the gitignored, permission-fenced home of machine-generated
plaintext, and this is ciphertext the flake must see. The container gets a
static sops (nixpkgs' build without cgo, bind-mounted; it holds no age
identity, so it can encrypt but never decrypt). Nix declares it and renders ONE `sops.template`,
`CF_DNS_API_TOKEN=<token>`, which is what all four consumers already read
(traefik's DNS-01, route-sync, ddclient's render, daedalus's render); each
consumer contributes its own unit to the template's `restartUnits`, and
`fleet.cloudflare.tokenEnvFile` is the one path they all take. One toggle,
`fleet.cloudflare.tokenFromSite` (default off), flips all four at once — they
are one token, so per-consumer toggles would only allow a split the box no
longer has. Settings › Integrations › Cloudflare gets "Replace token":
verify against the API (zones, the tunnel), encrypt in the container with
sops to the recipients in `/site/.sops.yaml`, hand the ciphertext to the
bridge as `vault/cloudflare-api-token.sops` in the Apply file map
(`apply.sh` gains a fixed allowlist entry and subdirectory writes), commit
and rebuild. Refused while other changes are pending, so a rotation is its
own Apply. Write-only and never logged (a test over status files and the
payload). Gate: flip the toggle, rotate from the UI, all four consumers pick
up the new value with no manual restart — `restartUnits` on the fleet's
oneshot container units is still the untested risk. Then delete
`stacks/cloudflared/env.sops`.

**Phase 7 — GitHub without classic PATs.** A daedalus OAuth App with device
flow; Settings › GitHub shows the code, polls, checks scopes and stores the
token via the Phase 6 path, with a pasted fine-grained PAT as the fallback
and a self-test that names the missing permission. Consumers move one at a
time behind toggles: the token env var replaces the `ghcr-auth` grep,
gha-runner mints single-use JIT configs instead of registration tokens,
`ci.sh` sets secrets with it, site and workspace pushes go over HTTPS with a
credential helper. The SSH deploy key stays for config-repo pushes until
Phase 11.

**Phase 8 — who may press Apply.** An `admins`-group check on every mutating
server function and API route, the group forwarded through traefik headers.
A setup token plus a local break-glass login (argon2, server session),
dormant behind a site setting the onboarding wizard turns on for fresh
installs. Tests for the deploy-hook token comparison and for authz. Gate: a
user outside the group gets 403 on Apply.

**Phase 9 — the nix tree stops naming this box.** Three switches, each its
own day with a closure diff, none changing behaviour. 9a: a declared enable
option per stack, every stack's config under `mkIf`, an explicit import list.
9b: ~210 literals become `fleet.*` reads fed from `site.json`; generated
state moves out of the tree into the state root (touches app-db: pg restart,
then pocket-id, off-hours and alone). 9c: daedalus.nix stops reading across
stacks — each contributes its own dashboard entry, versions come from the
images export, the cross-stack sops greps disappear. Proof: a build with
immich disabled evaluates to a closure without immich.

**Phase 10 — the app becomes modules, and gets a real build.** 10a: each
dashboard category moves to `src/modules/<id>` with a manifest; the nav is
derived from which nix modules are enabled and which exports exist; every
loader takes the capability context instead of `process.env`. 10b: `vite
build`, migrations at start, a multi-stage Dockerfile, CI on GitHub-hosted
runners publishing to ghcr by digest. The built image runs beside the dev
container on a second hostname against the same database until the
screenshot walk matches; then `source.mode` flips to `registry` with dev mode
kept as a Developer setting.

**Phase 11 — the nix half moves into the engine.** One mechanical move with a
hard gate: `platform/` and `stacks/daedalus/` become `nix/` here, the engine
exports `nixosModules.default`, the config repo imports it as a pinned flake
input, and the closure must be byte-identical. Then the remaining stacks
migrate one by one behind the Phase 9 enable options. The config repo shrinks
to flake, hardware config, a host file, `site/` and the operator notes; the
skills and the bash guard are rewritten for the two-repo loop.

**Phase 12 — install it somewhere else.** A wizard over Phases 3–8, each step
re-runnable from Settings; `nix run …#init` writes a config flake from a
template, generates the hardware config, creates `site/` with a sops config
from the host key, rebuilds and prints the LAN URL plus setup token. Every
catalog module gets a manifest, schema, docs and a health path; a docs site;
`v0.1.0`, which this box pins. Rehearsal: a throwaway VM from NixOS minimal to
a published app using only `init`, the UI and the documented external steps.

Realistic order is 6 → 7 → 8, since 9c depends on 6 and 7 having moved the
Cloudflare and GitHub secrets; 9 and 10 are the long ones.

---

Status: draft v3 of 2026-09-08, in execution (see the table above). Inputs: a
full audit of `stacks/daedalus/app` (40,300 LOC), the nix side (44 stacks),
web research on 25+ comparable products and the current NixOS/sops/
Cloudflare/GitHub/TanStack/packaging facts (verified 2026-09-08), and a
read-only feasibility review of v1 against the repo.

Operator constraints that shape v3:

- **Every phase leaves daedalus and the box in a working state.** The server
  is in daily use; the migration takes weeks. No phase may leave the machine
  half-migrated overnight.
- **Every phase is compatible with the previous one.** Old paths keep working
  until the new path is verified; switching is a one-line toggle; rollback is
  a NixOS generation plus `git revert`.
- **Order of attack: UI first.** Tailwind v4 + shadcn, then a read-only
  settings page, then configuring things from it (starting with the JSON
  repo), and only then nix starts reading from the new place.
- Decisions already taken: personal stacks stay in the public engine as
  enable-flagged catalog modules; GitHub sign-in is OAuth device flow with a
  PAT fallback; the UI adopts Tailwind v4 + shadcn.

---

## 1. Context (what the audits found)

**Keep and build on:** `platform/publishing.nix` (`fleet.webApps` →
traefik/pi-hole/CF/gatus), `platform/podman.nix` (the `mk*` helpers),
`platform/export.nix` (versioned JSON export domains — already the nix→app
product boundary), `stacks/apps/registry-lib.nix` + `apps.json` +
`src/lib/contract/*` (UI-written JSON, nix reads it — the model Clan validates
at scale; every GUI that edited Nix text instead is dead), the file-drop
bridges (`host/lib.sh`, `src/lib/bridge.ts`: the app holds no host privilege —
Comin and the HA Supervisor use the same writer/applier split),
`contract/snapshot.ts` and `lib/http.ts` (the seams a module system needs).
Every OIDC client secret and DB password is already machine-generated.

**Blockers, roughly in the order the plan removes them:**

1. **The app has no settings store**: site identity is env from nix, plus
   four `VITE_*` values inlined at build time (`src/lib/site.ts`). Live
   literals remain: `service-head.tsx:253` (the "Open" button on every service
   tab), `registries.tsx:63,215`, `deployments.tsx:39` (owner), `settings.tsx:325`,
   `external-apps.ts`.
2. **Secrets have no declared shape**; `mkSecretRender` consumers keep stale
   values after rotation (the documented false-success trap); the Cloudflare
   token exists in three sops files; `daedalus.nix:1617-1674` greps three
   *other* stacks' secrets; the GitHub credential in the container is a
   classic `repo`-scope PAT.
3. **No authentication code and no authorization**: anyone past the
   forward-auth gate can apply, reboot, reveal secrets.
4. **No build**: `vite dev` in production against a bind mount, installing
   from the LAN Verdaccio at every start; `vite build` never exercised;
   migrations are manual (`pnpm db:migrate`); `LITELLM_*` are `required()`.
5. **65% of the app (~26k LOC) is stack-specific dashboards** behind four
   static registries and two non-exhaustive `switch(tab)` per category;
   `image-repos.ts` is a 65-row table of this box's containers.
6. **No enable surface in nix**: `configuration.nix:16-44` auto-imports every
   file; `podman.nix:557` asserts registries and containers are 1:1.
7. **`daedalus.nix` hard-references ~15 optional stacks at eval time**
   (`:54-86`, `:811-957`, `:1578-1606`): remove immich and the control plane
   fails to evaluate.
8. **~210 site literals** (`santiago`, `toscanini.me`, `enp3s0`, `/run/user/1000`,
   the GitHub owner) across platform and stacks; `fleet.stateRoot` is
   `readOnly`; `apps.nix:711` defaults the image to `registry.toscanini.me`.
9. **Machine-generated plaintext lives inside the repo tree**
   (`stacks/apps/secrets`, `stacks/app-db/secrets`, `.mcp.json`), gitignored
   but on disk under `/etc/nixos`.
10. **Single-value schema versions** (`registry-lib.nix:25-29`,
    `contract/version.ts`) — users' `site/` directories and engine versions will drift.
11. **Install story**: a 22-line recovery doc assuming this hardware.

---

## 2. Target architecture (the end state; reached gradually)

**From the outside, the install is:** install NixOS → add ONE import (the
`init` command writes it and rebuilds) → open the web UI → configure the
domain, credentials, apps → daedalus writes JSON under `site/` in the user's
own config and rebuilds. The engine exposes a single NixOS module; that module
*reads* the JSON and the sops ciphertext at evaluation time. Daedalus never generates nix files and
never edits nix text: JSON in, system out. The import has to exist before the
web UI does (the UI is a container the module declares), so the order is
import → rebuild → UI, not UI → import. A "web UI first" installer mode of the
same app is a later refinement of `init`.

Two pieces (revised 2026-09-10; the earlier three-piece model with a separate
SITE repo is retired — see the note after the block):

```
ENGINE  github.com/santiagotoscanini/daedalus   (public; keeps name + history)
  flake.nix           nixosModules.default (THE import), lib, packages.{init,image-stream}, templates.config
  nix/{platform,core,modules/<id>}   every stack gated by fleet.modules.<id>.enable
  app/                the TanStack Start app; src/core + src/modules/<id> (manifest, loaders, views, schema)
  host/               the bridge agents (apply, image-update, deploy-trigger, ci, power, workspace, secrets)

CONFIG  the user's own NixOS config at /etc/nixos   (theirs; this box keeps its flake + hardware here)
  flake.nix           inputs.daedalus (pinned by tag)
  configuration.nix   imports daedalus.nixosModules.default; fleet.site.source = ./site; hardware; host specifics
  hardware-configuration.nix, host.nix — whatever the user hand-writes; daedalus never touches these
  site/               THE ONE DIRECTORY DAEDALUS WRITES. Data, not code:
    site.json         UI-WRITTEN: schemaVersion, identity, network, modules{enabled, settings}, integrations, imagePins
    apps.json         UI-WRITTEN: the app registry (schema unchanged; accepted as a RANGE)
    secrets/<name>.sops   one value per file, sops binary format, UI-written
    .sops.yaml        host key (ssh-to-age derivation) + operator recovery age key
```

Why not a separate site repository (the earlier design): every Apply would
still have had to commit a `flake.lock` bump into the config repo, so "daedalus
never writes the user's repo" was never actually achieved — it bought a
two-repo transaction, a reverse-order rollback and a "site HEAD vs lock
disagree" failure mode without the purity it promised. And it split the
description of one machine across two repositories (hardware in one, LAN
address in the other). Daedalus is now a guest in the user's config, fenced to
one directory, which is how every other NixOS tool (home-manager, disko,
sops-nix) integrates: your flake, their input.

`fleet.site.source` is the eval-time path the module reads JSON from — a
flake user writes `./site` (pure: it is part of their flake's source).
`fleet.site.path` is the run-time disk path the host agents WRITE to; it
defaults to `/etc/nixos/site` and only needs stating when the config lives
elsewhere. They are different things (a store path vs a directory on disk), so
both exist. v1 targets flake configs only; the plain `imports = [ … ]` form
for channel-based configs is a follow-up.

**Source control is the user's business, with one exception daedalus cannot
delegate.** A flake only sees git-TRACKED files, so a `site/apps.json` written
but never `git add`ed fails the very rebuild it was written for ("file not
found" — the most repeated trap on this box). Hence three states, all
reported on the Settings tab:

- **not a git work tree** — daedalus writes the files and stops; the tab warns
  that this directory is the only copy of the configuration.
- **a git work tree, commit switch OFF** (the default) — daedalus writes and
  `git add`s what it wrote, and leaves committing to the human. The tab says
  so plainly, because the human's next `git commit` will sweep those staged
  files in.
- **a git work tree, commit switch ON** — after every write, one commit scoped
  to `-- site/` with the Apply trailer; push best-effort. The scope is
  load-bearing: the index is shared with a person.

Detection is `git rev-parse --show-toplevel` from `fleet.site.path`, by the
snapshot agent, never assumed. The switch is an operator preference the app
passes in each request (`commit: true|false`), so the agent stays dumb.

**Rollback does not depend on git.** The agent keeps the previous bytes of
every file it overwrites, builds FIRST, switches only if the build passed,
and on a failed switch restores the bytes and switches again (committing the
restore when the switch is on). One mechanism for all three states; `git
revert` is gone. The config repo shrinks over the phases as stacks move into
the engine; `site/` never moves again.

**Commit policy** (the operator's requirement made precise):

| Change | Stored in | Commit |
|---|---|---|
| Anything nix consumes: domain, network, enabled modules, module settings, integration ids, apps registry, secrets | `site/` in the config repo (`site.json`, `apps.json`, `secrets/*.sops`) | written + `git add`ed always; one commit scoped to `-- site/` per Apply when the switch is on |
| Engine version bump | config repo `flake.lock` ("Update daedalus" button; a one-file scoped commit under the same switch) | same switch |
| Anything nix does not consume: theme, UI prefs, onboarding progress, deploy history, notes, drafts | Postgres | none |
| The engine | engine repo | never written by a running system |

**The app, end state.** Built by CI on GitHub-hosted runners into
`ghcr.io/santiagotoscanini/daedalus:<semver>@sha256`, pinned by the engine;
dev mode (`source.mode = "local"`, `vite dev`) stays as a developer setting.
Core = registry, changeset Apply with diff preview, settings, secrets vault,
onboarding, auth, integrations (Cloudflare, GitHub), module registry
(`import.meta.glob` over `src/modules/*/manifest.ts`, splat route), a
capability `Ctx` handed to modules (no `process.env` in loaders), typed HTTP
results. UI = Tailwind v4 + shadcn tokens, theme presets in Postgres injected
in the root `head()`, settings forms from JSON Schema (`@rjsf/core` +
`@rjsf/shadcn`, zod `toJSONSchema` as the authoring path, an `x-daedalus`
vocabulary for `secret`/`hostname`/`port`/`statePath`/`imageRef`).

**Secrets, end state.** One value per sops file, encrypted **in the container
with public recipients only** (static `sops` binary in the image; `.sops.yaml`
bind-mounted read-only); no private key ever in the container; plaintext never
crosses the bridge directory. Multi-key env files are assembled on the host by
`sops.templates` with `restartUnits` (sops-nix at the locked revision supports
templates, `binary`, `restartUnits` — verified in the store copy), which closes
the rotation false-success trap structurally. Recipients: the host key via
`ssh-to-age` (the `age1…` derivation, not the raw `ssh-ed25519` line) and an
operator recovery age key shown exactly once. Rekey is a root bridge running
`sops updatekeys -y`. Never mount the repo root into the container (container
root maps to the operator uid; today's tree contains plaintext DB passwords
and the Claude MCP token).

**Onboarding, end state** (every step skippable and re-runnable from
Settings): init CLI on an existing NixOS → LAN setup mode with a journal
setup token → local admin + recovery key → domain + Cloudflare (token verify,
zone pick, probe TXT over DoH, locally-managed tunnel created via API) →
Pocket ID `/setup` then flip the gate to forward-auth + `admins` → GitHub
device flow (`repo workflow`) → source control (is `/etc/nixos` a git work
tree? offer the commit-on-change switch; suggest a private remote if it has
none) → first app with JIT runners.

---

## 3. Phases

Rules that apply to every phase:

- **Feature flags, not cut-overs.** New behaviour ships beside the old one
  behind a `site.json`/settings toggle or a nix option defaulting to the old
  behaviour; the phase ends by flipping the default once verified, and the
  old path is deleted one phase later.
- **App-only phases carry zero rebuild risk.** daedalus is `source.mode =
  "local"`, so saving a file is the deploy and `git revert` is the rollback.
  Phases 1–3 are app-only.
- **Gate before switch** for nix phases: `nixos-rebuild build` → `nix store
  diff-closures /run/current-system ./result` (the diff must list only what
  the phase intends) → `nixos-rebuild test` → the container census
  (`podman ps` before and after, `curl` of every `healthPath`) → `switch` →
  commit + push. Rollback is always "boot the previous generation" or
  `git revert` of one commit, never a manual repair. Phases that touch
  `stacks/app-db` are marked (pg restart → restart pocket-id after).
- No nix phase runs on the same day as an image update or the weekly flake
  autoupgrade (check the timer; disable it for the day).

### Phase 1 — Tailwind v4 + shadcn foundation (2–4 days, app only)

1. Add `tailwindcss@4`, `@tailwindcss/vite`, shadcn (new-york, OKLCH
   tokens), `@theme inline` over `:root`/`.dark` tokens, a `data-theme` dark
   variant. Existing CSS keeps working beside it (preflight scoped with
   `@layer` so nothing existing is reset).
2. Restyle the shared kit on tokens **without changing its API**:
   `viz.tsx`, `ui.tsx`, `tabs.tsx`, `skeleton.tsx`, `service-head.tsx`,
   `status.tsx`; then pages file by file (apps first, since they are used
   daily; categories after). The landing's demo mocks are resynced at the
   end, per the landing rule.
3. Theme store: a `settings` kv table in Postgres (drizzle migration), a
   theme preset in the shadcn `cssVars {light,dark,theme}` shape
   (tweakcn-compatible), injected in the root route `head()` so first paint
   is themed; an Appearance page with presets + light/dark. Non-nix setting:
   never committed.
4. Spike `@rjsf/core` 6.x + `@rjsf/shadcn` on Tailwind 4 now (it still
   depends on `tailwindcss-animate`); if it fights the tokens, the fallback is
   a small in-house renderer over a constrained JSON Schema subset using the
   shadcn primitives. Decide before Phase 2.
5. `pnpm typecheck`, `vitest`, a `shot` walk of every page under the gate
   (`events.json` before pictures; the two baseline page errors are known).

Compatibility: pure app change; HMR deploys it; revert = `git revert`.

**Outcome, 2026-09-08 — all five steps landed (step 2 in a second pass the
same evening, after the operator saw an unchanged UI and asked for the
restyle).** Step 2 as shipped: every component and route re-expressed in
utilities + the shadcn primitives, file by file, in eleven parallel agents
plus a consistency pass; `styles.css` went from 5,998 lines to 170 (element
defaults, eight `@keyframes`, `.embed` for the Grafana iframe) and
`scripts/dead-css.mjs` reports zero dead classes; `Button`'s variants now
carry the house looks (foreground-fill primary, outlined danger) so no
`BTN_*` constant survives; tone is `lib/tone.ts` + `--tone`; skeletons import
the real components' box constants. Verified: tsc/lint/121 tests clean, a
43-tab `shot` walk compared against before-shots (nothing lost; one
pre-existing version-wrap fixed), the shell in desktop/collapsed/phone
states, light mode on three pages. Landing demo mocks NOT yet resynced —
waiting on the operator's review of the UI first. Also from step 1, what
shipped: Tailwind 4.3.3 + `@tailwindcss/vite` with a five-
layer cascade (`theme, base, legacy, components, utilities`) so preflight
cannot reset the old stylesheet and a utility still beats it; `src/theme.css`
holding shadcn OKLCH tokens with the legacy `--bg/--text/--brand/…` names
aliased onto them (the old palette converted losslessly, so no pixel moved);
17 shadcn primitives in `src/components/ui/`; `cn()`; a `settings` kv table
(migration 0008) with the theme rendered into the root `head()`; a `/settings`
route carrying an Appearance section (4 presets × light/dark/system).

Three findings worth keeping:

- **The RJSF spike failed on cost, not compatibility.** `@rjsf/shadcn` 6.8
  builds fine on Tailwind 4 + Vite 8, but a four-field form costs **+537 kB
  raw / +173 kB gzip** over a bare React page, and `@rjsf/core` + the ajv8
  validator alone already cost +393 kB. It also hard-depends on
  `tailwindcss-animate`, duplicates ten `@radix-ui/*` packages beside our
  `radix-ui` meta-package, and ships both `lodash` and `lodash-es`. **Decision:
  the in-house renderer** over a constrained JSON-Schema subset, targeting the
  new `components/ui/field.tsx` row. Phase 2 depends on this.
- **The token bridge made step 2 invisible, which is why it then had to
  happen.** Aliasing the legacy names onto the shadcn tokens meant no pixel
  moved when Tailwind landed — the operator's first reaction was "I'm still
  seeing the old UI". The restyle that followed was run as a re-expression,
  not a redesign, so the visual diff is deliberately small; what changed is
  that every look is now one component (`Button`, `Badge`, `Alert`, `Field`)
  a preset or a Phase-10a module can lean on.
- **Vite's dep optimizer can wedge mid-session.** Adding imports of new
  packages (cva, radix-ui) while the dev server runs triggers a
  re-optimisation; twice today it left the served module graph pointing at a
  stale `?v=` hash and every page threw `react_jsx-runtime.js does not provide
  an export named 't'` on hydration — SSR HTML fine, app dead. The fix is
  `systemctl restart podman-app-daedalus`; the tell is that exact error in
  `events.json`. Not a code bug: nothing to fix in the repo.
- **`lucide-react` must stay in `ssr.noExternal`.** It publishes no `exports`
  map, so Vite's SSR resolves its CJS `main` while the browser gets the ESM
  build — two React instances, and every page importing an icon dies on
  hydration with "Invalid hook call" over server-rendered HTML that looks
  perfect. Caught only by reading `events.json`.

### Phase 2 — Settings page, read-only (2–3 days, app + a few env binds)

A `/settings` route that only *shows* what the box is, sourced from what
already reaches the container: env bound by `daedalus.nix`, the export
domains, and the snapshot mounts.

- **General**: name, domain (`BASE_DOMAIN`), timezone, operator (email from
  `/export/site.json`), engine version (git rev via a new export field).
- **Network**: LAN ip/interface/gateway, DHCP scope (`/export/network.json`),
  wanHost, DDNS interval.
- **Integrations**: Cloudflare account/zone/tunnel ids + **token status**
  (`GET /user/tokens/verify` with the existing `DASH_CF_DNS_TOKEN`: valid,
  expiry, which zone); GitHub owner + **token status** (`GET /user`,
  `X-OAuth-Scopes`, rate-limit remaining); mail relay (sender, alertTo, last
  send from Loki).
- **Site repository**: today's truth — `/etc/nixos` remote, last Apply
  commit, dirty state, "site repo: not configured" (Phase 3 fills this in).
- **Appearance**: from Phase 1. **Developer**: dev mode indicator, inert.
- Fix the live literals now that a single settings source exists:
  `service-head.tsx:253`, `registries.tsx:63,215`, `deployments.tsx:39`,
  `settings.tsx:325` (data dir from the manifest), `external-apps.ts` → a
  list in the Postgres settings kv.
- Introduce `src/core/settings/` (the reader over env/export/kv) and the
  `Ctx` shape modules will receive later, so Phase 2 code is already in its
  final home.

Nix: at most a handful of new env binds/export fields (engine rev, interface
name, gateway); a rebuild whose closure diff is one env file.
Compatibility: nothing editable yet; nothing else changes.

**Outcome, 2026-09-09 — landed** (`4d83fc1`, with `fda41a1` moving the rail
toggle to an icon beside the wordmark). All six sections ship read-only:
General, Network, Integrations, Site repository, Appearance, Developer.
`src/core/ctx.ts` (the capability set a reader is handed instead of
`process.env`) and `src/core/settings/` (the reader, the deferred 5-min-cached
token checks, the off-box list from the store) exist and are where Phase 10's
modules will look. Host side: `system.configurationRevision` in flake.nix so
the exports carry the build rev (`-dirty` when built from a dirty tree),
`site.json` gained hostname/timezone/nixosVersion/network, and a new
`daedalus-repo-snapshot` (5-min timer, runs git as the operator, never
fetches) publishes `/etc/nixos`'s git facts to `/repo/repo.json`.

Two findings:

- **The GitHub token is a pre-prefix classic PAT.** Its kind cannot be read
  off the string, so Integrations derives it from the `X-OAuth-Scopes` header
  on `GET /user` instead. Anything keying on a `ghp_`/`github_pat_` prefix
  would report the wrong kind here.
- **The literals sweep missed one.** `service-head.tsx`'s Open button still
  typed `.toscanini.me` and was fixed on 2026-09-09 (`BASE_DOMAIN` from
  `lib/site.ts`, which every neighbouring file already used). What remains in
  the tree is comments, tests, and `lib/external-apps.ts`, which is the
  documented SEED for the store-backed list rather than a live literal.

### Phase 3b — The repository split (added 2026-09-10; ~1 day, GitHub ceremony + one small rebuild)

Today the app's repo and the box's repo are the same public repo. They
should not be: a home server's whole configuration is public because the
product that runs on it wanted a public home. The old Phase 11 resolved this
the wrong way round (the current repo kept the name and became the engine;
`/etc/nixos` was re-pointed at a new config repo). Revised: **`/etc/nixos`
stays where it is and becomes the private config repo, renamed; daedalus
moves out.** The box's working directory never moves.

1. GitHub: rename `santiagotoscanini/daedalus` → `santiagotoscanini/s2-server`;
   update `/etc/nixos`'s origin AT ONCE (the flake-autoupgrade timer and
   `apply.sh` push to origin; once a new repo takes the old name, the redirect
   dies and a push would land in the engine). Then create the new public
   `santiagotoscanini/daedalus`. Delete `s2-server-site`.
2. History: `git filter-repo` over a fresh clone, keeping `stacks/daedalus/app`
   (→ `app/`), `website/`, `docs/` as relevant, and the two daedalus rules
   (→ the engine's own `.claude/rules/`); push as the engine's `main`. The
   clone lives at `~/projects/daedalus` — the workspace convention — which
   dissolves the documented "daedalus's live source is not the ~/projects
   clone" exception.
3. Pages: enable on the engine repo from `website/`, verify at the
   `github.io` URL, then move the custom domain `daedalus.toscanini.me` (the
   hand-managed grey-cloud CNAME is unchanged). Only THEN make the old repo
   private — Pages on a private repo is unavailable on the Free plan, so the
   order is what keeps the landing page up.
4. `/etc/nixos`: `git rm` the moved paths; `stacks/daedalus/daedalus.nix`
   sets `source.path = /home/santiago/projects/daedalus/app` (the option
   already exists — `source.mode = "local"` takes a host dir). Copy the
   untracked `node_modules`/`.corepack` across first so the container does
   not cold-install against Verdaccio. Gate: closure diff shows only the
   daedalus unit (its bind-mount path); `podman ps` census; `/api/healthz`.
5. Words: CLAUDE.md (recovery runbook says "clone daedalus" — now
   `s2-server`; the projects-workspace exception; the layout tree), README
   (the product pitch moves to the engine; the config gets a short private
   front page), `docs/recovery.md`, the memories (`daedalus-public-launch`,
   `project-workspace-tooling`). The engine gets its own CLAUDE.md: dev loop,
   typecheck via the running container, the shotter recipe.

What does NOT move yet, and why: `stacks/daedalus/daedalus.nix`, `host/`,
`assets/` and all of `platform/`. The module depends on the platform
(`mkRootlessContainer`, `fleet.webApps`, the export machinery) and so does
every other stack; the platform IS the engine's foundation and making it
importable is Phase 11's actual work. Until then the engine repo is honestly
"the daedalus app and its site", not yet an importable NixOS module.

Rollback: the old repo is renamed, not deleted; `source.path` back;
`git revert`.

**Outcome, 2026-09-10 — landed** (`ff17fb1` in s2-server; the engine's history rewritten once more the same
day to strip a `Co-Authored-By: Claude` trailer, so its hashes are not worth
recording — the tree is unchanged). `/etc/nixos` is the private
`santiagotoscanini/s2-server`; the public `santiagotoscanini/daedalus` holds
`app/`, `website/`, the two daedalus rules, its own README and CLAUDE.md —
221 commits of history via filter-repo, both trees verified byte-identical
to the source before the cut. The container bind-mounts
`~/projects/daedalus/app`; it came back on the new mount in ten seconds with
its copied `node_modules` ("Already up to date"), typecheck + 131 tests pass
from there, and the post-words rebuild resolved to the SAME store path as the
running system — the cross-reference edits were provably comment-only.

Two GitHub traps, both now in [[daedalus-public-launch]]: `PUT /pages` with
`cname` + `https_enforced` together fails "certificate does not exist yet"
(set cname alone), and a custom-domain change on a workflow-built site 404s
until the site is REDEPLOYED. Because I privatised the old repo before the
second retry, the landing page was 404 for roughly three minutes. Sequence
for next time: set cname → redeploy → confirm 200 → privatise.

Neither token on the box carries `delete_repo`: `s2-server-site` is the
operator's click. Every old clone of the config repo (a laptop) must
`git remote set-url origin …/s2-server.git` — the rename redirect is dead
because the engine took the name, and a stale clone's push would land in
the public repo.

Left open, for the operator: (1) `website/src/routes/docs.tsx` is ~90%
s2-server operator knowledge published from the engine, and its four
"in-repo runbook" links now 404 (they point at `docs/*.md` in a repo that
has none); (2) `stacks/home-assistant/assets/configuration.yaml` keeps a
home address in cleartext "because the repo is private" — that reasoning
already failed once (the repo was public for a month); (3)
`stacks/apps/assets/deploy.sh:49` still names the old app path (deferred:
changing it restarts every deploy unit).

### Phase 3 — The `site/` directory, written from the UI (revised 2026-09-10; 1–2 days, app + host + small nix)

The first *write* from Settings, into the one directory daedalus owns inside
the user's config. Nix does **not** read from it yet.

1. `fleet.site.path` defaults to `/etc/nixos/site`. `fleet.site.source`
   (module-side, default `null` = legacy locations) and `fleet.registry.file`
   stay as scaffolded. `fleet.site.mirror` is deleted.
2. Bridge verb `site-write` (`host/site-write.sh`, root → `setpriv` to the
   operator for git): writes the files it is handed under `$SITE_DIR`
   verbatim, names fixed in the script; keeps the previous bytes; if
   `$SITE_DIR` is inside a git work tree, `git add`s exactly those paths
   (mandatory — flake visibility); if the request says `commit: true`, one
   commit scoped to `-- site/` with the Apply trailer, push best-effort. No
   `git init`, no remote creation, no second repository.
3. `repo-snapshot.sh` publishes ONE repo plus the site directory's state:
   whether `fleet.site.path` is inside that work tree, which files exist, and
   whether each is tracked/staged/clean.
4. Settings › Site repository becomes Settings › **Site**: the path; the
   source-control state as one of the three sentences above; the
   commit-on-change switch (enabled only when a work tree is detected); the
   files with their tracked/staged state; and "Write site.json" (first time
   and refresh — idempotent, reports "already held these bytes").

Compatibility: the running system's inputs are untouched; `site/site.json` is
written but nothing reads it. Rollback: delete the directory.

**Outcome (revised), 2026-09-10 — landed** (`8f77a00` in s2-server, `870493b`
in the engine). `site/` exists in `/etc/nixos`, written from Settings › Site;
`site-init.sh` became `site-write.sh` over a shared `site-lib.sh`; the
snapshot is v3 (one repo + the directory's state, per file: absent /
untracked / staged / modified / clean — named for what a REBUILD sees). The
commit switch is a preference (`site.commit`) the app passes on every request;
it is ON on this box. Verified by driving the tab through all three states.
Retired the same day: the mirror block, `fleet.site.mirror`, the separate
repo at `~/selfhost/apps/daedalus/site` (deleted), and `s2-server-site` on
GitHub (operator's click).

**Outcome, 2026-09-09 — landed** (`03c5bae` the repository and its UI,
`2756a5b` the Apply mirror). All four steps shipped; the repository exists at
`/home/santiago/selfhost/apps/daedalus/site`, local-only for now.

Two deliberate deviations from the text above, both because the box already
had an answer:

- **The path is `${fleet.stateRoot}/apps/daedalus/site`**, not
  `${fleet.stateRoot}/daedalus/site` — beside daedalus's `apply/` bridge,
  which is where the state taxonomy in CLAUDE.md puts app-adjacent state its
  own agents write.
- **The app renders the bytes, `site-init.sh` writes them verbatim**, rather
  than the script building JSON. Same division of labour as `apply.sh` +
  `registry-file.ts`: every decision about shape is application logic, where
  it is typed and tested. The three files ride as one id-stamped payload, and
  the filenames the host will write are fixed in the SCRIPT — a filename that
  travelled across the trust boundary is a path traversal with extra steps.

**The finding worth keeping: apps.json in the mirror is copied from
`/export/applied.json`, never re-rendered from the apps table.** The first
implementation rendered it from the DB — the same call an Apply makes — and
the very first Initialize produced a file that differed from the flake's,
because `chismed` and `voyra` have pending unapplied drift (stage live→lab,
plus four capability flags on chismed). That is the mirror committing changes
the system has not been rebuilt with, into the one file whose entire claim is
that it describes the machine as it is. The registry snapshot already
publishes a byte copy of the committed file into the container; that is the
right source, and the site repo's `apps.json` is now byte-identical to
`/etc/nixos/stacks/apps/apps.json` (sha256 verified, both sides).

Also worth knowing: `repo-snapshot.sh` reports both repositories through one
function and bumped to schemaVersion 2 (`site` added at the data top level);
the decoder accepts 1 and 2, because a reader newer than its producer is the
normal state for the minutes between a switch and the timer's next run.
`site-init.sh` starts `daedalus-repo-snapshot.service` before writing its
final status, so the page's invalidation reads current facts instead of
telling the operator for five minutes that the repository they just made does
not exist.

Verified by driving the real UI (shotter on `iso-daedalus-net`, run dirs
`site-init-2`, `site-resync-1`, `site-tab-1`): a remote that does not exist
with "create it" unchecked is refused by name and creates nothing; an empty
remote initializes a local repository; the tab flips to `ready` at once; after
the applied.json change the tab reported `apps.json differs` and one Re-sync
brought it back to byte-identical. Both schemes and phone width checked, 2
pageErrors per load (the documented baseline). The Apply mirror block was
exercised against a scratch copy of the repository — writes, scoped commit,
"already held these bytes" on a second run — rather than by running a real
Apply, because the only pending drift is the live→lab change above and that
is the operator's call, not the phase's.

The remote was attached the same day, from the UI, at the operator's word:
`santiagotoscanini/s2-server-site`, private, pushed over the operator's SSH
identity (`e44c0ee` — the form only offered a remote BEFORE the repository
existed, so a box initialized local-only could never gain one without a
shell; it now offers one whenever there is not an origin yet, and stops once
there is).
**Superseded the next morning (2026-09-10).** The operator asked why the
JSON should live apart from the nix files a user also owns and modifies —
and the answer was that it should not; see the revised §2 and the two-piece
model. What transfers from the above: the renderer (`core/site/file.ts`),
the bridge shape and its fixed-filename rule, the tab, the `fleet.site.*`
options, the digest-per-file idea (now "tracked/staged/clean" rather than
"in sync with a mirror"). What goes: `git init`/remote creation in
`site-init.sh`, the Apply mirror block and `fleet.site.mirror`, the
two-repo snapshot, and the `santiagotoscanini/s2-server-site` repository
on GitHub (deleted with the operator's permission). The
applied-registry-not-the-DB lesson stands: `site/apps.json` is only ever
written by an Apply, so it can never hold unapplied drift.

### Phase 4 — Nix reads from `site/` (revised 2026-09-10; half a day, nix + host)

1. `git mv stacks/apps/apps.json site/apps.json`. `configuration.nix`:
   `fleet.site.source = ./site;` and `fleet.registry.file =
   "${config.fleet.site.source}/apps.json"`; `stacks/apps/declarations.nix`
   and `stacks/daedalus/daedalus.nix` read `config.fleet.registry.file`
   (already scaffolded). `fleet.site.*` values from `site.json` are asserted
   **equal** to the `configuration.nix` constants this phase (belt and
   braces); they become the source in Phase 5.
2. `host/apply.sh` writes `apps.json` through the same `site-write`
   mechanics (shared `host/site-lib.sh`): keep previous bytes, write, `git
   add`, optional scoped commit, build, switch, restore-on-failure. `git
   revert` and `TARGET=/etc/nixos/stacks/apps/apps.json` go. The registry
   snapshot (`/export/applied.json`) reads from the option.
3. `platform/autoupgrade`: unchanged.

Compatibility: `apps.json` schema unchanged; UI unchanged; the
`/api/registry/*` doors unchanged. Rollback: `git mv` back.

Gate: closure diff shows only the store path of `apps.json`; an Apply
produces one scoped commit (switch on) or one staged change (switch off); a
forced bad payload restores the bytes and the running system is untouched.

**Outcome, 2026-09-10 — landed** (`b09957f` in s2-server, `4c64c81` in the
engine). Closure diff exactly as gated: `apps.json` store path out, `site/`
in; `/export/applied.json` byte-identical to the moved file; the eleven
site.json ↔ configuration.nix equality assertions hold. The rollback gate was
run through the REAL bridge with `{"apps": "not an object"}`: failed at eval
in five seconds, bytes restored and identical, running system untouched (and
the failed unit mailed the operator, as designed). It found one bug —
`site_write` left a first write's `.absent` marker behind, so a later restore
would have deleted the file — fixed before commit. Known rough edge, not
fixed: `errtail`'s last-1200-chars window shows the nix trace's tail rather
than the one useful line ("expected a set but found a string"), which is in
`last.log`.

### Phase 5 — `site.json` becomes the source of site constants, and editable (2 days, nix + app)

1. `configuration.nix:61-68` constants are replaced by `fleet.site.*` reads.
   `fleet.lanInterface`, `fleet.gateway`, `fleet.dhcp.*` are fed from
   `site.json`; only their literals (`enp3s0` ×4, `192.168.0.1`, the DHCP
   scope) are replaced now. The `VITE_*` values in `src/lib/site.ts` gain a
   runtime fallback from `/site/site.json` (bind mounted read-only: **only
   the JSON files**, never the repo root).
2. Settings becomes editable for site values through a **changeset**: the
   Apply bar generalises from `apps.json` to `{apps.json, site.json}` with a
   rendered JSON diff preview; `driftOf` generalises; the bridge payload
   carries both; `apply.sh` commits whichever changed. A setting that touches
   nothing nix reads (theme) never enters the changeset. Secrets stay
   read-only status here.

Compatibility: identical values → identical closure except the touched
literals. Gate: change `wanHost` in the UI → one write under `site/` (one scoped
commit with the switch on), ddclient/wg-easy units restart, nothing else in
the closure diff.

**Outcome, 2026-09-10 — landed** (s2-server `c6ad8d0` nix half, `f2c64f8`
the subject fix; engine `468006e` model, `2aceab5` UI, `ac60f42`). `site.json` IS
the source: `platform/site.nix` defines baseDomain, lanIp, wanHost,
lanInterface, gateway, dhcp.*, dnsUpstreams and mail.{sender,alertTo} from the
document, `configuration.nix` keeps only `mail.smtpHost` and `site.source`;
four new `fleet.*` options carry what were literals in configuration.nix and
stacks/pihole; the equality assertions shrink to the unsourced fields
(hostname, timezone, owner, operator, Cloudflare ids). Gate 1: identical
values → empty closure diff.

The app edits against the committed file (site/ mounted read-only at
/site) through a stored DESIRED document — the registry's pattern applied
to a document; only the thirteen sourced fields are editable, a draft carries
only those, every save is validated as a whole document by the same decoder
that reads the committed file (round-trip tested as a fixed point). Apply's
payload is a map of files; one rebuild carries apps.json and site.json.
Thirteen fields became controls on General/Network/Integrations with a
pending chip and "was …"; the Apply bar renders on Settings too and both
pages list a `site` entry; a folded line diff shows what will be written.
The browser round trip found a bug: dropping a draft wrote NULL into a jsonb
NOT NULL column — the store gained delete.

Gate 2, through the real bridge (not the button — see below): `mail.alertTo`
→ `santiago+daedalus@` (same inbox), Apply in 25 s, the value in the export,
`podman-grafana` and `smartd` restarted (its consumers: the contact point and
the SMART mail target), one scoped commit pushed; then the revert the same
way, bytes identical to the original, closure identical to before. The plan's
example (`wanHost` → ddclient/wg-easy) was NOT used: ddclient would have
written a real DNS record for a made-up host.

Skipped, deliberately: the "VITE_* runtime fallback from /site/site.json" —
the VITE_ env is bound from `fleet.*`, which is now fed by site.json, so the
values are already the document's. NOT exercised: the Apply BUTTON. Every UI
Apply also carries the apps table's render, and `chismed`/`voyra` have
unapplied drift (stage live→lab) that is the operator's decision, not a
gate's. The first button press is theirs.

### Phase 6 — Secrets vault v1: the Cloudflare token (2–3 days, app + nix)

> Revised 2026-09-11: the steps below predate the single-token change. Where
> they say three consumers, three templates or per-consumer toggles, read the
> "What remains" paragraph above — one template, four consumers, one toggle.

The first UI-managed secret, chosen because it is the documented
rotate-together set (traefik, cloudflared, daedalus) and the false-success
trap's poster child.

1. Site repo gains `.sops.yaml` (host key derivation + the operator's existing
   age key) and `secrets/`. The container gets the static `sops` binary
   (Containerfile) and read-only binds of `.sops.yaml` and `secrets/`.
2. Nix: `fleet.secrets.dir`, `sops.secrets."cf-dns-token" = { sopsFile =
   "${cfg.secrets.dir}/cf-dns-token.sops"; format = "binary"; }`, and three
   `sops.templates` rendering the exact env lines traefik, cloudflared and
   daedalus read today, each with `restartUnits` on its consumer. The old
   `env.sops` values stay defined; a `fleet.secrets.useSite.cf-dns-token`
   toggle (default false) selects which file each consumer reads.
3. App: Integrations › Cloudflare gets "Set token": verify with the API
   first, then `sops encrypt --input-type binary --age <recipients>` in the
   container, bridge payload with the ciphertext, `apply.sh` writes
   `secrets/<name>.sops` + commits + rebuilds. Write-only; never logged (a
   biome `noConsole` rule with an allowlist plus a test that no secret value
   appears in status files or logs).
4. Flip the toggle for the three consumers; rotate the token from the UI;
   verify traefik's ACME resolver, `cloudflared-route-sync`, and the
   daedalus DNS tab all use the new value **without manual restarts**
   (`restartUnits` on the fleet's oneshot container units is untested; this
   is the gate). Then delete the value from the three old `env.sops`.

Compatibility: the toggle defaults to the old path; flipping is one option.
⚠ touches `stacks/cloudflared` and `stacks/traefik` restarts; off-hours.

### Phase 7 — GitHub: device flow, HTTPS pushes, JIT runners (2–3 days)

1. Register the daedalus OAuth App (device flow enabled); `client_id` in
   `site.json` (overridable). Settings › GitHub: "Sign in" shows the 8-char
   code, polls, verifies scopes (`repo workflow`), stores the token as
   `secrets/github-token.sops` via the Phase 6 path; "Paste a fine-grained
   PAT" as the fallback with a per-endpoint self-test that names the missing
   permission (Administration, Contents, Workflows, Secrets, Actions).
2. Nix consumers behind toggles: `DASH_GITHUB_TOKEN` (replaces the ghcr-auth
   grep), `gha-runner` minting via `generate-jitconfig` (single-use, no
   registration token), `ci.sh` secret setting, the site-repo and workspace
   pushes over HTTPS with the token (git credential helper) instead of the
   SSH deploy key. Flip one at a time; keep the SSH key for `/etc/nixos`
   pushes until Phase 11.

Compatibility: every consumer has a toggle; the classic PAT keeps working
until each is flipped.

### Phase 8 — Auth hardening (1–2 days, app only)

`admins`-group check on every mutating server function and API route
(`actorOf(request)` helper; Pocket ID forwards groups through traefik
headers — add the header to `daedalus.nix`'s `auth.headers`); the
setup-token + local break-glass session (argon2, TanStack `useSession`)
implemented but dormant behind `site.json` `auth.localLogin` (default off
here; the onboarding wizard turns it on for new installs). Tests for the
`api.deploy.ts` token comparison and for authz.

Compatibility: you are in `admins`; nothing changes for you. Gate: a test
user outside the group gets 403 on Apply.

### Phase 9 — Nix: enable surface, literals, state out of the tree (3 switches over 1–2 weeks)

Each switch is its own day with a closure diff; none changes behaviour.

- **9a Gating.** `fleet.modules.<id>.enable` declared per module (never an
  `attrsOf submodule` from JSON), each stack's `config` wrapped in `mkIf`
  (47 files; 40 flat attrsets, 7 already `mkMerge`), explicit import list
  replacing `nixFilesIn`, all defaults `true` so the closure is identical.
  `fleet.config.repo` (the `/etc/nixos` checkout) threads into autoupgrade,
  git, claude.nix and the apply agent's lock bump.
- **9b Literals + state.** ~210 occurrences → `fleet.operator.*`,
  `fleet.baseDomain`, `fleet.github.owner`, `registry.${baseDomain}`;
  `fleet.stateRoot` writable; machine-generated state moves to
  `${fleet.stateRoot}/daedalus/state/` (the bootstrap oneshots migrate the
  files once, idempotently); runbook paths become docs URLs. ⚠ touches
  `stacks/app-db` → pg restart → restart pocket-id and verify
  `id.<domain>` per the cascade runbook.
- **9c Inversion.** `fleet.dashboard.<id>` contributions replace
  `daedalus.nix`'s cross-stack reads; the 14 `*_VERSION` env vars are
  replaced by `/export/images.json` tags; the three cross-stack sops greps
  are gone (Cloudflare and GitHub already moved in Phases 6–7; Pocket ID's
  `STATIC_API_KEY` is contributed by pocket-id). Prove it:
  `fleet.modules.immich.enable = false` in a `nixos-rebuild build` (not
  switch) must evaluate and produce a closure without immich.

Compatibility: defaults keep every module on; the closure is identical after
9a and 9c except the intended env renames.

### Phase 10 — App module system and build (1–2 weeks, app only)

- **10a Registry.** Manifest type, `import.meta.glob` registry, splat route,
  per-tab records, nav derived from active modules (active = nix module
  enabled in `site.json` and required exports present). Move each category
  into `src/modules/<id>/` with verbatim moves and index files preserving
  export surfaces (the sub-agent pattern that worked for the overhaul);
  `idp` folds into a core `identity` module; `image-repos.ts` splits into
  per-module `releases.ts`. `Ctx` capabilities; `defineFlow` extracted from
  `apply-flow.ts`/`update-flow.ts`; typed HTTP results; `env.ts` becomes
  the single validated schema with LiteLLM optional.
- **10b Build.** `vite build` (`ssr.noExternal: true`, srvx entry with the
  rejection guard, migrations at start via the `drizzle-orm` migrator,
  `drizzle/` in the image, site identity from `/site` at runtime, a build
  check that fails on `__vite-browser-external`, npmjs registry in CI).
  Multi-stage Dockerfile; CI on GitHub-hosted runners → ghcr by digest. Run
  the built image on the box **beside** the dev container (`daedalus-next`
  on a second hostname, same DB, read-only until parity), `shot` walk both,
  then flip `source.mode` to `registry` with dev mode kept as the Developer
  setting.

Compatibility: 10a is a refactor with tests (module registry tests, the
existing 121, plus fixture-driven loader tests that survive a null upstream);
10b runs side by side before switching.

### Phase 11 — The engine becomes importable (revised 2026-09-10; the repos already split in Phase 3b)

One mechanical big-bang with a hard gate, then a gradual migration — NOT the
single `git mv` of everything the original text described. First:
`platform/` + `stacks/daedalus/{daedalus.nix,host,assets}` move into the
engine as `nix/`; the engine exports `nixosModules.default`; `/etc/nixos`
imports it as a `git+file:` input pinned in `flake.lock`. Gate: the closure is
IDENTICAL. Then the stacks migrate ONE BY ONE into `nix/modules/<id>` behind
`fleet.modules.<id>.enable`, each its own small rebuild that leaves the box
working. From the big-bang on, an engine-side nix change costs one `nix flake
update daedalus` in the config; the `/rebuild` skill does it when the
engine's HEAD moved. The original text follows for the details that still
apply:

### Phase 11 — Engine extraction: today's repo splits into engine + tiny config (2–3 days)

1. Clone today's repo to `~/projects/daedalus` and reshape it there with
   `git mv` into `nix/`, `app/`, `host/`, `website/`, `docs/`; `flake.nix`
   exports `nixosModules.default`, `lib`, `templates.config`; `nix flake
   check` passes with no site present (Phase 9's gating makes this
   possible). Push as the public repo (same name, history kept).
2. `/etc/nixos` shrinks to the CONFIG shape: `flake.nix` (input `daedalus`
   by tag, nixpkgs following daedalus), `configuration.nix` importing
   `daedalus.nixosModules.default` with `fleet.site.source = ./site`, `hardware-configuration.nix`, `host.nix` (hostname, hostId,
   static IP, zfs pools, the hand-managed CNAME notes), `.claude/`,
   `HARDWARE.md`, `lemonade.md`, `AUTH.md`, `FUTURE.md`. Everything else is
   deleted here because it now comes from the engine input. `site/` does not
   move. `fleet.imagePins` (site override map,
   engine defaults via `mkDefault`) replaces `image-update.sh`'s `.nix`
   rewriting.
3. `developer.engineOverride` in `site.json` makes the agents pass
   `--override-input daedalus git+file:///home/santiago/projects/daedalus`
   + `--no-write-lock-file` so engine work is testable before a tag.
4. CLAUDE.md Rule 1, the skills (`/rebuild`, `/add-stack`,
   `/update-images`), `.claude/settings.json` allow list and
   `bash-guard.sh` are rewritten for the two-piece loop (`site/` via the UI,
   everything else in `/etc/nixos` by hand, engine work in
   `~/projects/daedalus`); the engine gets its own contributor CLAUDE.md.

Gate (the only hard one): `nixos-rebuild build --flake /etc/nixos` with the
engine pinned to its first tag produces a closure identical to the running
system; the engine's `nix flake check` is green; an Apply still writes only under
`site/`.

### Phase 12 — Onboarding, init, catalog, release (1–2 weeks)

Wizard over the Phases 3–8 pieces (each step re-runnable from Settings);
`packages.init` (`nix run github:santiagotoscanini/daedalus#init`: asks
hostname + admin user, writes the CONFIG flake from `templates.config`, runs
`nixos-generate-config`, creates `site/` in the config with `.sops.yaml` from the host key, rebuilds, prints the LAN URL + setup token);
pi-hole DHCP default off in the template; every catalog module gets manifest
+ schema + docs + a `healthPath` whose absence is a 5xx; docs site; `v0.1.0`
tag; this box pins it. Rehearsal: a throwaway VM or spare machine goes from
NixOS minimal to a published app using only `init`, the UI and the documented
external steps.

---

## 4. Verification (cross-cutting)

- Before the first nix phase (Phase 2's env binds), add a `just census`
  target: `podman ps` census, `systemctl --failed`, every `healthPath` curl,
  and a `diff-closures` helper; verify the GitHub remote of `/etc/nixos` is
  current and add a nightly `git bundle` of it into `${fleet.stateRoot}`
  (`/etc/nixos` is not snapshotted).
- Closure diffs and the census after every nix phase.
- Contract tests: `apps.json`/`site.json` fixtures per schema version parse
  in nix (`nix eval`) and in the app (vitest); migrations fixture-driven.
- Container truth, not unit state (`podman ps`, `/api/healthz`).
- Browser: `shot run` drivers for settings and onboarding under the gate;
  `events.json` before pictures.
- Security: the no-secret-in-logs test; authz tests per mutation; the
  sops-in-container output is decrypted by the host in CI.

## 5. Not in v1

Out-of-tree modules; multiple domains or non-wildcard certs; alternative
proxy/IdP/DNS; ISO installer and nixos-anywhere; third-party app stores;
Cloudflare Access; Cloudflare account/Zero Trust org creation (no public API);
Registrar API (beta); generated-secrets-as-sops (Clan-vars style) — later;
`fetchPnpmDeps` nix package as an alternative to the image; non-flake configs.

## 6. Risks and early spikes

- `@rjsf/shadcn` on Tailwind 4 (Phase 1 spike; in-house renderer fallback).
- TanStack Start is still "RC" by its own docs; pin exact versions.
- `restartUnits` on the fleet's oneshot container units (Phase 6 gate).
- Two-commit Apply (permanent from Phase 4): a crash between the site commit
  and the lock commit leaves the lock behind the site; `apply.sh` reconciles
  on the next run and Settings shows "site ahead of lock".
- Phase 9b touches app-db (pg cascade) — alone, off-hours.
- Cloudflare: locally-managed tunnels sidestep the `PUT …/configurations`
  api-token issue; keep them. GitHub: the OAuth App needs "Enable Device
  Flow"; `POST /user/repos` is UAT-only, which device flow satisfies.
- Non-flake (channel-based) configs cannot import the engine in v1; `init`
  always writes a flake.

## 7. Open questions (defaults stated)

- **CI on the engine repo** — "CI flake builds" is on the rejected list; the
  plan runs `nix flake check` and the schema fixtures in the *engine* repo's
  Actions from Phase 11 on, treating it as a different repo. Say so if you
  want local `just check` targets instead.
- Site directory on this box: `/etc/nixos/site`, source-controlled with the
  rest of the config; commit-on-change switch ON here (this box's repo is the
  only copy of its configuration). Default: yes.
- Engine layout: move the app to `app/` at the root in Phase 11. Default: yes.
- License for the engine: MIT or Apache-2.0. Default: MIT.

## 8. Sources (verified 2026-09-08)

Nix/NixOS: fetchGit/flake-ref semantics, `allow-dirty-locks`, `nix flake
update <input>` (2.19+), `hardware.facter`, `lib/modules.nix` rename
helpers, `system.stateVersion`, `oci-containers` 25.11 (`imageStream`,
`podman.user`, `sdnotify`), nixos-rebuild-ng default in 25.11, unit
handling (`X-StopIfChanged`), `fetchPnpmDeps` `fetcherVersion`; Comin;
nixos-anywhere/facter; Clan inventory/vars/sops; SelfHostBlocks contracts.
sops 3.13.3 CLI and age env vars; sops-nix README/module and the locked
store copy; typage 0.3.1 (no SSH recipients); no JS sops encoder exists.
Cloudflare token/permission-group/tunnel/zone/registrar endpoints; no
account API. GitHub fine-grained/App permission tables, device flow,
`workflow` scope, JIT runner config, runner security, deploy-key limits.
RJSF 6.8/6.9 + `@rjsf/shadcn`, zod 4 `toJSONSchema`, Tailwind 4 `@theme
inline`, shadcn theming/presets, TanStack Start hosting (srvx,
`dist/server`), routing constraints, `import.meta.glob`. Products: Coolify,
Dokploy, CapRover, Dokku, Cosmos, CasaOS, Umbrel, Runtipi, YunoHost,
Cloudron, StartOS, Portainer, TrueNAS, Unraid, Homarr, Komodo, Arcane, HA
Supervisor, Watchtower.
