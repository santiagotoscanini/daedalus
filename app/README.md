# daedalus — the app

The control plane itself: TanStack Start + React 19, drizzle-orm on the
shared app-db Postgres cluster, Tailwind v4 + shadcn.

It is not built by CI and not pulled from a registry. On the box, the
`app-daedalus` container bind-mounts this directory at `/app` and runs
`vite dev` against it, so saving a file is the deploy.

Everything else is one level up, and this file does not restate it:

- [`../CLAUDE.md`](../CLAUDE.md): the dev loop, what a change needs (a
  container restart, or a rebuild in the private configuration
  repository), and the verification commands.
- [`../.claude/rules/`](../.claude/rules/): the architecture map, the
  data-flow rules and the UI rules.
- [`../PLAN.md`](../PLAN.md): where the productization stands.
- `pnpm-workspace.yaml`: how to add a dependency through Verdaccio and
  the 7-day release cooldown, in its comments.

`/api/healthz` is load-bearing: it is the gatus probe, the forward-auth
bypass and the deploy unit's post-restart check. Keep it unauthenticated
and keep it meaning "can actually serve".
