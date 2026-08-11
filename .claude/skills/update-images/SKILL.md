---
name: update-images
description: Audit digest-pinned container images in /etc/nixos, research updates + changelogs in parallel, let me pick, then apply + rebuild + validate — and report what the new versions let us simplify
argument-hint: [optional stack filter, e.g. "tv" or "monitoring immich"]
---

# /update-images — container image update audit + apply + adoption review

You are updating the digest-pinned OCI images declared in `/etc/nixos` on
s2-server. Follow CLAUDE.md rules at all times: declarative-only, `git add`
before rebuild, `nixos-rebuild test` before `switch`, confirm before anything
destructive. Edit `/etc/nixos` files with the normal Edit tool; never leave
backup copies inside the repo (`git add -A` would sweep them into the flake —
git itself is the backup).

This skill has **two deliverables**, both required:

1. the image updates themselves (Phases 0–5), and
2. an **adoption review** (Phase 6) — what the new versions let us *change
   about our own config*: shims that became unnecessary, options we set that
   are now deprecated, features we hand-roll that are now first-class. The
   update is routine; the adoption review is where the value compounds.

If `$ARGUMENTS` is non-empty, treat it as a whitespace-separated list of stack
names and restrict the whole run to images declared in
`/etc/nixos/stacks/<name>/` for those stacks.

## Phase 0 — Inventory (inline, fast)

Build the image inventory yourself (no subagent):

```bash
grep -rn -E 'Image *=|image *= *"' /etc/nixos/stacks /etc/nixos/platform | grep -vE '\.sops|lib\.mkOption'
```

Also resolve indirections — some images are `let`-bound variables
(`gluetunImage` in `platform/common.nix`, `pgImage` in `stacks/app-db/`,
`immichVersion`/`immichPostgresImage` in `stacks/immich/`). The grep above
catches the string definitions; map each back to the container(s) using it.

Classify every entry into exactly one bucket:

1. **Version-pinned** — `repo:<version-tag>@sha256:...`. The normal case.
   Update = newer tag + its digest.
2. **Moving-tag-pinned** — tag carries no version (`latest`, `main-stable`,
   `jvm-stable`, `cpu`, `alpine`, `9`, `8`) but digest freezes it. Update =
   re-resolve the SAME tag's current digest; version delta must be recovered
   from image labels (see Phase 1).
3. **Unpinned** — tag but no `@sha256:` (e.g. `quay.io/prometheuscommunity/postgres-exporter:v0.20.1`).
   Update = newer tag, AND offer to add a digest pin while touching the line.
4. **Locally-built (`localhost/*`, via `mkLocalImage`)** — the `localhost/`
   tag is generated, but every one of these builds `FROM` a digest-pinned
   upstream base (or a pinned source rev). **That base is in scope** and is
   audited exactly like any other pinned image; bumping it changes the
   build-context hash, so `mkLocalImage` mints a new tag and restarts the
   consumer automatically. Current bases: `nextcloud:<major>` (nextcloud-ffmpeg),
   `verdaccio/verdaccio` (verdaccio-openid), `postgres:<ver>-alpine`
   (pg-pgvector), `myoung34/github-runner` (gha-runner). Also check the
   pinned npm/source deps these contexts carry (e.g. `verdaccio-openid@<ver>`,
   `pgvector` tag, the litellm-pgvector `fetchFromGitHub` rev) — same audit,
   same report.

   **Nextcloud specifically — minor and patch bumps ARE in scope for this
   skill.** `nextcloudVersion` holds only the major (e.g. `"34"`); the
   actual point release is frozen by `nextcloudBaseDigest`. Re-resolving
   `nextcloud:<major>` to its current digest moves 34.0.1 → 34.0.2 and is a
   normal patch update — apply it here. Read `NEXTCLOUD_VERSION` out of the
   image config to name the versions (the OCI version label is empty):
   `skopeo inspect --config docker://docker.io/library/nextcloud:<tag> | grep NEXTCLOUD_VERSION`.
   **Only a MAJOR bump** (34 → 35: `nextcloudVersion` itself changing) is out
   of scope — that one is a dedicated session with the post-upgrade `occ`
   chores. Either way, if the release notes name an `occ` step, surface it as
   a Phase 6 class-D finding; the rebuild does not run those.
