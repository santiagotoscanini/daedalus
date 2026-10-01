# daedalus — the app

The control plane itself: TanStack Start + React 19, drizzle-orm on the
shared app-db Postgres cluster, Tailwind v4 + shadcn. A host runs it as
the one image built from the repository root's `Dockerfile`
(`fleet.daedalus.source`: the published image, one built on the box, or a
dev server over a mounted checkout — `nix/README.md` "The control plane's
image").

Everything else is one level up, and this file does not restate it:

- [`../CLAUDE.md`](../CLAUDE.md): the dev loop and the verification
  commands.
- [`../CONTRIBUTING.md`](../CONTRIBUTING.md): running and checking it
  with no host, and the image.
- [`../.claude/rules/`](../.claude/rules/): the architecture map, the
  data-flow rules and the UI rules.
- [`../PLAN.md`](../PLAN.md): what is still missing.
- `pnpm-workspace.yaml`: how to add a dependency under the registry policy and
  the 7-day release cooldown, in its comments.

`/api/healthz` is load-bearing — the gatus probe, the request gate's and
forward-auth's exemption, and the deploy unit's health check; its route
file says how. Keep it unauthenticated, keep it meaning "can actually
serve", and keep it starting nothing: the process's own work starts once at
process start (`src/host/background.ts`).
