# daedalus

The S2 control plane. TanStack Start + React, Postgres on the shared app-db
cluster, LLM access through the LiteLLM gateway.

This app is **not** built by CI and **not** pulled from a registry. The
container at `app-daedalus` bind-mounts this directory at `/app` and runs
`vite dev` against it, so the files here are the files being served.

## The loop

Edit a file. That's it — HMR pushes it to the open browser tab at
<https://daedalus-app.toscanini.me>. No commit, no rebuild, no restart.

The exceptions, in increasing order of cost:

| Changed | Needed |
|---|---|
| anything under `src/`, `public/` | nothing |
| `package.json` / `pnpm-lock.yaml` | `sudo systemctl restart podman-app-daedalus` (re-runs the install) |
| `../assets/Containerfile` or `entrypoint.sh` | `sudo nixos-rebuild switch` (new context hash → new image tag → restart) |
| `../daedalus.nix` | `sudo nixos-rebuild switch` |

Commit anyway — `/etc/nixos` is on `rpool/root`, which has no ZFS snapshots
and is not in the syncoid mirror. The git remote is the only backup.

## Running commands

Everything runs inside the container, where `DATABASE_URL` and the LiteLLM key
already exist. There is no `.env` file and no host-side node.

```sh
podman exec -it app-daedalus pnpm typecheck
podman exec -it app-daedalus pnpm db:generate   # after editing src/lib/schema.ts
podman exec -it app-daedalus pnpm db:migrate
podman logs -f app-daedalus
```

## Adding a dependency

Every install resolves through the self-hosted Verdaccio and is subject to a
7-day supply-chain cooldown — both pinned in `pnpm-workspace.yaml`, which the
container's entrypoint reads rather than restating.

The cooldown is re-checked on *every* install, including `--frozen-lockfile`,
so a lockfile written with it disabled will break the container at boot rather
than at resolution time:

```sh
podman exec -it app-daedalus pnpm add <pkg>          # may fail: version too young
# if it does, retry with --config.minimum-release-age=0, then ALWAYS verify:
podman exec -it app-daedalus pnpm install --frozen-lockfile
```

That last command is the one that catches a too-young *transitive* dependency.
If it fails, the fix is usually to let pnpm re-resolve with the policy active
(delete `pnpm-lock.yaml`, install again) rather than to pin overrides.

## Layout

```
src/routes/          flat-file routes (api.healthz.ts → /api/healthz)
src/lib/env.ts       every value the NixOS module injects, and nothing else
src/lib/db.ts        postgres client, memoised across HMR reloads
src/lib/schema.ts    drizzle schema — empty until there's a domain model
```

`/api/healthz` is load-bearing: it is the gatus probe, the forward-auth bypass
and the deploy unit's post-restart check. Keep it unauthenticated and keep it
meaning "can actually serve".
