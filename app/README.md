# daedalus — the app

The control plane itself: TanStack Start + React 19, drizzle-orm on the
shared app-db Postgres cluster, Tailwind v4 + shadcn.

A host runs it one of two ways, both from the one image built from the
repository root's `Dockerfile`: the published image, or — on the host that
develops the engine — dev mode, where the `app-daedalus` container
bind-mounts this directory at `/app` and runs `vite dev` against it, so
saving a file is the deploy.

Everything else is one level up, and this file does not restate it:

- [`../CLAUDE.md`](../CLAUDE.md): the dev loop, what a change needs (a
  container restart, or a rebuild in the private configuration
  repository), and the verification commands.
- [`../CONTRIBUTING.md`](../CONTRIBUTING.md): running and checking it
  with no host, and the image.
- [`../.claude/rules/`](../.claude/rules/): the architecture map, the
  data-flow rules and the UI rules.
- [`../PLAN.md`](../PLAN.md): what is still missing.
- `pnpm-workspace.yaml`: how to add a dependency under the registry policy and
  the 7-day release cooldown, in its comments.

`/api/healthz` is load-bearing — the gatus probe, the forward-auth
bypass, the deploy unit's health check and what starts the build
scheduler in a fresh process; its route file says how. Keep it
unauthenticated and keep it meaning "can actually serve".
