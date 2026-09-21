---
paths:
  - "nix/**"
  - "flake.nix"
---

# The engine's nix — `nix/**` and `flake.nix`

This tree is the OS half of daedalus: `nix/platform/**` (the base every
stack rides on — container runtime and its helpers, the publish layer,
site constants, secrets, ZFS, backup, mail, git, the weekly upgrade),
`nix/stacks/daedalus/**` (the control plane's own module, `self.json`, the
host agents in `host/*.sh`, the runtime image context in `assets/`),
`nix/modules/<id>/**` (the catalog: stacks that have migrated here, each
behind a switch that defaults OFF — §7) and `nix/tests/minimal-host/` (a
stranger's smallest host, evaluated by `nix flake check`).
`flake.nix` exports it as `nixosModules.{platform,daedalus,catalog,default}`
and `lib.path`. Its MODULES take nothing from the flake's inputs — the host
picks the nixpkgs they are evaluated against and imports sops-nix beside
them; the inputs serve `nix fmt` and the checks only.

A real machine runs on this tree. It is imported into the operator's own
configuration flake as an input pinned by rev, so nothing here reaches a
box until that lock is moved on purpose — but once it is, a mistake here
is a mistake in someone's bootloader, firewall or backups.

Stack authoring (the `fleet.*` option reference, the stack template, the
enable-switch rules, rootless uid mapping) is NOT duplicated here: most
stacks still live in the operator's private configuration, and so does
their reference (`.claude/rules/module-system.md` in that repo). What
follows is what is particular to editing the ENGINE.

## 1. Public: no box identity, anywhere

This tree is published — a public repo. It never spells a user, a domain, a
hostname, a LAN address, a pool or dataset name, a person, an e-mail, a
GitHub account, or the path of one operator's checkout — not in code, not
in a comment, not in an option `description` or `example`, not in a shell
script under `host/`. Read the option instead:

| Instead of spelling… | read |
|---|---|
| the admin's login, uid, home, runtime dir | `config.fleet.operator.{user,uid,home,runtimeDir,userService,group}` |
| an author on a commit the box makes | `config.fleet.operator.{gitName,gitEmail}` |
| the domain, or a service's URL | `config.fleet.baseDomain`, `config.fleet.webApps.<n>.hostname` |
| the machine's name | `config.networking.hostName` |
| the LAN address / NIC / router | `config.fleet.{lanIp,lanInterface,gateway}` |
| the public name | `config.fleet.wanHost` |
| where the config checkout is | `config.fleet.config.repo` (RUN-TIME only — eval never reads through it) |
| where container state lives | `config.fleet.stateRoot`, `config.fleet.machineState` |
| a bulk-data directory | `config.fleet.data.<name>` |
| a pool or dataset | the keys of `config.fleet.zfs.datasets` / `fleet.backup.replications` |
| the GitHub account | `config.fleet.github.owner` |
| a mailbox | `config.fleet.mail.{sender,alertTo}` |

Examples use `example.org`, `alice`, `tank/…`, RFC 5737 / RFC 1918
documentation addresses. Before committing, grep your diff for the
operator's real values — the reviewer will.

**Comments are not all equal.** A `#` comment in a `.nix` file and an
option's `description`/`example` do NOT enter the built system: change
them freely, the closure is identical. A comment INSIDE script text — a
`''…''` heredoc, a `pkgs.writeShellScript` body, anything under `host/` or
`assets/` that is `readFile`d or copied — IS part of a derivation: editing
it changes the store path, restarts the unit that embeds it, and ships the
words to every box. So identity scrubbed from script text is a real
(if harmless) rebuild, and "comment-only" is not a reason to skip the
build gate for those files.

## 2. The engine DECLARES, the host DEFINES

An option whose value is a fact about one box is declared here **without a
default**, so a host that forgets it fails evaluation with the option's
name instead of inheriting someone else's answer. Do not add a default to
make an example evaluate; do not add a default that is "this box's value".
A default is right only when it is derivable (`home` from `user`) or
genuinely universal (`group = "users"`, SMTP port 587).

What a host must define today (`mkOption` with no `default`, outside
submodules) — keep this list true when you add one:

Defined directly in the host's configuration:

- `fleet.operator.user` — login of the one non-root admin; owns the rootless containers, the state tree and the checkout.
- `fleet.operator.uid` — that user's uid; container uid 0 maps to it.
- `fleet.operator.email` — the OIDC `email` claim apps match their admin on.
- `fleet.operator.gitName`, `fleet.operator.gitEmail` — author of the commits the box makes (weekly lock bump, Apply).
- `fleet.config.repo` — where the configuration checkout lives on disk (run-time path).
- `fleet.github.owner` — the GitHub account the app repos live under.
- `fleet.github.expectedOwnerId` — that account's numeric id; the one copy the control plane cannot rewrite.
- `fleet.data` — `attrsOf str`, name → absolute path of each bulk-data root outside `stateRoot` (`{ }` is a valid answer if no enabled stack reads a name).
- `fleet.mail.smtpHost` — the SMTP relay.
- `fleet.mail.passwordSopsFile` — sops ciphertext (binary) of the relay password.
- `fleet.git.sshKeySopsFile` — sops ciphertext (binary) of the SSH key the box pushes to its forge with.
- `fleet.daedalus.serviceKeysSopsFile` — sops dotenv of the read-only API keys the control plane reads other services with.
- `fleet.gluetun.image`, `fleet.gluetun.exporterImage` — digest-pinned images for `mkGluetunInstance`; forced only when a host builds a tunnel (see §4).
- `fleet.images.<container>` — the digest-pinned image of every container of every catalog module the host switches on (§4, §7). `pinnedImage` throws naming the missing key.
- `fleet.modules.apps.enable = false` — TEMPORARY, and not a host fact: the apps stack (what turns `fleet.apps.<n>`, the control plane's own entry included, into a container) has not migrated, so a host with only the engine has nothing behind that switch. Goes away with `nix/modules/apps`.
- `fleet.site.source` — has a `null` default, but null fails evaluation on purpose: the host sets `./site`.

Defined FROM the host's `site/site.json` by `platform/site.nix` (the
option has no default; the document is the definition — a host without
the key fails eval):

- `fleet.baseDomain` ← `identity.baseDomain`; `time.timeZone` ← `identity.timezone`.
- `fleet.lanIp`, `fleet.wanHost`, `fleet.gateway`, `fleet.dnsUpstreams` ← `network.*`; `fleet.lanInterface` ← `network.interface`.
- `fleet.dhcp.{active,router,start,end,leaseTime}` ← `network.dhcp.*`.
- `fleet.mail.{sender,alertTo}` ← `mail.*`.
- `fleet.cloudflare.{accountId,tunnelId,zoneId}` ← `cloudflare.*`; `fleet.cloudflare.tokenEnvFile` is rendered by the engine from `site/vault/cloudflare-api-token.sops`, which must exist.
- asserted equal, not yet sourced: `identity.hostname` = `networking.hostName`, `identity.owner` = `fleet.github.owner`, `identity.operator.user` = `fleet.operator.user`.
- `site/apps.json` must exist (`fleet.registry.file`).

Optional, null/empty by default, host-defined when wanted:
`fleet.claude.mcpSopsFile`, `fleet.hcPing.keySopsFile`,
`fleet.zfs.datasets`, `fleet.zfs.arcMaxBytes`, `fleet.backup.replications`,
`fleet.autoupgrade.inputs`.

Re-derive the list rather than trusting it:

```
grep -rn 'mkOption' nix --include=*.nix      # then read each block for `default`
```

Host data arrives three ways, in this order of preference: a `site.json`
key (anything an operator should edit from the UI), a `fleet.*` option the
host's configuration defines (hardware, storage, identity), a **path the
host hands in** (`*SopsFile` — the engine carries no box's ciphertext, and
a secret's basename is part of its store path, so don't rename what a
host passes).

## 3. By-path libraries live in `nix/platform/lib/`

`gluetun-lib.nix`, `fleet-lib.nix`, `registry-lib.nix`,
`operator-secrets-lib.nix`. They are plain functions imported by path,
never listed in a module import list and never exported as modules.
Why by-path and not `_module.args`: every `_module.args` on this design is
defined in `platform/podman.nix`, and a module that defines
`_module.args` cannot itself consume a custom arg; consumers that force a
library inside a top-level `config = lib.mkMerge` would recurse the same
way.

Inside the engine, import them relatively. A HOST stack reaches them as
`import (enginePath + "/platform/lib/<x>-lib.nix")`, where `enginePath` is
a `specialArg` the host sets to `"${daedalus}/nix"` (it is used at import
time, before `_module.args` exist). That makes a library's argument list
and return shape a public interface: changing one breaks stacks this repo
cannot see. Add, don't rename.

`flake.nix`'s module lists (`platformModules`, `daedalusModules`,
`catalogModules`) are explicit and alphabetical. A new
platform module is a new line there AND a line in the host's own import
list (see §6) — a tracked file named in neither is silently absent.