5. **Out of scope — skip and say so in the report**:
   - A Nextcloud **major** bump (see above).
   - Apps-platform images (the box's own registry / `ghcr.io/santiagotoscanini/*`)
     — the platform auto-deploys these every 2 minutes; never touch.

Produce a table: container name | stack | file:line | registry/repo | current
tag | current digest (short) | bucket.

## Phase 1 — Research (parallel subagents)

Spawn **general-purpose subagents in parallel, all in one message** — one
agent per group of 4–6 images, grouped by stack so related images (e.g. the
whole TV stack, or immich server+ML+postgres) land in the same agent. Each
agent gets its slice of the inventory table, **a scratchpad file path to write
its raw findings to** (`<scratchpad>/research-<group>.md` — Phase 6 reads
these instead of re-fetching anything), and these instructions verbatim:

> For each image you were given, determine and return:
>
> 1. **Latest stable version.** Use
>    `nix run nixpkgs#skopeo -- list-tags docker://<registry>/<repo>` and
>    pick the newest *stable* tag matching the current tag's scheme (respect
>    suffix conventions: linuxserver `-lsNNN` builds, `-alpine` variants,
>    immich `-openvino`, `v` prefixes). Ignore alpha/beta/rc/nightly/develop
>    tags. If tag listing is huge, filter with grep before sorting with
>    `sort -V`.
>    **Do NOT cross a major version boundary for any postgres image — report
>    the newest tag within the current major (e.g. 16-alpine stays 16-alpine,
>    18.4 → newest 18.x) and separately note the newest major available.**
> 2. **The new digest** for that tag:
>    `nix run nixpkgs#skopeo -- inspect --no-tags --format '{{.Digest}}' docker://<registry>/<repo>:<tag>`
>    (this is the manifest-list digest — exactly what goes after `@` in nix).
> 3. **For moving-tag-pinned images**: resolve what version the CURRENT digest
>    and the NEW digest each correspond to, via
>    `skopeo inspect docker://<repo>@sha256:<digest>` and reading
>    `org.opencontainers.image.version` / `.revision` labels. If the old
>    digest is gone from the registry, say so and infer from dates.
> 4. **Changelog between current and latest.** Find the source repo from the
>    `org.opencontainers.image.source` label, or web search. Fetch the GitHub
>    releases / CHANGELOG covering the span between the two versions.
>    Summarize in ≤5 bullets: notable features, fixes, and **every breaking
>    change / migration step / config deprecation, flagged explicitly**.
>    For linuxserver images, changelog the UPSTREAM app version delta (e.g.
>    qbittorrent 5.2.3 → 5.3.x), not the -lsNNN packaging number.
> 5. **Risk grade**: `patch` / `minor` / `MAJOR` / `unknown` (semver delta of
>    the app itself), plus a one-line "what could break" note.
> 6. **Adoption signals** — the part that outlives this update, so read the
>    release notes for it deliberately rather than skimming. Extract every
>    line that says *"you can now do X natively"* or *"Y is deprecated"*:
>    - config options / env vars / CLI flags that were **added, renamed,
>      defaulted differently, deprecated or removed** (record the old→new
>      mapping; "will be removed in a future release" counts)
>    - features that make an **external shim unnecessary**: native OIDC/OAuth,
>      built-in `/metrics`, a health endpoint, a real `HEALTHCHECK`, built-in
>      backup / prune / scheduler, an absorbed sidecar container, an official
>      image variant that replaces a locally-built one
>    - new **endpoints, APIs or image labels** worth wiring into anything
>    - anything the notes call a **required post-upgrade step**
>    Quote the release-note line and link it. Report upstream facts only — you
>    have not seen our config, so do not speculate about what we should change.
>
> Return a compact markdown table + per-image changelog bullets + the adoption
> signals. Raw data only — no prose padding. If a registry query fails, retry
> once, then report that image as "could not resolve" with the error; never
> guess a digest.
>
> **Also write your complete findings** (table, changelog bullets, adoption
> signals, source links) as markdown to the scratchpad path you were given.
> Keep the quotes and links intact there even if you summarize in your reply —
> a later phase reads that file and cannot re-fetch cheaply.

