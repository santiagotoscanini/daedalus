# Daedalus — what is missing, and how to do it

Daedalus is the box's control plane: a TanStack Start app that writes JSON
under `site/` in the operator's NixOS config, a file-drop bridge that lets root
agents act on those writes, the nix modules that read the JSON back, and a
Rust agent that makes the other machines on the network (a Windows PC, a Mac)
part of the same page. Today it runs this one box (`s2-server`) from a dev
server against a bind-mounted checkout, builds the seven first-party apps on
the box with Railpack, reports to GitHub as a check run and a Deployment, and
draws a System page for each enrolled machine from the document its agent
publishes.

This file is the **forward-looking** plan only: what is not built yet, why it
matters, and how to build it. What already landed is not recorded here — it is
in git history (the version of this file at `7451bc0` carried every phase
outcome up to 2026-09-15, and the version at `049333c` the state of every
phase and feature on 2026-09-22), in `ARCHITECTURE.md` and `BUILDS.md` for the
design as built, in `agent/README.md` for the agent, and in
`~/.claude/plans/piped-gathering-meerkat.md` for the GitHub App + Railpack
build-out (closed 2026-09-13).

Every item below was checked against the code and the running box on
2026-09-23. An item that is here is missing; an item that is not here is
either done or was decided against ("Not in v1").

## Where things stand (2026-09-23)

| Phase | What | What remains |
|---|---|---|
| 8 | Auth hardening | armed; the break-glass login has never been tried against a real IdP outage |
| 9 | Nix: enable surface, literals, state out of the tree | nothing for the engine; two usernames in private stacks become options when those stacks move (Phase 11) |
| 10 | App module system and a real build | 10a: three host clients still reached around `Ctx`; 10b: the first `v*` tag, the operator's call |
| 11 | The engine becomes importable | 23 stacks are still the reference host's own; the host names the engine's 55 files one by one instead of `nixosModules.default` |
| 12 | Onboarding, `init`, catalog, release | not started |