## 4. No oci-container digest pins here

The control plane's image-update agent rewrites a `:tag@sha256:…` literal
IN PLACE in the `.nix` file that holds it, inside the operator's
configuration checkout. It cannot write into a read-only flake input, so
a pin under `nix/` would never move and its Updates row would fail. An
engine module that needs a pinned image declares an option with no
default and an `example` (`fleet.gluetun.image`, for a library) or — every catalog
module — reads `pinnedImage "<container>" "<upstream repo>"`, which
resolves `fleet.images.<container>` and fails evaluation naming the key
when the host has not defined it. The host keeps all of them in one file
(§7). The name `fleet.imagePins` is taken: it is the read-only PARSED
view of every pin (`platform/export.nix`) that the Updates page and the
agent read; `fleet.images` is the host-written input.

Two pins here are NOT `virtualisation.oci-containers` images and are
bumped by hand, as ordinary engine commits: `nodeImage` in
`stacks/daedalus/build-agent.nix` and `railpackFrontend` (with the
Railpack release hashes) in `stacks/daedalus/railpack.nix`.

## 5. The dev loop

This repo has exactly ONE branch, `main`, always — `nix/`, `flake.nix`,
`flake.lock` and `statix.toml` sit at its root beside `app/`, and it is
published. Never create another branch or a second worktree for nix work.
On the operator's box the clone is also bind-mounted into the running
control plane, where a save under `app/` is a live deploy; the dev server
does not watch `nix/`, so nix work in the same checkout is safe — but
**never touch `app/**` while doing it**, and stage by path
(`git add nix flake.nix flake.lock`), never `git add -A`.

