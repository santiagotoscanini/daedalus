# Daedalus — what is missing, and how to do it

Daedalus is the box's control plane: a TanStack Start app that writes JSON
under `site/` in the operator's NixOS config, a root helper that starts a
fixed list of host verbs on its behalf, the nix modules that read the JSON
back, and a Rust agent that makes the other machines on the network (a
Windows PC, a Mac) part of the same page. Today it runs one box from an image
built on the box, builds the seven first-party apps there with Railpack,
reports to GitHub as a check run and a Deployment, and draws a System page
for each enrolled machine from the document its agent publishes.

This file is **forward-looking** only: what is not built yet, why it
matters, and how to build it. What landed is in git history, in
`ARCHITECTURE.md` and `BUILDS.md` (the design as built) and in the
component READMEs. An item that is here is missing; an item that is not is
either done or was decided against ("Not in v1").

## Where things stand

| Phase | What | What remains |
|---|---|---|
| 8 | Auth hardening | armed; the break-glass login has never been tried against a real IdP outage |
| 9 | Nix: enable surface, literals, state out of the tree | nothing for the engine; two usernames in private stacks become options when those stacks move (Phase 11) |
| 10 | App module system and a real build | 10a: data files still import some `host/` readers directly; 10b: the first `v*` tag, the operator's call |
| 11 | The engine becomes importable | 23 stacks are still the reference host's own |
| 12 | Onboarding, `init`, catalog, release | not started |

The **Features** section lists what the product is missing regardless of
phase, each with its mechanism.

---

## The end state

**From the outside, the install is:** install NixOS → add ONE import (the
`init` command writes it and rebuilds) → open the web UI → configure the
domain, credentials, apps → daedalus writes JSON under `site/` in the user's
own config and rebuilds. The engine exposes a single NixOS module; that module
*reads* the JSON and the sops ciphertext at evaluation time. Daedalus never
generates nix files and never edits nix text: JSON in, system out. The import
has to exist before the web UI does (the UI is a container the module
declares), so the order is import → rebuild → UI. A "web UI first" installer
mode of the same app is a later refinement of `init`.

```
ENGINE  github.com/santiagotoscanini/daedalus   (public; one branch, main)
  flake.nix           nixosModules.default, lib.path, templates.config, packages; packages.init is Phase 12
  nix/{platform,modules/<id>,stacks/daedalus}   every catalog stack gated by fleet.modules.<id>.enable
  app/                the TanStack Start app; src/core + src/modules/<id> (manifest, loaders, views)
  agent/              the Rust agent (controller on the box; Windows service, macOS LaunchDaemon, tray)

CONFIG  the user's own NixOS config at /etc/nixos   (theirs; hardware and host specifics stay here)
  flake.nix           inputs.daedalus (pinned by tag, or a local clone for a box that develops it)
  configuration.nix   imports daedalus.nixosModules.default; fleet.site.source = ./site
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
`fleet.site.path` is the run-time disk path the root verbs WRITE to. v1
targets flake configs only.

**Source control is the user's business, with one exception.** A flake only
sees git-TRACKED files, so a `site/apps.json` written but never `git add`ed
fails the very rebuild it was written for. Hence three states, all reported on
the Settings tab: not a git work tree (daedalus writes and warns); a work tree
with the commit switch OFF (writes and `git add`s, leaves committing to the
human); a work tree with the switch ON (one commit scoped to `-- site/` per
Apply, push best-effort).

**Rollback does not depend on git.** The verb keeps the previous bytes of
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
Users run it as-is. Settings forms come from an in-house renderer over a
constrained JSON-Schema subset (the RJSF spike failed on bundle cost).

**Secrets, end state.** One value per sops file, encrypted **in the container
with public recipients only** (static `sops` binary in the image); no private
key ever in the container; plaintext never reaches a host file.
Multi-key env files are assembled on the host by `sops.templates` with
`restartUnits`. Recipients: the host key via `ssh-to-age` and an operator
recovery age key shown exactly once. Rekey is a root verb running `sops
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
- **App changes ride the lock bump.** The box builds the control plane's
  image as a pre-switch check, so a change that fails to build changes
  nothing, and a bad one rolls back with its generation.
