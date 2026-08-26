---
name: new-app
description: Create a new self-built fleet app end to end — repo scaffolded from the iris template, hybrid Pocket ID + password auth, daedalus registration, the CI→zot→deploy first image, a landing page with its own art direction, and (if public) the portfolio work list. Use for any new app on the apps platform; a third-party service stack is /add-stack instead.
argument-hint: [app name + one line, e.g. "hermes — an RSS reader"]
---

# /new-app — a new self-built app, end to end

You are creating a product, not a stack: a repo under
`github.com/santiagotoscanini/<name>`, registered with daedalus, built
by the box's own CI, deployed from its own registry, wearing its own
face. **iris (`~santiago/projects/iris`) is the canonical template** —
every convention below exists there, working; when this skill and the
iris tree disagree, read iris and fix this skill. `/add-stack` is for
third-party services; this is for apps we write ourselves.

**Orchestrator contract (non-negotiable): after phase 0 you hold the
decision record, the subagent briefs, and the verification evidence —
nothing else. Every phase runs in a subagent, even strictly sequential
ones, so a whole app fits in one conversation.** Brief each subagent
self-containedly (paths, the decisions, the trap list for its phase);
never open the template repo in your own context.

## 0. Decisions before anything exists

Resolve name + concept from the arguments, then ask the operator with
**AskUserQuestion**, one round:

- **Exposure** — *public* (`stage: live`: Cloudflare tunnel route +
  the portfolio work list, phase 6) or *internal* (`stage: lab`: LAN +
  WireGuard only). Either way **create as `lab` first** — promotion
  after verification is a one-field edit, free insurance.
- **Registration policy** — open signup, invite-gated (`INVITE_CODE`),
  or operator-only.
- **Art direction** — sketch 2–3 genuinely distinct visual identities
  for the landing (phase 3) and let the operator pick.

Not questions — settled, don't ask:

- **Auth is always native hybrid**: Pocket ID for the operator,
  email/password for everyone else, both providers live at once (the
  iris pattern; invariants in phase 2). Never forward-auth `proxy` for
  an app with its own accounts, never either/or.
- **postgres** yes unless provably stateless; **storage** only for
  real disk state (prefer DB/bytea — a stateless container survives a
  fresh bootstrap for free); **litellm** yes iff the concept has AI
  features.

Name rules — checked twice (daedalus's form, then a mid-Apply
assertion that costs a revert), so get them right before anything is
created: `^[a-z0-9]([a-z0-9-]*[a-z0-9])?$`, ≤ 59 chars, exactly one
label under `toscanini.me`, not already taken, and **never the bare
`daedalus` hostname** (cloudflared-route-sync would overwrite the
GitHub Pages CNAME).