1. Edit here. `git add` new files — a flake sees only TRACKED files, in
   this repo exactly as in the host's.
2. Iterate without committing, from the host's configuration checkout:
   `sudo nixos-rebuild build --flake <config> --override-input daedalus path:<this clone>`.
   `build` only — never `test`/`switch` an override; the generation would
   run an engine state no commit holds. A `path:` input copies the
   directory as it stands, untracked files included, so a green override
   is not proof the commit is complete.
3. `nix fmt` + `nix flake check`, `git commit` on `main`, then
   `git push origin main`. Pushing is the normal step: a host's lock
   should only ever name a rev that a fresh clone contains.
4. In the host's configuration: `nix flake update daedalus`,
   `git add flake.lock`, then its usual `nixos-rebuild test` → verify →
   `switch` → commit + push. The host's input is
   `git+file://<this clone>?ref=main`: it reads COMMITS of `main`, so an
   uncommitted edit builds nothing.
5. The host's weekly upgrade names the inputs it moves
   (`fleet.autoupgrade.inputs`) and the engine is not one of them. An
   engine change reaches a box only by step 4.

The gate for a refactor that should change nothing: the host's
`nixos-rebuild build` yields the SAME `system` store path before and
after. For everything else, say in the commit what changes in the closure
and why.

Before every commit: `nix fmt` and `nix flake check` at the repo root
(nixfmt, statix, deadnix — the settings the host's configuration uses;
`statix.toml` is beside `flake.nix`). `git add` first — a flake sees
tracked files only. The `nix` job in `.github/workflows/ci.yml` runs the
same two commands, so a push that skips them goes red. (The host's
`nix fmt` does not reach a flake input; this is the only formatter gate
this tree has.)