- **Gate before switch** for nix phases: `nixos-rebuild build` → `nix store
  diff-closures /run/current-system ./result` (the diff must list only what
  the phase intends) → `nixos-rebuild test` → the container census
  (`podman ps` before and after, `curl` of every `healthPath`) → `switch` →
  commit + push. Phases that touch `modules/app-db` are marked (pg restart →
  restart pocket-id after).
- **A catalog move is closure-neutral**: the toplevel derivation is
  byte-identical before and after, per stack. `nix fmt` and `nix flake check`
  green in the engine before the commit; `checks.all-modules` is the proof
  that the example host plus every leaf still evaluates.
- No nix phase runs on the same day as an image update or the weekly flake
  autoupgrade (check the timer; disable it for the day).
- An agent release is `agent/gate.sh all` green, a version bump, an annotated
  `agent-v*` tag; the machines self-update within ten minutes and "Update
  now" on Settings › Machines does it at once. The release signing key has
  no recovery path but the operator's copies.

---

## Phases remaining

### Phase 8 — Auth hardening (one rehearsal remains)

Every mutating server function refuses a request whose forward-auth groups do
not name `admins`. What is left is the **break-glass local login**: a setup
token plus a local login (argon2id, sealed session cookie), built and dormant
behind `site.json` `auth.localLogin` (absent on this box, so the route 404s;
not editable from Settings on purpose; the onboarding wizard turns it on for
new installs). It has never been exercised against a real IdP outage. Phase
12's rehearsal is where that happens: stop Pocket ID, reach the login with the
token, apply something, start Pocket ID, confirm the session survives the
gate coming back.

### Phase 9 — Nix literals (nothing left for the engine)

The engine's `nix/` tree names no box. Two facts in the reference host's
private stacks are still a person's handles with no option — `calibre-web`'s
`Remote-User` and LiteLLM's `PROXY_ADMIN_ID` — and get one on the day each
of those stacks moves into the catalog (Phase 11), not before.

Design notes for the moves still to make: option DESCRIPTIONS do not enter
the closure but comments inside shell heredocs do; `fleet.data` names are an
informal contract (`tv`, `books`, `photos`, `minecraft` are read by stacks,
and `books` by three of them); the dataset table and `fleet.data` spell each
mount twice; `builder.nix` silently requires a dataset mounted at its root.

### Phase 10 — App module system and build