If the operator supplied design input (a Claude Design link, a mock),
fetch it now and distill it into the phase-2/3 briefs — layout,
components, information architecture; the art direction still gets its
own pass. A `claude.ai/design/p/<id>` share link **403s in WebFetch** —
read it with the **DesignSync** tool (`get_project`, `list_files`,
`get_file` on the id from the URL). Distill it yourself and paste the
exact values (palettes, every theme's tokens, type stack) into the
briefs: subagents may not have that tool, and a derived-by-eye palette
is a correction later.

## 1. Plan, then hands off

Write the decision record (name, pitch, exposure, policy, art
direction, postgres/storage/litellm, hostname, schema sketch). From
here on you orchestrate: phases 2→5 in order, phase 3 may run inside
the phase-2 repo after scaffold lands, phase 6 only for public apps.
Each subagent gets: its section of this skill verbatim, the decision
record, and the paths it owns. It reports back facts (files written,
commands run, outputs), not summaries of intent.

## 2. Scaffold the repo from the iris template (subagent)

Brief: copy iris's shape wholesale into `~santiago/projects/<name>`,
rename iris→<name> throughout, strip iris's domain features (QR/
profiles/links), keep the platform contract intact, then build the new
app's own schema + features. `gh repo create santiagotoscanini/<name>
--private`, branch `main`. Set the remote to **SSH** — `gh`'s OAuth
token has no `workflow` scope, so an HTTPS push of `.github/workflows/*`
is rejected.

Copy near-verbatim:

- `pnpm-workspace.yaml` (verdaccio registry, cooldown, overrides),
  `.tool-versions`, `tsconfig.json`, `tsr.config.json`,
  `vite.config.ts`, `eslint.config.mjs`, `prettier.config.js`,
  `.dockerignore`, `.gitignore`, `.env.example`
- `Dockerfile` + `start.mjs` (migrate-then-listen; `MIGRATE_ONLY` stays)
- `.github/workflows/ci.yml` + `release.yml`
- `src/start.ts` (security headers), `client.tsx`, `router.tsx`
- **the entire auth surface, unmodified**: `src/server/auth/**`,
  `src/server/middleware/auth.ts`, `src/server/fn/auth.fn.ts`,
  `src/lib/env.ts`, `src/lib/rate-limit.ts`, `src/lib/safe-next.ts`,
  the accounts service, `login.tsx` / `register.tsx` / `app.tsx`
  guard, `api.auth.$.ts`, `api.healthz.ts`
- `src/components/ui/**` barrel kit (restyle in phase 3, keep the API)

The trap ledger — every item has cost real hours; the brief carries it
in full:

- **Tailwind v4**: the CSS entry's first line is
  `@import 'tailwindcss' source(none);` plus explicit `@source` dirs —
  anything else FOUCs in the image build (client/SSR scan different
  trees, hash divergence). After the Dockerfile build, verify parity:
  `grep -rho 'globals-.*\.css'` over the server output must name the
  same hash as `ls` of the client assets.
- **vite.config.ts plugin order is load-bearing**: devtools → nitro
  (**build-only**, `command === 'build'`) → tailwindcss →
  tanstackStart → viteReact → babel with the React Compiler preset via
  `@rolldown/plugin-babel`. Nitro in dev breaks server-fn ids
  ("Invalid server function ID" at click time); the compiler as a
  `viteReact` option is silently ignored since v6.
- **`*.fn.ts` modules export server functions ONLY** — any other
  export mis-registers ids; builds green, fails at click time.
  Middleware lives in `middleware/`, zod schemas in services.
- Client-reachable code never imports `~/server/**` or `~/lib/env` —
  the eslint boundary block is in the template; keep it, and keep
  ci.yml's grep of `.output/public/` for leaked server modules.
- **Auth invariants (the hybrid's three legs — drop one and the
  operator's address is stealable):** both providers in
  `providers: []`; `allowDangerousEmailAccountLinking: false`;
  `OIDC_EMAILS` enforced at all three sites (registerUser refuses,
  credentials authorize refuses, resolveLoginMethod routes to the
  IdP). And NEVER set `cookies`, `useSecureCookies`, `jwt`
  encode/decode, or `session.maxAge` — the session JWE's HKDF salt is
  the cookie name; touching them silently invalidates every session.
- **Drizzle**: schema imports are relative (drizzle-kit ignores
  tsconfig paths); migrations come from `drizzle-kit generate` and are
  committed (prettier-ignored — reformatting desyncs the ledger);
  `start.mjs` applies them before listening.
- **Dockerfile**: pnpm `node-linker=hoisted` (the runtime stage copies
  bare `node_modules/` dirs; symlinks arrive dangling), `HOST` not
  `HOSTNAME`, port **3000** (the platform hardcodes it), persistent
  state under **/app/data** only, `node:24` → `node:24-slim`.
- **pnpm cooldown**: `minimumReleaseAge` re-checks on every install
  including `--frozen-lockfile`; adding a dep = comment it out,
  install, restore, re-verify.
- Env schema: keep iris's platform set (`DATABASE_URL`, `AUTH_SECRET`,
  `APP_PUBLIC_URL`, `OIDC_*`, `OIDC_EMAILS`, `INVITE_CODE`) and add
  the app's own vars. In native mode every `OIDC_*` value arrives from
  the platform — the repo never carries them. AI apps: the platform
  injects `LITELLM_BASE_URL`; declare `LITELLM_API_KEY` in env.ts
  (phase 4 mints it).

Verify — no node on the host, throwaway containers only, and trust the
Dockerfile build over a bare `pnpm build` (the contexts differ and
that difference has produced real bugs):

```bash
podman run --rm -v "$PWD":/w -w /w --add-host=verdaccio.toscanini.me:host-gateway \
  node:24 sh -c 'corepack enable && pnpm install --frozen-lockfile && pnpm format:check \
    && pnpm generate-routes && pnpm lint && pnpm typecheck && pnpm build'
podman build -t <name>-smoke .
```

## 3. The landing page — a piece of art (subagent)

The bar: someone who has seen ten AI-generated landing pages must not
smell an eleventh. Not a hero-gradient-and-three-feature-cards
template — one idea executed all the way down, the way iris's QR
matrix motif and the portfolio's hand-drawn line art carry theirs.

- **The voice rule, and it is not negotiable.** Zero em-dashes: `—`
  and `–` must grep to 0 in every string a user can read (landing
  copy, page/tab titles, metadata, in-app strings, README). The house
  separator is the middot, `·`. No exclamation marks. No hype
  adjectives (amazing, powerful, seamless, effortless, premium,
  delightful, comprehensive, cutting-edge, game-changing), no
  "delve", "dive into", "journey", "unpack", "let's explore", no
  "Not just X, but Y", no padding triads, no emoji as section
  headers. Short declarative sentences. Name the thing that happens
  instead of praising it. **Never write a number the app has not
  actually computed** — an invented statistic on a landing page is a
  lie with a percent sign, and a sweep across the fleet found several.
  The full spec is `~santiago/projects/personal-portfolio/drafts/dna/PLAN.md`
  ("Voice rules"); `~santiago/projects/voyra/CLAUDE.md` carries the
  short form. Copy the short form into the new repo's `CLAUDE.md`, or
  the next session regenerates the voice you just removed.