## 6. Things that bite

- **Import order is part of the closure.** List-typed options
  (`prometheusScrapes`, firewall ports, `assertions`) concatenate in
  module order. The reference host still names every engine module one
  by one through `enginePath`, with the daedalus stack in its
  alphabetical slot among that host's own stacks, precisely so the move
  into this repo reordered nothing. Appending a module is safe;
  reshuffling `platformModules`/`daedalusModules`, or switching a host to
  `nixosModules.default`, changes derivations — do it deliberately,
  alone, and say so.
- **`platform/` modules carry no enable switch** — they are the base.
  `stacks/daedalus` is behind `fleet.modules.daedalus.enable`. `options`
  blocks are never gated; only `config` is.
- **The control plane never reaches into a stack.** What a stack shows it
  arrives through `fleet.dashboard.<id>` and `fleet.export.domains`,
  contributed inside the owner's own `mkIf`. `daedalus.nix` must
  evaluate with every host stack switched off, and with stacks it has
  never heard of.
- **`nixpkgs-unstable` is a `specialArg` two modules ask for**
  (`platform/claude-code`, `stacks/daedalus/builder.nix`). The modules take
  nothing from this flake's inputs, so the host must hand it in (the
  `nixpkgs-unstable` input here feeds only `checks.minimal-host`); say so in `nix/README.md` if you
  add a third.
- **Every container unit is `Type=oneshot` + `RemainAfterExit`** (rootless
  podman cannot do notify). A green unit proves nothing about the
  container; never "fix" it with `sdnotify = "healthy"`.
- **Eval is pure.** `fleet.config.repo` and `fleet.site.path` are run-time
  strings for units and agents; the module side reads `fleet.site.source`
  (a store path). Never `builtins.readFile` through a run-time path.
- **`host/*.sh` are the privileged half.** They run as root or as the
  operator on a file-drop from the app; the app's TypeScript side of each
  bridge is in `app/src/host/`. Changing a verb's contract is a change in
  both places, and the app side deploys on save while this side waits for
  a lock bump — land the tolerant reader first.