While agents run, do nothing else with the nix files.

## Phase 2 — Report + selection

Aggregate into ONE report, sorted riskiest-first, with columns:
container | current → proposed | risk | breaking-change flag | 1-line summary.
Below the table, per-image changelog bullets for anything `minor` or above.

Keep this report about the **update decision**. Hold the adoption signals for
Phase 6 — with one exception: a deprecation that means *taking this bump
requires a config change* belongs here, in the breaking-change flag, because
it changes what the user is agreeing to.

**Overlay these box-specific warnings on top of whatever the agents found**
(they apply even if the changelog looks clean):

| Image / group | Warning |
|---|---|
| Any `postgres:*` (app-db's pg-pgvector base, immich's `immich-app/postgres`) | Major bump = `pg_upgrade` dance + the 70-vs-105 UID/tmpfiles trap if the alpine/debian base changes. Only ever propose same-major updates here; list newer majors as "available, needs a dedicated migration session". |
| `nextcloud` base digest | Point releases (34.0.1 → 34.0.2) are ordinary updates — apply them. Edit `nextcloudBaseDigest` only, leaving `nextcloudVersion` alone. The image entrypoint runs `occ upgrade` itself on start, but any `occ db:*` / `maintenance:repair` step the notes name is NOT run by the rebuild — surface it. A major (`nextcloudVersion` change) is out of scope. |
| `immich-server` / `immich-machine-learning` / `immich-app/postgres` | Server+ML share `immichVersion` — must move in lockstep (one edit on the variable). Check the Immich release notes for a required postgres image bump; Immich majors routinely have breaking migration steps. |
| `gluetun` (`platform/common.nix` + argus-vpn) | Owns the netns for the entire TV stack (+ argus's own instance). Updating it restarts gluetun and every dependent container must be restarted after it. VPN drops during the bounce. |
| `factorio` (ofsm) | Live players; a version bump can force a save migration. Restart kicks everyone. Always confirm timing. |
| `traefik` | Fronts EVERYTHING. Majors change config syntax; even minors: re-run the smoke test immediately. |
| `wg-easy` | v15 had a config-migration; check migration notes on any bump. |
| `pihole` | Native NixOS service, not a container — not in scope here (its downtime kills LAN DNS anyway). |
| `valkey`/`redis` | Major bumps can change RDB/AOF format compatibility — flag. |
| `grafana` | Majors can break plugins/provisioned dashboards. |

Then ask with **AskUserQuestion** (don't paste-and-wait). ~35 images won't
fit in option lists, so ask by tier, `multiSelect` where sensible:

- Q1 "Safe updates (patch + packaging-only)": options "Apply all N" /
  "Skip all" (user can use Other to cherry-pick by name).
- Q2 "Minor updates": same shape.
- Q3 "MAJOR / breaking-flagged updates": one question **per risky image or
  lockstep group** if ≤4 of them, otherwise multiSelect list of names.
  Never bundle a major into an "apply all".

The user has said they'll often take breaking updates anyway — your job is to
make sure they do it *knowingly*, not to talk them out of it.

## Phase 3 — Apply (only what was selected)

1. **Pre-pull** every new image first (as santiago, no sudo) so the container
   bounce is seconds, not minutes:
   `podman pull <registry>/<repo>:<tag>@sha256:<newdigest>` — parallelize
   with `&`/`wait` in one Bash call. A pull failure here aborts that image's
   update before anything was edited.
2. **Edit each pin with the Edit tool.** Digests are globally unique, so the
   old `tag@sha256:...` string is a safe unique match; replace it with the
   new `tag@sha256:...`. For immich, edit the `immichVersion` variable plus
   each digest. Verify every edit with `git -C /etc/nixos diff --stat` + a
   grep for each new digest (count must equal number of edits).
3. `git -C /etc/nixos add -A` (as santiago, no sudo).
4. `sudo nixos-rebuild test`.

## Phase 4 — Validate

The digest change rewrites each unit's ExecStart, so affected containers
restart on the rebuild. For EACH updated container:

- `podman inspect <name> --format '{{.ImageDigest}}'` → must equal the new
  digest (for gluetun: then restart every netns-dependent unit —
  `sudo systemctl restart podman-{qbittorrent,nzbget,flaresolverr,prowlarr,radarr,sonarr,bazarr,subgen,shelfmark,gluetun-exporter}` — and re-verify).
- `systemctl --failed` must be clean (remember `Type=oneshot` units can sit
  `active (exited)` over a dead container — check `podman ps` too).
- `podman logs --since 5m <name> | tail -30` — no crash loops, no migration
  errors (container output is NOT in journald — CLAUDE.md Debugging
  protocol). **Also scan for the container's own deprecation complaints** —
  the cheapest, least ambiguous adoption evidence there is, and it only
  exists in this window:
  ```bash
  podman logs --since 15m <name> 2>&1 \
    | grep -iE 'deprecat|no longer (supported|used)|will be removed|has been renamed|obsolete|unsupported (option|config)|legacy' | head -5
  ```
  Keep every hit — it goes into Phase 6 as class-A evidence.
- If it has a `webApps` hostname:
  `curl -sk --resolve <host>:443:192.168.0.2 -o /dev/null -w '%{http_code}' https://<host>/`
  → expect 200/30x/401, not 5xx (services running DB migrations may need
  30–60 s; retry twice before declaring failure).

**On failure of any container**: revert only its line (Edit the old digest
back, or `git -C /etc/nixos checkout -- <file>` if it was the only change in
that file, then re-add), `sudo nixos-rebuild test` again, confirm the service
recovered, and report the failure with the log excerpt. Do not let one bad
update block the good ones.

## Phase 5 — Commit

Only when everything validates:

1. `sudo nixos-rebuild switch`
2. Commit **as santiago** (never `sudo git commit` — it writes root-owned
   objects that break the push): `git -C /etc/nixos commit` with a message
   listing each `image: old → new`, then `git -C /etc/nixos push`.

The image bumps get their **own** commit. Anything from Phase 6 is a separate
commit — never bundle a config change into an image-bump commit.

## Phase 6 — Adoption review (parallel subagents, report-only)

The question this phase answers is not "what changed upstream" (Phase 1 has
that) but **"what should we now change about our own setup"**: which of our
shims the new version retires, which options we set it just deprecated, which
things we hand-roll it now does natively.

Run this **every time**, including when nothing was updated — if the user
skipped everything, review the researched deltas and label the findings
"arrives with the deferred update".

Scope: every image that was actually updated, plus — labeled separately —
any deferred image whose changelog deprecated something we currently set
(that is scheduled breakage regardless of when we take the bump).

Spawn **general-purpose subagents in parallel, one per updated stack** (group
small stacks, ≤4 stacks per agent). Give each its stacks, the scratchpad
research file paths for its images, any Phase-4 log deprecation hits, and
these instructions verbatim:

> You are auditing whether our config for `<stack>` has fallen behind what
> upstream now offers. Read, in this order:
>
> 1. `<research file(s)>` — the changelog + adoption signals already
>    collected. Start here; do not re-fetch what's already in the file.
> 2. `/etc/nixos/stacks/<stack>/<stack>.nix` **including its header comment**
>    (per CLAUDE.md that header is the canonical doc for the stack's quirks —
>    it is where the workarounds are confessed), plus everything in its
>    `assets/`.
> 3. `/etc/nixos/CLAUDE.md` — the stack's own section and "Cross-cutting
>    container gotchas"; `/etc/nixos/FUTURE.md`; `/etc/nixos/AUTH.md`; the
>    matching `.claude/rules/*.md` file if one covers the stack.
> 4. `platform/podman.nix` + `platform/publishing.nix` — only to learn which
>    first-class `fleet.*` option a finding should be expressed in.
>
> Then hunt for these five classes, in this priority order:
>
> | Class | What you're looking for |
> |---|---|
> | **A. Deprecated-and-we-use-it** | An option / env var / flag / schema we set that the new version deprecated, renamed or defaulted differently. Scheduled breakage — highest value, report even if the effort is large. |
> | **B. Obsolete workaround** | A shim in our config that the new version makes unnecessary: an `mkSecretRender` render, an entrypoint override, a patched schema, a sidecar container, a cron/systemd timer, a `serviceUrl` escape hatch, a must-keep host port, a locally-built `mkLocalImage`. |
> | **C. Newly first-class** | Something we hand-roll or lack that upstream now ships: native OIDC (retires a forward-auth middleware — check AUTH.md), a `/metrics` endpoint (→ `fleet.webApps.<n>.metrics`), a health endpoint (→ `healthPath`, mandatory for oidc apps anyway), built-in prune/backup (retires a timer), a real `HEALTHCHECK`. |
> | **D. Unrun post-upgrade chore** | A migration / reindex / rebuild the release notes require that `nixos-rebuild` does not perform (the Nextcloud `occ` chores are the known precedent). |
> | **E. FUTURE.md trigger fired** | An item in FUTURE.md whose own stated "Trigger to revisit" line this version satisfies. |
>
> **Evidence rule — a finding is reportable only with BOTH sides:**
> - a `file:line` under `/etc/nixos` for what we do today, with the line
>   quoted, and
> - the upstream release-note or doc line (with link) for what is now
>   possible.
>
> One side only ⇒ drop it silently. Never propose something because it sounds
> like good practice; this is strictly a diff between our config and the new
> upstream.
>
> **Do NOT propose** anything CLAUDE.md records as a deliberate decision:
> rootless `Type=oneshot` units, `--pull missing`, no `sdnotify=healthy`,
> gluetun owning the TV netns, published-port source-IP rewrite / socket
> activation, pi-hole as a native service, jellyfin outside the VPN, the
> break-glass local logins on grafana + n8n, `s2-pool` feature flags. The one
> exception: if the changelog specifically removes the constraint that made it
> a decision, report it and say which constraint lifted.
>
> Per finding return: class, one-line title, **our state today** (file:line +
> quoted line), **what's now possible** (+ link), the **concrete declarative
> change** phrased in `fleet.*`/nix terms where possible, **effort** S/M/L,
> and **cost of not doing it**.
>
> "No findings" is the expected answer for most stacks — a pure bug-fix bump
> has nothing here. Return that plainly rather than padding.

While the agents run, do nothing else.

Aggregate into an **Improvement opportunities** section: grouped A→E, empty
classes omitted, each finding one row of
`stack | title | our state (file:line) | now possible | effort` with the
detail below it. Deduplicate findings that several agents raise about the same
platform module.

Then ask with **AskUserQuestion**:

- Q1 "Implement now?" — `multiSelect` over the class-A and S-effort findings
  (the ones that pay for themselves this session).
- Q2 "The rest?" — "Append to FUTURE.md" / "Drop" / (Other to cherry-pick).

**Implementing a selection** is an ordinary declarative change under the
CLAUDE.md loop: Edit the module, `git -C /etc/nixos add -A`,
`sudo nixos-rebuild test`, verify the affected service (logs + the curl
smoke test), `sudo nixos-rebuild switch`, then a **separate** commit as
santiago. If a stack's header comment documents a workaround you just
removed, update that comment in the same commit — and per operator rule,
describe the *current* system, never the change history.

**Appending to FUTURE.md** follows the file's existing shape: a titled
entry, a paragraph of what we do today and why it's deferred, a "Plan when
picked up" block with the concrete declarative change, and a closing
"Trigger to revisit:" line.

## Final message

Two sections, in this order:

1. **Updated** — old → new per image, what was skipped/deferred and why, what
   failed and was reverted (with the log excerpt), and version follow-ups
   (e.g. "postgres majors available — plan a migration session",
   "immich release notes want X after first login").
2. **Improvement opportunities** — the Phase 6 report: what we could simplify
   or must fix before a future bump, what you implemented, what went to
   FUTURE.md. If Phase 6 found nothing, say so in one line — that is a real
   result, not an omission.