- **A distinct identity per app.** iris owns paper-and-ink vermilion;
  daedalus/santree own the dark phosphor system. The new app gets its
  own palette, type voice, and one signature motif drawn from the
  app's concept — and the motif recurs: hero, dividers, favicon,
  empty states.
- One accent color, licensed sparingly (primary buttons, focus ring,
  selection, one word per headline). Hairlines over gray borders;
  depth from the system's own material, not drop shadows.
- **No animation library.** CSS keyframes on server-rendered markup so
  everything paints and moves pre-hydration; every animation has a
  `prefers-reduced-motion` counterpart.
- Section order is an argument, not a stack of blocks: state the
  invariant → show the loop → derive the features → answer "what's
  the catch" → reprise the motif as a bookend.
- Fonts bundled via `@fontsource-variable/*` (never Google-hosted;
  the `-variable` package name matters). `public/icon.svg` favicon in
  the motif.
- **Two icon files, not one.** Beside the SVG favicon:
  `public/apple-icon.png`, an OPAQUE 180×180 PNG linked
  `rel="apple-touch-icon"` from the root head. iOS ignores SVG there
  and paints transparency black, so without the PNG "Add to Home
  Screen" gets a page snapshot — four of seven apps shipped that way
  until 2026-08-26. A full-tile mark renders full-bleed on its own
  tile color; a bare glyph (voyra) gets the app's background behind
  it. Render via a `shot` driver (inline SVG in `page.setContent`, 180
  viewport, screenshot) — that is also the only way a text-based mark
  (chismed) rasterizes with its real font.