- **10a, the last seam.** `ctx.prom`, `ctx.loki` and `ctx.secret` are in,
  and the boundary test refuses a value import of those three clients under
  `src/modules/*/data/`. What a data file still imports from `host/`
  directly — nix-manifest, hosts, workspaces, the contract domains — is the
  rest of the seam (the test's own comment names them).
- **10b, the first tag.** The image builds on every push to `main`, walks
  (`release/image-walk.sh` is run before a tag) and runs this box;
  `.github/workflows/image.yml` publishes to ghcr on a `v*` tag and has
  never published. Publishing the first public image is the operator's
  decision: bump `app/package.json`, add `LICENSE`, tag `v<version>`, push
  the tag. The ghcr package is private until its visibility is changed by
  hand. amd64 only — the run stage holds the build platform's argon2 binary.

### Phase 11 — The engine becomes importable (the leaves remain)

The spine is in the catalog with eight leaves beside it (`nix/README.md`'s
catalog table); a host made from `templates.config` evaluates to a whole
system with a control plane to log in to. What remains:

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
   together (`downloads`, `argus-vpn`, `tv`). Each move: closure diff read
   and stated (import order moves with the file, nix-engine.md §7), pin to
   `host/images.nix`, secrets to `host/sops/<id>/` keeping their basenames,
   policy to `host/modules.nix`, a README beside the module,
   `checks.all-modules` green.

Decisions already taken for the moves, so they are not re-litigated: the
identity interface stays in `platform/identity.nix`; `catalogModules` lists
files, not stacks; what other stacks contributed to a rendered config is a
registry (`fleet.logDrops`, `fleet.logFiles`, `fleet.builder.npmMirrorHost`);
policy without a narrow default has no default (`gatus.allowedSubjects` is
required); no engine-shipped image pins; the reference box pins the engine
through a local clone because it develops it, everyone else through
`github:` and a tag.

### Phase 12 — Onboarding, init, catalog, release (1–2 weeks)

Wizard over the existing pieces (each step re-runnable from Settings);
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
priority; each can be done independently unless noted. The numbers are
stable — code cites them.

1. **Preview deployments — a URL per branch, for vibecoding, testing and
   play.** Push a branch of plutus and a minute later
   `plutus-<branch>.toscanini.me` is running that commit; push again and it
   updates in place; delete the branch (or close the PR) and it is gone.
   Main-only builds today; the seams are in place (`builds.lane`,
   `prNumber`, the `candidate` publish mode, `pull_requests:write` granted).
   Four stages: P1 checks → P2 required check → P3 previews → P4 fork
   policy. The decisions:
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

5. **The image source from Settings.** `fleet.daedalus.source` is a nix
   option the box sets in `configuration.nix`; Settings › Developer shows it
   and nothing flips it. A control there writes `site.json`
   `developer.source` and the option reads it (host-set wins), so moving
   between `local`, `dev` and `published` (once Phase 10b's first tag
   exists) is an Apply, not a hand edit.

6. **Machines as providers.** A box is the cluster; the other machines on
   its network are **providers** that join by approval, are named by the
   box, and offer things the cluster's services consume — a model server
   today, a runner later — with the wiring generated, never typed. The rule
   that sorts every piece: what nix builds from goes in `site/` as JSON;
   what the host needs at runtime and must not be in git (a MAC) is a
   payload the control plane hands a root verb; what a service manages
   through its own API (LiteLLM's model table) is driven through that API.
   **Order of work**, each step usable on its own:
   1. Lemonade managed by the agent — item 14.
   2. Per-model counters from each provider — what the two WIP boards on
      the Providers tab wait for — and GPU figures from the agent.
   3. `pinAddress` gets its switch on Settings › Machines (the policy field
      and the `MAC,IP,name` line exist; no UI yet).
   4. Power verbs (sleep, restart, shut down, wake by magic packet),
      dashboards and sleep-aware alerts, the WIP boards (die temperatures,
      GPU live figures, the AMD driver feed, Homebrew formulae), Authenticode
      when the Windows download button goes live, and the small noted items
      (the EVGA photo, Arc's ProgId, a `powermetrics` deadline).
   5. macOS telemetry from native APIs: a Mac's agent still spawns about ten
      tools every 15 s.
   Not scheduled: a provider on a machine with no agent, added by address
   and port. Runners on the nodes are feature 11's.

7. **Git commit attribution from the signed-in user.** Every `site/` commit
   is authored by "daedalus" regardless of who pressed Apply (no `--author`
   in any verb script). The forward-auth headers carry the operator's
   email; pass the identity through the verb's payload and commit with
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
   and removes one secret at a time through the `secret-set` verb and shows
   "set <date> by <actor>" from git. Still missing:
   - **Convert to secret.** The value moves from `apps.json` into the sops
     file in one Apply; the old plaintext remains in git history, and the
     UI says so. Convert to variable stays deliberately absent — the
     container can never read a secret back.
   - **Rotate the machine-generated ones.** `AUTH_SECRET` and the app's
     database password are "delete the file + rebuild" today (the app page
     says so in prose); a Rotate button per app is one more root verb
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

11. **Self-hosted GitHub Actions runners, managed from daedalus.** The
    Actions page reads every repository the box watches — its apps,
    Settings › Projects, the engine — as the App where it may and as anyone
    where the repository is public. What it still lacks, in order:
    - **Runners themselves.** Runners run CI, never fleet images — the
      box's build path stays the only way an image reaches zot. Ephemeral,
      on demand, per job: subscribe to `workflow_job`; on `queued` with a
      matching label, mint a JIT runner config and start one rootless podman
      container (`--ephemeral`, dedicated uid, resource limits, the
      builder's owner-match egress fence, no secrets beyond the single-use
      JIT token); it takes exactly that job and exits. A second, narrow
      GitHub App (`daedalus-runners`, `administration:write` on opted-in
      repos only, sealed in the same vault). The Runners tab draws the
      design blurred today: a runner defined as a row (machine, labels, CPU
      and memory cap, concurrency), runners now with load, the queue, and
      the month's minutes taken here instead of hosted; each unblurs as its
      mechanism lands. Metrics through `fleet.prometheusScrapes`.
    - **Runners on the other machines, through the agent (item 6).** The
      PC and the Mac as a declared service the agent supervises, the same
      per-job lifetime; macOS jobs are the ones worth moving (ten billed
      minutes per wall minute, and the agent's own release runs there).
      A `gpu` label for jobs that want the model server.
    - **GitHub's own meter.** The billing endpoint needs a user token with
      the `user` scope; a vault entry for one, and the Minutes tab's plan
      board reads the real cycle instead of assuming Free.

12. **Switching a service off: its dependents.** Settings › Modules and each
    module's page switch a module off through `site.json`
    `modules.enabled`, and refuse a structural one by name. Nothing explains
    a module's *dependents* — `app-db` is impossible to switch off, while
    something fifteen stacks read from is merely discouraged.

13. **One agent on every machine, a controller on the box.** What remains:
    - **Deferred: staged updates.** Every agent fetches, verifies and stages
      the newest signed release; applying is a restart the operator triggers
      per machine or for all (System › Machines or an MCP write tool), naming
      a version, never bytes, refusing a downgrade; on the box the lock bump
      is the stage step. The last self-updating release has to carry it.
    - **The box's System page drawn from capabilities** instead of the root
      snapshots, like every other machine's.
    - **Costs.** A santree session host on a machine other than the box
      would be a port, not a recompile — Windows above all (ConPTY, pwsh,
      paths, hook callbacks).

14. **Lemonade managed by the agent.** daedalus installs, updates (a pinned
    version), starts and stops Lemonade on the machines that offer it, and
    the old-version workarounds go. Providers are LAN-only; LiteLLM keeps
    dialling each one directly, so the control plane never sits in the
    inference path. Pools, route parking, keys and a published UI are out
    of scope.
    - **The full official app on every OS**, run the way upstream ships it.
      Windows: the MSI (per-user by default); the server lives inside the
      tray `LemonadeServer.exe` and reads models and settings from the
      profile that runs it, so it serves only while a user is logged in.
      macOS: the `.pkg`'s root LaunchDaemon `ai.lemonadeserver.server` plus
      its tray. Linux: the `.deb`/`.rpm`'s `lemond.service`. Lemonade has no
      self-updater, so a pin holds.
    - **Detection** reads the install itself (Windows `Software\AMD\Lemonade
      Server` in HKCU/HKLM, the package, the pkg receipt), not the app
      inventory. The report gains install method, scope, version (from
      `/health`, never the MSI's `26.40.0`), pid, owning session, startup
      state and the last lifecycle outcome.
    - **Verbs** beside `provider_model` and shaped like it:
      `provider_install {kind, version, url, size, sha256}` and
      `provider_power {kind, wanted}`. The box resolves the asset for the
      node's OS once from GitHub's release API and refuses one without a
      digest; the agent accepts only lemonade-sdk release URLs and verifies
      with `store_verified`.
    - **Install** is a journaled state machine (a reboot mid-install resumes
      or reports): download and verify, keep the previous installer, stop
      gracefully, install silently, wait for `/health` to report the target,
      re-apply `host=0.0.0.0`, the port and `broadcast=false` through
      `lemonade config set`, apply the wanted power state; on failure
      reinstall the previous one (the MSI blocks downgrades, so uninstall
      first). The catalog ids are compared before and after, and a vanished
      offered id is reported (aliases derive from ids). Windows runs msiexec
      in the user's session through the session jobs, so the MSI's relaunch
      runs as the user and not SYSTEM; it adopts the existing scope, refuses
      another user's per-user install, and retries 1618.
    - **Power.** Windows: start `LemonadeServer.exe --silent` in the session
      and check the owning process (the global mutex makes a second launch
      exit 0 silently); stop with `/internal/shutdown`; always-on through
      `StartupApproved\StartupFolder`, which survives the shortcut every
      upgrade reinstalls; a tray Quit is a sticky manual-off until the next
      logon or an operator action. macOS: `launchctl` on the vendor label.
      Linux: `systemctl`.
    - **In daedalus.** `nodes.policy.providers.lemonade` gains `pin`,
      `wanted` and `alwaysOn`. A badge slot on `ModuleRow` and a dot on the
      AI row: green when every wanted server runs, amber for an update, an
      unmanaged install, a stale report or no user session, red when wanted
      and down. AI › Providers per machine: version and update with notes
      (`versionGap`, a tag pattern for `vYYYY.WW.N`), Install/Update behind
      an armed confirm, Start/Stop, always-on, Open Lemonade
      (`https://lemonade-<name>.<baseDomain>`, behind the gate), load/unload, the last outcome
      and its log tail. MCP write tools for install and power.
    - **Fixes.** A failed `/models` read reports an unknown catalog, never an
      empty one (today gateway-sync deletes every route of the node on it).
    - **Order.** The route-wipe fix; detection, the report, the dot and the
      page; the Windows verbs, with the gaming PC moving from 10.8.1 through
      them (if 10.8.1 predates the MSI's upgrade code it reports as
      unmanaged and is uninstalled by hand once); macOS
      and Linux when such a node offers Lemonade.

---

## Operator decisions still open

1. **`~/.claude/projects` transcript pruning.** These transcripts can
   contain secrets a session read. The claude-rc journal keeps its own copy
   ≤1 month (root-only). Open question: exclude or prune them from ZFS
   snapshots/backups.
2. **`--init` as the default in `mkRootlessContainer`.** node as PID 1
   never reaps orphaned grandchildren (yazio leaked a pid per session to
   the 2048 ceiling; plutus had 35 chromium zombies). The apps platform has
   it; the other sixty containers do not, and the general fix is one line
   touching all of them.
3. **Rewriting published history** for the three commits that carried the
   router's retail name in the public engine. Low sensitivity; it is an
   option.

## Owed to the operator

Hand edits the UI cannot make for itself:

1. **The spare release key.** The agent trusts a list of release keys
   (`RELEASE_PUBLIC_KEYS`, `agent/src/node/update/mod.rs`) and lists one. Make the
   spare OFFLINE, never on the box or a runner:
   `openssl genpkey -algorithm ed25519 -out spare.pem`; keep `spare.pem`
   in the password manager only; its public half, as hex, is
   `openssl pkey -in spare.pem -pubout -outform DER | tail -c 32 | xxd -p -c 64`.
   Add that hex as the list's second entry in a release signed with the
   current key; from then on a release signed with the spare that drops
   the first is the way out of a lost or leaked current key.
2. **The first `v*` tag** (Phase 10b, open decision 2) — one
   act, when the operator chooses.

## Engine polish

- **The tunnel under a closed window.** smoltcp ignores the ACK in a segment that arrives outside a closed receive window, so a tunnel consumer that stops reading until its own write completes can stall until `TCP_TIMEOUT` (the test echo did exactly that). santree's pipe reads on its own thread; audit the controller link's read/write pattern over the tunnel, or fix it upstream in smoltcp.
- **Local development behind the request gate.** A laptop run answers 403
  to anything without `X-Proxy-Proof` (CONTRIBUTING.md "The request gate"),
  so a plain browser needs a header extension. A dev-server-only way in —
  say, `pnpm dev` binding a local proxy that adds the proof — would make
  the documented local run work in any browser.
- **The migration history squashed to one baseline.** drizzle's generated
  baseline orders columns differently from the live tables; reorder
  `src/host/schema.ts` to match the live order first, so the squash is a
  no-op against the box.
- **The long forms.** Over 150 lines and worth splitting by section: the
  create Wizard, AppsList, Settings › Network, OperatorSecrets,
  ExternalApps, Tasks, McpTokens; and `modules/system/view/updates.tsx`
  (411 lines, allowlisted in `src/file-size.test.ts` until it splits).
- **CodeQL for Rust** (`agent/`, `session-host/`) beside the
  JavaScript/TypeScript and Actions queries in `ci.yml`.
- TypeScript (`noUncheckedIndexedAccess` and `verbatimModuleSyntax` are
  on): `as` casts that hide narrowing; `satisfies` for config objects and
  exhaustive checks; branded types for app names, sha hashes, build ids and
  node ids; `using` for locks and cleanup (check the Vite plugin supports
  it); assess `exactOptionalPropertyTypes` and `isolatedDeclarations`.
- The engine logs nothing when it re-adopts a running build after a restart.
- The webhook's log line omits the superseded count (the response has it).
- Build-page live log during long checks may appear empty (markers arrive at
  stage boundaries, not mid-stage).
- The lab drivers under `<stateRoot>/shotter/drivers/` (over a hundred, most
  one-off verification scripts) belong in the repo or in the bin, not in app
  state.

## Documentation

- **Root verb payload reference.** The payload shapes of the verbs in
  `ARCHITECTURE.md`'s root helper table have no standalone doc beyond the
  code and each verb script's validation.
- **Operational runbook** for the build pipeline beyond what `BUILDS.md`
  covers — what to do when a build hangs, how to force-rebuild, how to read
  the build log, how to cancel.
- **An install guide** for a stranger's box (Phase 12).

## Verification owed

- A `just census` target in the config repo: `podman ps` census,
  `systemctl --failed`, every `healthPath` curl, and a `diff-closures`
  helper; it would also restart pocket-id after a pg bounce, which nothing
  re-checks today.
- The no-secret-in-logs test: `lib/redact.test.ts` covers error text and
  the `secret-set` verb; nothing asserts that no vault value or verb
  secret appears in status files, build logs or the app's stdout. Write it
  as a fixture-driven test and add it to CI.
- The break-glass drill (Phase 8) and the fresh-box rehearsal (Phase 12).
- Standing practice: closure diffs and the census after every nix phase;
  container truth, not unit state; `shot` drivers with `events.json`
  read before pictures; an authz test beside every new mutation.

## Security residuals

Known and accepted, not forgotten:

- A build step that escapes its sandbox lands as `buildkit` — the daemon
  user, which can see the zot push credential the buildctl session passes.
  Mitigations: rootless user namespace, the egress fence, `builder` has no
  delete permission.
- A repo's own mise cache can carry files into its next `railpack prepare`
  (per-build cache copy or a throwaway uid are the candidates).
- A hostile base image's ONBUILD cache mounts are invisible to the scan (all
  seven apps are Railpack, so this is theoretical).
- Repo rename should be carried by id, not name (the clone and three GitHub
  hyperlinks still resolve by name).
- Dataset mount failure alert is silent — `daedalus-builds-mounted` checks
  hourly and mails, but the mount itself is `nofail`.
- The container writes two directories the operator's units read
  (`/workspace-icons` for the session host, `/boards` for a host job);
  each could be a controller call instead, leaving the container no
  writable host path.
- A stolen node key is a stolen link: its holder can report as that
  machine and receive its commands, not run arbitrary ones, as long as "no
  shell" holds. Revoking the key in Settings › Machines ends it.

---

## Not in v1

Out-of-tree modules; multiple domains or non-wildcard certs; alternative
proxy/IdP/DNS; ISO installer and nixos-anywhere; third-party app stores;
Cloudflare Access; Cloudflare account/Zero Trust org creation (no public API);
Registrar API (beta); generated-secrets-as-sops (Clan-vars style) — later;
`fetchPnpmDeps` nix package as an alternative to the image; non-flake configs;
engine-shipped image pins; a site repository separate from the config; Mermaid
rendered on the website. After evaluating Coolify: no second container
engine, no control plane whose state lives outside git, no
one-container-per-database model. No Rust rewrite of the app's backend — the
app holds no privilege and does no OS work in-process, so its latency is I/O
and hydration, not JavaScript; Rust belongs in the agent, where the OS layer
is.

## Risks

- TanStack Start is still "RC" by its own docs; pin exact versions. Its build
  is stricter than its dev server: a client file that reaches
  `@tanstack/react-start/server` through any import is refused at build and
  never in dev, so `pnpm build` belongs in the check every change runs.
- The controller is critical (down means no machines on the pages and no
  Apply): small, restarts cleanly, holds nothing it cannot rebuild.
- Previews (feature 1) run branch code with a copy of production data on the
  same box: the preview env allowlist and the fork-approval gate are what
  keep that safe, and both must exist before previews are on by default.
- The weekly `flake.lock` bump can move nixfmt and leave `/etc/nixos`
  treefmt-dirty, which fails `nix flake check`; check after every
  autoupgrade. `nix fmt -- --ci` writes before it fails.
- The agent's release signing key covers three OSes and has no recovery path
  but the operator's copies; losing it means every machine must be
  re-enrolled with a new compiled-in key (the spare key, Owed 3, closes
  this).