The **Features** section lists what the product is missing regardless of
phase — previews, feature flags, the rest of the app secrets editor, the app
contract as packages, the rest of the machines story — each with its
mechanism.

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
ENGINE  github.com/santiagotoscanini/daedalus   (public; one branch, main)
  flake.nix           nixosModules.{platform,daedalus,catalog,default}, lib.path, templates.config; packages.init is Phase 12
  nix/{platform,modules/<id>,stacks/daedalus}   every catalog stack gated by fleet.modules.<id>.enable
  app/                the TanStack Start app; src/core + src/modules/<id> (manifest, loaders, views)
  agent/              the Rust agent for the other machines (Windows service, macOS LaunchDaemon, tray)
  nix/stacks/daedalus/host/*.sh   the bridge agents (apply, build, deploy, image-update, engine-update, power, secrets, workspaces)

CONFIG  the user's own NixOS config at /etc/nixos   (theirs; this box keeps its flake + hardware here)
  flake.nix           inputs.daedalus (pinned by tag, or a local clone for a box that develops it)
  configuration.nix   imports daedalus.nixosModules.default; fleet.site.source = ./site; hardware; host specifics
  host/               the host's DATA for the options the engine declares (datasets, pins, policy, sops)
  site/               THE ONE DIRECTORY DAEDALUS WRITES. Data, not code:
    site.json         UI-WRITTEN: schemaVersion, identity, network, modules{enabled, settings}, integrations
    apps.json         UI-WRITTEN: the app registry (accepted as a RANGE of schema versions)
    vault/<name>.sops one value per file, sops binary format, UI-written; vault/apps/<app>-env.sops per app
    .sops.yaml        host key (ssh-to-age derivation) + operator recovery age key
```

Daedalus is a guest in the user's config, fenced to one directory — how every
other NixOS tool (home-manager, disko, sops-nix) integrates: your flake, their
input. `fleet.site.source` is the eval-time path the module reads JSON from;
`fleet.site.path` is the run-time disk path the host agents WRITE to (default
`/etc/nixos/site`). v1 targets flake configs only.

**Source control is the user's business, with one exception.** A flake only
sees git-TRACKED files, so a `site/apps.json` written but never `git add`ed
fails the very rebuild it was written for. Hence three states, all reported on
the Settings tab: not a git work tree (daedalus writes and warns); a work tree
with the commit switch OFF (writes and `git add`s, leaves committing to the
human); a work tree with the switch ON (one commit scoped to `-- site/` per
Apply, push best-effort).

**Rollback does not depend on git.** The agent keeps the previous bytes of
every file it overwrites, builds FIRST, switches only if the build passed, and
on a failed switch restores the bytes and switches again.

**Commit policy:**

| Change | Stored in | Commit |
|---|---|---|
| Anything nix consumes: domain, network, enabled modules, module settings, integration ids, apps registry, secrets | `site/` in the config repo | written + `git add`ed always; one commit scoped to `-- site/` per Apply when the switch is on |
| Engine version bump | config repo `flake.lock` ("Update daedalus" button) | same switch |
| Anything nix does not consume: theme, UI prefs, onboarding progress, deploy history, node policy, notes | Postgres | none |
| The engine | engine repo | never written by a running system |

**The app, end state.** One image, built by CI on GitHub-hosted runners into
`ghcr.io/santiagotoscanini/daedalus:<semver>@sha256`, pinned by the engine
(`fleet.daedalus.image` defaults to the version `app/package.json` declares).
Users run it as-is. Developers set `fleet.daedalus.dev` and the same image's
`runtime` stage serves their checkout with HMR. Settings forms come from an
in-house renderer over a constrained JSON-Schema subset (the RJSF spike failed
on bundle cost).

**Secrets, end state.** One value per sops file, encrypted **in the container
with public recipients only** (static `sops` binary in the image); no private
key ever in the container; plaintext never crosses the bridge directory.
Multi-key env files are assembled on the host by `sops.templates` with
`restartUnits`. Recipients: the host key via `ssh-to-age` and an operator
recovery age key shown exactly once. Rekey is a root bridge running `sops
updatekeys -y`. Never mount the repo root into the container.

**Onboarding, end state** (every step skippable and re-runnable from
Settings): init CLI on an existing NixOS → LAN setup mode with a journal setup
token → local admin + recovery key → domain + Cloudflare (token verify, zone
pick, probe TXT over DoH, locally-managed tunnel created via API) → Pocket ID
`/setup` then flip the gate to forward-auth + `admins` → install the box's
GitHub App on the account → source control (is `/etc/nixos` a git work tree?
offer the commit-on-change switch; suggest a private remote if it has none) →
first app, whose first push to main builds here → first machine, whose agent
announces itself over the SRV record and waits for Approve.

---

## Rules for every phase

- **Every phase leaves daedalus and the box in a working state.** The server
  is in daily use. No phase may leave the machine half-migrated overnight.
- **Feature flags, not cut-overs.** New behaviour ships beside the old one
  behind a `site.json`/settings toggle or a nix option defaulting to the old
  behaviour; the phase ends by flipping the default once verified, and the
  old path is deleted one phase later. Rollback is a NixOS generation plus
  `git revert`.
- **App-only phases carry zero rebuild risk.** The box runs the app in dev
  mode, so saving a file is the deploy and `git revert` is the rollback.
- **Gate before switch** for nix phases: `nixos-rebuild build` → `nix store
  diff-closures /run/current-system ./result` (the diff must list only what
  the phase intends) → `nixos-rebuild test` → the container census
  (`podman ps` before and after, `curl` of every `healthPath`) → `switch` →
  commit + push. Phases that touch `modules/app-db` are marked (pg restart →
  restart pocket-id after).
- **A catalog move is closure-neutral**: the toplevel derivation is
  byte-identical before and after, per stack. `nix fmt` and `nix flake check`
  green in the engine before the commit; `checks.full-catalog` is the proof
  that the template host plus every leaf still evaluates.
- No nix phase runs on the same day as an image update or the weekly flake
  autoupgrade (check the timer; disable it for the day).
- An agent release is `agent/gate.sh all` green, a version bump, an annotated
  `agent-v*` tag; the machines self-update within ten minutes and "Update
  now" on Settings › Machines does it at once. The release signing key has
  no recovery path but the operator's copies.

---

## Phases remaining

### Phase 8 — Auth hardening (one rehearsal remains)

`auth.enforceAdmins` is on: every mutating server function and API route
refuses a request whose forward-auth groups do not name `admins`. What is
left is the **break-glass local login**: a setup token plus a local login
(argon2id, sealed session cookie), built and dormant behind `site.json`
`auth.localLogin` (absent on this box, so the route 404s; not editable from
Settings on purpose; the onboarding wizard turns it on for new installs). It
has never been exercised against a real IdP outage. Phase 12's rehearsal is
where that happens: stop Pocket ID, reach the login with the token, apply
something, start Pocket ID, confirm the session survives the gate coming
back.

### Phase 9 — Nix literals (nothing left for the engine)

The engine's `nix/` tree names no box. Two facts in the reference host's
private stacks are still a person's handles with no option — `calibre-web`'s
`Remote-User` and LiteLLM's `PROXY_ADMIN_ID` — and get one on the day each
of those stacks moves into the catalog (Phase 11), not before.

Design notes the split produced, for the moves still to make: option
DESCRIPTIONS do not enter the closure but comments inside shell heredocs do;
`fleet.data` names are an informal contract (`tv`, `books`, `photos`,
`minecraft` are read by stacks, and `books` by three of them); the dataset
table and `fleet.data` spell each mount twice; `builder.nix` silently
requires a dataset mounted at its root.

### Phase 10 — App module system and build

- **10a, the last seam.** The data files under `src/modules/*/data/` reach
  `host/prom`, `host/loki` and `host/keys` directly — 24 files today —
  rather than through `Ctx`. The capability set already covers env, hosts,
  secrets, snapshots and the store; those three clients are what stands
  between a module and a test against a fake `Ctx` alone. Fold them in as
  `ctx.prom`, `ctx.loki`, `ctx.keys`, and extend the boundary test that
  forbids `process.env` under `src/modules/` to forbid `host/*` imports too.
- **10b, the first tag.** The image builds, walks (`scripts/image-walk.sh`
  is run before a tag) and runs a box in dev mode as its `runtime` stage;
  `.github/workflows/image.yml` publishes to ghcr on a `v*` tag and has never
  run. Publishing the first public image is the operator's decision: bump
  `app/package.json`, add `LICENSE`, tag `v<version>`, push the tag. The
  ghcr package is private until its visibility is changed by hand. amd64
  only — the run stage holds the build platform's argon2 binary. The config
  still binds the `VITE_` spellings of the identity env; rename them to
  `BASE_DOMAIN`, `GITHUB_OWNER`, `REGISTRY_HOST`, `GRAFANA_URL` and drop the
  fallback.

### Phase 11 — The engine becomes importable (the leaves remain)

The spine is in the catalog (19 modules: `app-db`, `apps`, `cloudflared`,
`gatus`, `healthchecks`, `logging`, `monitoring`, `pihole`, `pocket-id`,
`registry`, `traefik`, and the leaves `factorio`, `grocy`,
`intel-gpu-exporter`, `metube`, `myspeed`, `stirling-pdf`, `verdaccio`,
`wg-easy`); a host made from `templates.config` evaluates to a whole system
with a control plane to log in to; `developer.engineOverride`, Update
daedalus and the schema fixtures are in. What remains:

1. **The other 23 stacks, one by one**, none of them needed for a box to
   run: `argus-vpn`, `calibre-web`, `cleanuparr`, `downloads`, `grocy-mcp`,
   `home-assistant`, `immich`, `janitorr`, `lemonade-logs`, `litellm`,
   `litellm-pgvector`, `minecraft`, `n8n`, `nextcloud`, `open-webui`,
   `recyclarr`, `scraparr`, `seerr`, `shelfmark`, `shotter`, `tv`,
   `wealthfolio`, `yazio-mcp`. Order: the media janitors (`recyclarr`,
   `scraparr`, `janitorr`, `cleanuparr` with the media family), the books
   pair (`calibre-web` + `shelfmark`), the database tenants, the AI cluster
   as one group (`litellm` declares `litellmKeys` and `mcpServers`, which
   become platform registries then), `shotter` (whose post-deploy checks are
   a product feature, item 2 below), then the netns owners and their tenants
   together (`downloads`, `argus-vpn`, `tv`). Each move: closure-neutral,
   pin to `host/images.nix`, secrets to `host/sops/<id>/` keeping their
   basenames, policy to `host/modules.nix`, a README beside the module,
   `checks.full-catalog` green.
2. **Adopt `nixosModules.default` on the reference host.** Import ORDER is
   part of the closure (list-typed options concatenate in module order), so
   the host still names the engine's 55 files one by one in their old
   positions. Once nothing is left to interleave with, one deliberate,
   separately-gated rebuild replaces the list with the single import; its
   closure diff will not be empty and must be read line by line.
3. **`README.md` and `CONTRIBUTING.md` still say the module "is not in
   this repository yet"** (the paragraph after `README.md`'s layout table, `CONTRIBUTING.md` lines
   119 and 127). Rewrite
   those paragraphs for what the repo is now.

Decisions already taken for the moves, so they are not re-litigated: the
identity interface stays in `platform/identity.nix`; `catalogModules` lists
files, not stacks; what other stacks contributed to a rendered config is a
registry (`fleet.logDrops`, `fleet.logFiles`, `fleet.builder.npmMirrorHost`);
policy without a narrow default has no default (`gatus.allowedSubjects` is
required); no engine-shipped image pins; the reference box pins the engine
through a local clone because `app/` is a runtime dependency, everyone else
through `github:` and a tag.

### Phase 12 — Onboarding, init, catalog, release (1–2 weeks)

Wizard over the Phases 3–8 pieces (each step re-runnable from Settings);
`packages.init` (`nix run github:santiagotoscanini/daedalus#init`: asks
hostname + admin user, writes the CONFIG flake from `templates.config`, runs
`nixos-generate-config`, creates `site/` in the config with `.sops.yaml` from
the host key, resolves the first set of image pins into `host/images.nix`,
rebuilds, prints the LAN URL + setup token); pi-hole DHCP default off in the
template; every catalog module gets manifest + schema + docs + a `healthPath`
whose absence is a 5xx; a docs site for a stranger's box (today the website
has the landing page and the boundary document of what stays outside the
repo, nothing on installing); `LICENSE`; the `v0.1.0` tag; this box pins it.
Rehearsal: a throwaway VM or spare machine goes from NixOS minimal to a
published app and an enrolled machine using only `init`, the UI and the
documented external steps — with the break-glass drill from Phase 8 on the
way.

---

## Features

What the product is missing regardless of phase. Grouped by kind, not
priority; each can be done independently unless noted.

1. **Preview deployments — a URL per branch, for vibecoding, testing and
   play.** Push a branch of plutus and a minute later
   `plutus-<branch>.toscanini.me` is running that commit; push again and it
   updates in place; delete the branch (or close the PR) and it is gone.
   Main-only builds today; the seams are in place (`builds.lane`,
   `prNumber`, the `candidate` publish mode, `pull_requests:write` granted).
   The four-stage design (P1 checks → P2 required check → P3 previews → P4
   fork policy) is in `~/.claude/plans/piped-gathering-meerkat.md`; the
   decisions that plan left open:
   - **Hostname keyed by branch, not by sha.** `plutus-<branch>.<d>` is one
     label (the wildcard certificate matches one label only), stays stable
     across pushes so bookmarks and the derived Pocket ID client's redirect
     URI survive, and the deployed sha is shown on the preview's card and in
     the GitHub Deployment.
   - **Runtime-managed, not nix-declared.** Previews come and go too often
     for a rebuild each: a `daedalus-preview@` template unit, a writable
     traefik file-provider directory (one router per preview, behind the
     same forward-auth), pi-hole records through its API. `lab` by default;
     a per-preview switch to `live` publishes it through the tunnel.
   - **Database: a fresh copy, never production.** Each preview gets its own
     database and role (`plutus_<branch>`), created from the latest logical
     dump of production, then the branch's own migrations run forward on the
     copy. Production is never read live and never written.
   - **Migrations are the hard part, so make them visible.** The build page
     for a branch shows the migration delta against main; the preview's
     first boot applies them to the copied data. Rule for merging:
     migrations must be expand/contract, because production deploys are
     deploy-and-report with no schema rollback. The check run says so when a
     migration drops or renames.
   - **Secrets: a preview env group.** Previews never see production
     credentials: `DATABASE_URL` points at the copy, `AUTH_SECRET` is fresh,
     everything else comes from a per-app `previewEnv` allowlist. P4: fork
     PRs are held until an operator approves that exact head sha.
   - **Lifecycle:** created on the first push to a branch of an app with
     previews enabled (or on PR open, per app setting), redeployed on push,
     destroyed on branch delete / PR close, after 7 idle days, or by LRU
     beyond a box-wide cap. GitHub gets a Deployment with
     `transient_environment: true` and a PR comment edited in place. The
     preview list lives on the app's page with sha, age, database size, and
     Destroy.
   - **Pairs with feature flags (item 8).**

2. **Post-deploy checks for all apps.** Only anansi and voyra have
   post-deploy assertion drivers in `stacks/shotter/assets/checks/`. The
   other five (iris, hermes, plutus, chismed, argus) have no automated
   verification beyond the deploy script's HTTP status check. Each needs a
   driver that runs the app's core loop as a signed-in user; the anansi
   driver is the template.

3. **argus e2e suite.** Needs a seeded database; deliberately excluded from
   the post-deploy checks because its e2e writes to the database and its
   other two checks compare a PR to a base branch. Waits on item 1 (a
   preview is the seeded database) or item 11 (a runner).

4. **Self-hosted Gitea with two-way GitHub mirroring.** A Gitea instance on
   the box that mirrors every project repo to and from GitHub, so that when
   GitHub is down the operator can still push, review and merge, and Gitea's
   own Actions keep CI going. A new catalog module with the mirror feature
   pointed at each GitHub repo; builds stay on the box's path.

5. **Dev mode from Settings.** `fleet.daedalus.dev` is a nix option the box
   sets in `configuration.nix`; Settings › Developer shows a chip that says
   so and nothing flips it. A toggle there writes `site.json`
   `developer.dev = true|false` and the option reads it (host-set wins), so
   switching between the dev server and the built image is an Apply, not a
   hand edit. Waits on Phase 10b's first tag: until an image is published
   there is nothing to toggle to.

6. **Machines: the rest of the story.** Shipped (agent-v0.10.0, engine
   `049333c`): the Windows service and the macOS LaunchDaemon from one
   crate, the tray, keep-awake, the SRV record and the signed hello, Approve
   / Revoke / Forget and per-node policy on Settings › Machines, self-update
   from a signed release with "Update now", the Claude remote-control
   server per machine with the page picker, `/telemetry` behind the node
   token and `/metrics` into the box's Prometheus through file_sd, and a
   System page per machine shaped to its OS (Windows: Motherboard with the
   vendor's BIOS list, Graphics, Software, Updates; macOS: Apple's releases
   with notes and CVE counts, Apps; both: Host, Memory, Disks, Build,
   Claude, Chromium). Missing, in the order it earns its keep:
   - **Power verbs from the box.** The only power request today is the
     box's own reboot. Sleep, restart and shut down a node from its page,
     and wake it with a magic packet (the agent reports its MAC). Each is
     an admin action under the armed gate, journaled with its actor. A
     Windows Update restart is not stopped by a keep-awake; the agent
     should report Kernel-Power events 41/42/109 so the fix is seen to be
     the update policy.
   - **Declared services.** A node's policy lists what the agent supervises
     — name, executable, arguments, restart policy — and it keeps them
     running like a very small systemd. "Start" from the UI means one of
     those; no shell, ever. The tray already supervises `claude
     remote-control` this way; generalize that path.
   - **Providers.** Lemonade on the PC, Ollama headless on the Mac: a
     declared service plus three things the box does with it — install and
     update it, ask which models it has, register them in LiteLLM so the AI
     tab shows them. `fleet.gpuHost`/`gpuHostIp` (a literal in the
     reference host's `configuration.nix`, read by litellm, lemonade-logs,
     pihole and gatus) generalizes into `fleet.nodes`, exported from the
     nodes table the way `apps.json` is, so a machine that joins with a GPU
     appears in the gateway.
   - **Dashboards and sleep-aware alerts.** The nodes are scraped and
     nothing draws them: a Grafana dashboard per node kind from the agent's
     metrics, and an alert that distinguishes "asleep on purpose" from
     "gone".
   - **The WIP boards**, blurred on the System page until the agent can
     read them: die temperatures (Windows via vendor libraries, macOS via
     SMC), GPU live figures (load, VRAM, clocks), AMD's "Vendor ships"
     driver feed through a box browser job like the motherboard's, Homebrew
     formulae through the tray. Each is an agent field plus the board
     unblurred; the contract grows a minor version per field.
   - **The next agent release** carries the classifier fix already on
     `main` (launchers before runtimes; Xbox helper packages skipped), so
     Battle.net stops reading as a runtime on the PC.
   - **Signing.** Apple codesign and notarization run once the repo's
     `release` environment holds the six santree secrets (the pipeline is
     in place; unsigned until then, and launchd runs it regardless). Windows
     ships unsigned, which works because SmartScreen checks only shell
     launches; Authenticode (Azure Trusted Signing or SignPath) comes back
     the day the landing page's download button goes live.
   - **Small, noted:** the EVGA 650 GM photo for the parts catalog; Arc's
     default-browser ProgId on Windows; `powermetrics` on the Mac needs a
     deadline so a hung call cannot stall a telemetry read.
   - **Docs.** `ARCHITECTURE.md` has no section on the agent, the hello,
     the node token or the telemetry document; `agent/README.md` is the
     only doc. One section in the architecture that points at it.

7. **Git commit attribution from the signed-in user.** Every `site/` commit
   is authored by "daedalus" regardless of who pressed Apply (no `--author`
   in any bridge script). The forward-auth headers carry the operator's
   email; pass the identity through the bridge request and commit with
   `--author="Name <email>"`, so GitHub shows who authored and daedalus
   committed.

8. **Feature flags via a self-hosted service, wired per app.** Run
   **Flipt** as a catalog module (single Go binary; flags declarative from
   a file in the config repo; OpenFeature SDKs; UI behind Pocket ID via
   `webApps`; storage on the shared cluster through
   `fleet.appDatabases.flipt`). daedalus does not reimplement flags; it
   wires them: `fleet.flagClients.<app>` in the spirit of `fleet.litellmKeys`
   gives each app a namespace and injects `FLIPT_URL` + a client token, and
   the preview runtime sets the evaluation context (`environment`,
   `branch`) so a flag can be on in every preview and off in production.
   The app page shows the app's flags with a link into Flipt's UI.

9. **App variables and secrets: convert, rotate, scope.** The editor sets
   and removes one secret at a time through the bridge and shows "set
   <date> by <actor>" from git. Still missing:
   - **Convert to secret.** The value moves from `apps.json` into the sops
     file in one Apply; the old plaintext remains in git history, and the
     UI says so. Convert to variable stays deliberately absent — the
     container can never read a secret back.
   - **Rotate the machine-generated ones.** `AUTH_SECRET` and the app's
     database password are "delete the file + rebuild" today (the app page
     says so in prose); a Rotate button per app is one more bridge verb
     doing exactly that, with a confirm. Like `secret-set`, the verb joins
     the `redact` fixtures before it ships.
   - **The runtime/build-time flag and the preview scope.** A real
     build-time secret goes to the build agent as a BuildKit secret rather
     than a placeholder; the preview scope is the same list scoped to
     previews. Both wait on item 1.

10. **The app contract as packages, published to the box's own Verdaccio.**
    daedalus defines a contract with its apps — which env names are
    injected, what `/api/healthz` answers, how migrations run at start, how
    auth works, where flags come from — and every app re-implements it by
    hand: six `start.mjs`, the same `check:bundle` grep in five
    `package.json`s, a 100–250-line `env.ts` per app, a copy of iris's hybrid
    auth in every app that has users. Publish the contract as small
    `@daedalus/*` packages from a `libs/` workspace (does not exist yet);
    ranked by duplicated lines removed: `@daedalus/auth` (the hybrid auth
    plus a proxy mode that trusts the forward-auth headers and fails closed
    without them), `daedalus-start` (find migrations, run them, refuse to
    boot without them), `@daedalus/env`, `@daedalus/health`,
    `@daedalus/flags`, `@daedalus/log` (structured stdout in the shape
    Alloy's level inference expects, with the redaction rules),
    `@daedalus/ai` (LiteLLM client with the thinking-model `max_tokens`
    gotcha baked in), `daedalus-check-bundle`, shared tsconfig and biome
    configs. **Mechanism:** a third build strategy beside `railpack` and
    `dockerfile` — `publish` — so a push runs the checks and `pnpm publish`
    to Verdaccio through the same webhook, queue and check-run path as an
    image build; versions via changesets; apps pin exact versions; the app
    page shows "auth 1.3.0 (latest 1.4.0)" from the lockfile the build
    already reads. The generic ones (`auth`, `health`, `log`) also go to
    npmjs under a public scope, because GitHub-hosted CI cannot reach
    Verdaccio. **Not this:** a UI kit.

11. **Self-hosted GitHub Actions runners, managed from daedalus.** Runners
    run CI, never fleet images — the box's build path stays the only way an
    image reaches zot. Ephemeral, on demand, per job: subscribe to
    `workflow_job`; on `queued` with a matching label, mint a JIT runner
    config and start one rootless podman container (`--ephemeral`, dedicated
    uid, resource limits, the builder's owner-match egress fence, no secrets
    beyond the single-use JIT token); it takes exactly that job and exits.
    A second, narrow GitHub App (`daedalus-runners`, `administration:write`
    on opted-in repos only, sealed in the same vault). The panel: runners
    now, jobs queued and running, per-repo minutes this month against the
    plan's allowance, failures; metrics through `fleet.prometheusScrapes`.
    Later: a Windows runner on the PC through the agent (item 6); a `gpu`
    label for jobs that want the model server.

---

## Operator decisions still open

1. **`~/.claude/projects` transcript pruning.** These transcripts can
   contain secrets a session read. The claude-rc journal keeps its own copy
   ≤1 month (root-only). Open question: exclude or prune them from ZFS
   snapshots/backups.
2. **License for the engine.** No `LICENSE` file exists. MIT or Apache-2.0;
   default MIT. Needed before the first `v*` tag.
3. **`--init` as the default in `mkRootlessContainer`.** node as PID 1
   never reaps orphaned grandchildren (yazio leaked a pid per session to
   the 2048 ceiling; plutus had 35 chromium zombies). The apps platform has
   it; the other sixty containers do not, and the general fix is one line
   touching all of them.
4. **Rewriting published history** for the three commits (2026-09-21) that
   carried the router's retail name in the public engine. Low sensitivity;
   it is an option now.

## Owed to the operator

Hand edits the UI cannot make for itself:

1. **The MCP server's credentials — opt-in, not owed.** The server is built
   and reachable at `/mcp`; nothing calls it until the operator wants a
   Claude session driving daedalus through it. Then three edits: mint a
   write token in Settings › Developer (shown once); add a `daedalus` entry
   to `.claude/mcp.json.sops` in `/etc/nixos` carrying that token as a
   bearer header; add `"daedalus"` to `enabledMcpjsonServers` in
   `.claude/settings.json`. Not done as of 2026-09-23.
2. **The first tag and the license** (Phase 10b, open decision 2) — one act,
   when the operator chooses.
3. **The six santree secrets** into the engine repo's `release` environment,
   so the macOS agent ships signed and notarized (feature 6).

## Engine polish

TypeScript, identified but not acted on (`noUncheckedIndexedAccess` and
`verbatimModuleSyntax` are on):

- Audit for places where `as` casts hide real type narrowing opportunities.
- `satisfies` where appropriate (config objects, exhaustive checks).
- Template literal types for the bridge verb strings (type-safe file names).
- Branded types for app names, sha hashes, build ids and node ids.
- `using` declarations for locks and cleanup — check the Vite plugin
  supports them first.
- `exactOptionalPropertyTypes` and `isolatedDeclarations` — assess
  viability.
- The agent's telemetry contract is typed twice: Rust structs in
  `agent/src/telemetry.rs` and hand-written decoders in
  `app/src/lib/agent/status.ts`. Generate the TypeScript side from the Rust
  side (ts-rs) at agent release time.

Small items:

- The engine logs nothing when it re-adopts a running build after a restart.
- The webhook log line omits the superseded count.
- Build-page live log during long checks may appear empty (markers arrive at
  stage boundaries, not mid-stage).
- The lab drivers under `<stateRoot>/shotter/drivers/` (78 of them, most
  one-off verification scripts) belong in the repo or in the bin, not in app
  state; `polish-walk.mjs` there has a stale "Runner" heuristic.
- Dev mode's first paint waits on ~280 unbundled module requests before
  React is wired; the production image bundles them. Nothing to fix in the
  app; worth knowing when a "slow" report comes from a dev-mode box.

## Documentation

What exists: `ARCHITECTURE.md` (5 Mermaid diagrams; Mermaid stays in the repo
by decision), `BUILDS.md`, `CONTRIBUTING.md`, `nix/README.md`,
`agent/README.md`, and the website's boundary document. Missing:

- **Bridge API reference.** The file-drop request shapes (apply, build,
  cancel, site-write, secret-apply, secret-set, workspace-clone,
  deploy-trigger, image-update, export-publish, task-run, claude-resume,
  claude-rc, engine-update, power) have no standalone doc beyond the code
  and `apply.sh`'s subject cases.
- **Operational runbook** for the build pipeline beyond what `BUILDS.md`
  covers — what to do when a build hangs, how to force-rebuild, how to read
  the build log, how to cancel.
- **The stale paragraphs** in `README.md` and `CONTRIBUTING.md` (Phase 11,
  item 3) and an agent section in `ARCHITECTURE.md` (feature 6).
- **An install guide** for a stranger's box (Phase 12).

## Verification owed (cross-cutting)

- A `just census` target in the config repo: `podman ps` census,
  `systemctl --failed`, every `healthPath` curl, and a `diff-closures`
  helper. The justfile has fmt/check/lint/boot/switch/engine-* today.
- The no-secret-in-logs test: `lib/redact.test.ts` covers error text and
  the `secret-set` verb; nothing asserts that no vault value or bridge
  secret appears in status files, build logs or the app's stdout. Write it
  as a fixture-driven test and add it to CI.
- The break-glass drill (Phase 8) and the fresh-box rehearsal (Phase 12).
- Standing practice: closure diffs and the census after every nix phase;
  container truth, not unit state; `shot run` drivers with `events.json`
  read before pictures; an authz test beside every new mutation; the tab
  timing driver before and after any change to a loader.

## Security residuals (from the adversarial reviews)

Known and accepted, not forgotten:

- The deploy hook's token appears in zot's own startup log line. Dropped
  from Loki by `fleet.logDrops.zot-config-dump`; the journal still holds
  the line for its retention window, readable by root and the
  `systemd-journal` group. Rotating the token is `sops
  host/sops/registry/env.sops`.
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
- The node token gates `/telemetry` and the Claude report; the public
  status strips the apps list and keeps the count. A stolen node key is a
  stolen heartbeat, not a stolen machine, as long as "no shell" holds
  (feature 6, declared services).

---

## Not in v1

Out-of-tree modules; multiple domains or non-wildcard certs; alternative
proxy/IdP/DNS; ISO installer and nixos-anywhere; third-party app stores;
Cloudflare Access; Cloudflare account/Zero Trust org creation (no public API);
Registrar API (beta); generated-secrets-as-sops (Clan-vars style) — later;
`fetchPnpmDeps` nix package as an alternative to the image; non-flake configs;
engine-shipped image pins; a site repository separate from the config; Mermaid
rendered on the website. Decided after evaluating Coolify (2026-09-15): no
second container engine, no control plane whose state lives outside git, no
one-container-per-database model. Decided 2026-09-23: no Rust rewrite of the
app's backend — the app holds no privilege and does no OS work in-process, so
its latency is I/O and hydration, not JavaScript; Rust belongs in the host
bridge binary and the agent, where the OS layer is.

## Risks

- TanStack Start is still "RC" by its own docs; pin exact versions. Its build
  is stricter than its dev server: a client file that reaches
  `@tanstack/react-start/server` through any import is refused at build and
  never in dev, so `pnpm build` belongs in the check every change runs.
- Two-commit Apply (site commit + lock commit): a crash between them leaves
  the lock behind the site; `apply.sh` reconciles on the next run and
  Settings shows "site ahead of lock".
- Previews (feature 1) run branch code with a copy of production data on the
  same box: the preview env allowlist and the fork-approval gate are what
  keep that safe, and both must exist before previews are on by default.
- The weekly `flake.lock` bump can move nixfmt and leave `/etc/nixos`
  treefmt-dirty, which fails `nix flake check`; check after every
  autoupgrade. `nix fmt -- --ci` writes before it fails.
- `platform/sops.nix` overrides sops-nix's Go inputs to the 1.26 toolchain
  because 25.11's Go 1.25 cannot build it; drop the override at 26.05.
- The agent's release signing key has no recovery path but the operator's
  copies; losing it means every machine must be re-enrolled with a new
  compiled-in key.