- **Every commit moves the whole input.** A host sees this repo as one
  store path, and a module that embeds a path into it (`${./host/x.sh}`,
  a `readFile`d asset's directory) embeds that store path. So at the next
  lock bump, units that carry such a path restart even when the commit
  only touched a README. Batch doc-only commits with a real change, or
  accept the restarts; don't be surprised by them.

## 7. Migrating a stack — `nix/modules/<id>`

A stack leaves the operator's configuration for this tree one at a time.
`modules/stirling-pdf` is the template; read it beside this list. The
gate for every move is §5's: the reference host's `system` derivation is
IDENTICAL before and after, and `nix flake check` — which evaluates
`nix/tests/minimal-host` — stays green.

**Where it goes.** `nix/modules/<id>/<id>.nix`, assets in
`nix/modules/<id>/assets/`, one line in `flake.nix`'s `catalogModules`.
The switch `fleet.modules.<id>.enable` moves with it and **defaults to
`false` here** (it defaulted to `true` in the host): `nixosModules.default`
imports the whole catalog, and a stranger must not get forty services for
importing the engine. The host turns it on in its own `host/modules.nix`.
History does not cross repositories: copy the file, `git rm` it there.

**Same slot.** The host imports the moved file through `enginePath` in
the SAME position of its import list the local file had — list-typed
options concatenate in import order (§6). A new options-only file
(`platform/registries.nix`, `platform/apps-options.nix`) can go anywhere:
declarations contribute no list elements.

**The image pin stays with the host.** §4. The module writes
`image = pinnedImage "<container>" "<registry>/<repo>";` and the host
defines `fleet.images.<container>` — the full literal
`repo:tag@sha256:digest` — in ONE file, `host/images.nix`. Why one map
keyed by container rather than an option per module: the key is the one
the update machinery already uses end to end (`fleet.imagePins`,
`fleet.imageUpdates`, the update request's `container`); a module with
five containers needs no five declarations; and the agent
(`stacks/daedalus/host/image-update.sh`) finds a pin by `grep -F` on its
digest across the host's `.nix` files and refuses a digest present in
two files — a single home makes that structurally true. A shared
version variable (two containers on one release) is a `let` in that
file. `fleet.imageUpdates.<container>` policy (lockstep, ceremony,
updatable) is mechanism knowledge about the image and moves WITH the
module.

**Policy is the host's, mechanism is the module's.** Mechanism: which
upstream image, ports, mounts and their uids, env that makes the app work
behind the gate, the health path, bridge memberships, which registries it
writes. Policy: who may log in, under what name it is published, whether
it is reachable off-LAN, resource caps, schedules, retention, anything
that names a person, a group or a place. A policy value the module author
anticipates becomes an option under `fleet.modules.<id>` whose default is
the NARROWEST answer (`authGroups = [ "admins" ]`, `exposeRemotely =
false`) — never the reference household's. Policy nobody anticipated
needs no option: the registries merge, so a host may define
`fleet.webApps.<id>.<field>` directly, inside
`lib.mkIf config.fleet.modules.<id>.enable` (a bare definition with the
module off creates a half-declared entry). The hostname label needs
nothing: `fleet.webApps.<n>.hostname` defaults to `<n>.<baseDomain>`.

**Secrets.** A stack's operator-managed `env.sops` is host data, like the
platform's four: it stays in the host at `host/sops/<id>-env.sops` and
reaches the module through `fleet.modules.<id>.envSopsFile` (`path`, no
default — forced only when the switch is on, so a host that leaves the
module off owes nothing). The module calls `mkDotenvSecret` on it. Keep
the basename on the first move: it is part of the store path sops-nix
builds its manifest from, so a rename is a (harmless) closure change —
do it separately from the move, never in the same gate. Machine-generated
state needs no convention: it is born under `fleet.machineState`.

**Assets that another stack looked up by name move with their owner.**
The template's case: the identity provider's stack found each client's
logo as `assets/logos/<client>.png` in ITS directory. The migrated module
carries its own (`assets/<id>.png`, same basename — a single file's store
path is its name and content, so the move is closure-neutral) and sets
`fleet.ssoClients.<id>.logo`; the host's directory stays as
`fleet.sso.logoDir` for the stacks it still keeps.

**Registries: the declaration comes first.** A module can only write a
registry this tree declares. If its owner is still a host stack, move the
`options` declaration — ungated, unchanged — into
`platform/registries.nix` (or a file of its own when it is large:
`platform/apps-options.nix`), and leave the `config` half where it is. A
let-bound constant the declaration shared with its implementation becomes
a read-only option both read (`fleet.sso.renderDir`), not a second copy.
Never stub a registry in `tests/minimal-host`.

**`mkIf` on another stack's container goes one level up.**
`containers.<x>.volumes = lib.mkIf cond […]` still creates `<x>` — an
`attrsOf submodule` entry exists as soon as any attribute path reaches
it — and a container with no image fails evaluation. Write
`containers = lib.mkIf cond { <x>.volumes = […]; }`.

**Scrub.** §1 applies to every comment, description and example that
comes across — a person, a domain, a hostname, a LAN address, a pool, the
household's group names, the names of the operator's own apps. `#`
comments and descriptions are closure-neutral; text inside a script is
not (§1).

**Prove a stranger can enable it.** Add the module to
`nix/tests/minimal-host/host.nix` with its switch ON and a placeholder
`fleet.images.<container>`. That host runs no reverse proxy and no
identity provider, so this also proves the module evaluates when the
registries it writes have no implementation behind them.