- **Read two or three sibling landings before writing a word**
  (`~santiago/projects/{voyra,anansi,iris}`, santree's + daedalus's
  `website/`) — and read them, don't recall them. hermes's brief
  asserted voyra was the dark phosphor system; it is warm paper and
  ink. The pattern they share: open with a claim, never a disclaimer;
  a display serif whose sentence turns on a true italic; one mono
  `term · term · term` line under the CTAs; and **the objections slot
  is an FAQ, not a confession** (iris's `Faq.tsx` header: the page
  speaks as a product, not as somebody's hardware). Never name the
  operator, self-hosting, home servers, single instances, or
  invite-only-ness as an identity — cost, access and privacy are
  answered honestly in the FAQ instead.
- **Show the product.** santree's "live screenshots" are hand-authored
  React mocks (`website/src/components/app-demo/`): a fixed 1280×800
  canvas scaled as a unit, `data.ts` the story, `chrome.tsx` the shell.
  Copy the technique, depict the real UI, and leave a re-sync note —
  they drift when the app changes.
- **You cannot judge a landing from its source.** Screenshot it and
  look: `shot quick https://<host>/` (stacks/shotter — THE browser
  flow on this box; never hand-build a chromium container), then Read
  the sliced PNGs from the run dir and iterate. Read `events.json`
  before trusting the pictures — a landing can render perfectly over a
  stylesheet 404. hermes's first two landings both came back green
  from every text check and were both rejected on sight.

## 4. Register with daedalus + first image (subagent)

Read `.claude/rules/apps-platform.md` and `.claude/rules/daedalus-app.md`
first. The UI is `https://daedalus-app.toscanini.me/apps/new`; the
scripted door is `podman exec app-daedalus` →
`fetch('http://127.0.0.1:3000/…')` — **every `_serverFn` POST needs
`Origin: http://127.0.0.1:3000` or CSRF answers a bare 403**.
`applyRegistry` has a REST twin at `POST /api/registry/apply`.

Order is load-bearing — an Apply whose image doesn't exist fails the
switch and reverts itself:

1. **PAT scope.** If the fine-grained PAT in
   `stacks/gha-runner/env.sops` is repo-scoped, add the new repo
   BEFORE declaring the app, or `gha-runner-<name>` 404-loops on the
   registration-token endpoint and mails alerts. (Docs conflict on
   whether it's account-wide; that 404 is the tell.)
2. Push the repo. The publishing workflow must be
   `runs-on: self-hosted`, push `zot:5000/<name>:latest`, carry
   `workflow_dispatch:`, and use no `services:`/`container:` jobs
   (no podman socket in the runner).
3. Set `REGISTRY_PASSWORD` via daedalus ("Set it"). **Verify in the
   Actions log**: a real secret masks as `<<< "***"`, an empty one as
   `<<< ""` — set-secret can report done while storing nothing.
   Fallback: `gh secret set REGISTRY_PASSWORD --repo … --app actions`.
4. Run CI for the first image. The bootstrap runner is deliberately
   non-ephemeral and its nested podman wedges after repeated runs
   (`libpod/tmp/pause.pid`): `podman stop gha-runner-bootstrap-<name>`
   between attempts.
5. Create the app: `stage: lab`, postgres/storage/litellm per the
   decision record. `createAppFn` hardcodes `authMode: 'none'` — set
   `authMode: 'native'` + `authHealthPath: '/api/healthz'` afterwards
   via `saveApp`. Leave `authAllowedGroups` unset.
6. Operator secrets, if any: `stacks/apps/<name>-env.sops`
   (`OIDC_EMAILS=santiago@toscanini.me`, `INVITE_CODE` when gated,
   app-specific keys) — sops-encrypt, then **plain `git add`** (an
   untracked file is invisible to the flake; never `sudo git`).
7. LiteLLM key for AI apps: `fleet.litellmKeys.<name>` in
   `stacks/litellm/keys.nix` (`consumers = [ "app-<name>" ]`,
   `consumerEnv = [ "LITELLM_API_KEY" ]`) — declared in nix, not the
   registry; `litellm.enable` alone only injects the base URL.
8. **The IdP logo.** Copy the app's `public/icon.svg` to
   `stacks/pocket-id/assets/logos/<name>.svg` and `git add` it. The
   sync uploads it to any client that has none, but nothing can derive
   it for you — the mark lives in the app's own repo and the flake sees
   only this one. Skip it and the consent screen serves a letter tile.
9. **Apply** — daedalus commits `apps.json` and rebuilds under flock.
   Never edit `apps.json` by hand; drift is detected and overwritten.

## 5. Verify like the box demands

Green units prove nothing (`Type=oneshot`); check containers and HTTP:

```bash
sudo systemctl start app-<name>-deploy.service
journalctl -u app-<name>-deploy.service -n 20
cat /var/lib/app-deploy/<name>            # expect: <digest> ok
sudo -u santiago env XDG_RUNTIME_DIR=/run/user/1000 \
  podman ps --filter name=app-<name> --format '{{.Names}}\t{{.Status}}'
curl -sk --resolve <name>.toscanini.me:443:192.168.0.2 \
  https://<name>.toscanini.me/api/healthz -o /dev/null -w '%{http_code}\n'   # 200
systemctl --failed
```

Then auth, **both doors**:

- The Pocket ID client converged (`pocket-id-clients.service`; the
  client shows in the IdP). The operator's email routes to the IdP
  from the login page and the round-trip lands in `/app`.
- A non-operator email gets the password step; registration honors the
  invite policy.
- If anything in the process bounced pg: the pg → pocket-id cascade
  applies — `systemctl restart podman-pocket-id`, re-check
  `id.toscanini.me/.well-known/openid-configuration` for 200.

**A session is not a working app.** hermes shipped with every
authenticated page 500ing while healthz, the session endpoint and both
auth doors all reported green — the operator found it seconds after
being told it was verified. So finish by USING it: with a real session,
`GET /app` and each of its sub-routes, and grep the SSR'd HTML for the
framework's error boundary (**`grep -a`** — the seroval payload reads as
binary and plain grep silently returns nothing). The container log will
be empty; the real exception is serialized into that HTML. Then run the
app's core loop once on real data through its own API — the import, the
first fetch, whatever the product actually is. Both of hermes's
launch-blocking bugs lived one step past where the checklist stopped.

## 6. Public only — promote and publish

1. `stage: live` via daedalus + Apply. Confirm the proxied CNAME
   appeared and the app answers through the tunnel from outside.
2. **Portfolio** (subagent, `~santiago/projects/personal-portfolio`):
   append a `Project` entry in `src/app/work/WorkView.tsx` (name,
   host, href, one-sentence tagline, 2-sentence plain-language
   description, 3 SHOUTING tags) and author a new hand-drawn SVG art
   component in `src/app/work/ProjectArt.tsx` (viewBox `0 0 120 120`,
   the shared STROKE/FAINT/PHOSPHOR constants, `aria-hidden`,
   CSS-only `work-*` keyframes in globals.css). **Read the comment
   above `PROJECTS` first — order is the layout, and changing the
   entry count changes the grid shape.** The site deploys via Vercel
   on push, but that repo's standing rule is **never auto-commit** —
   leave the diff for the operator to review, test, and push.

## Report

The decision record; repo URL and the first-image Actions run; the
actual verification outputs (the deploy state line, podman `Status`,
the healthz code, which auth doors were exercised and what happened) —
not "looks good". What was deliberately left for the operator
(portfolio commit, stage promotion, secrets to fill in). Anything that
fought back goes in as a gotcha with its fix, so the next run of this
skill starts smarter.
