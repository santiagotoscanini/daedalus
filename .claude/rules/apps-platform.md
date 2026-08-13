---
paths:
  - "stacks/apps/**"
  - "stacks/registry/**"
  - "stacks/gha-runner/**"
  - "stacks/daedalus/*.nix"
  - "stacks/daedalus/host/**"
  - "stacks/daedalus/assets/**"
---

# The apps platform — registry loop, deploys, daedalus's nix side

(Working on the daedalus TypeScript app itself? That's
`.claude/rules/daedalus-app.md`, which loads with
`stacks/daedalus/app/**`.)

## The registry contract

`fleet.apps` is NOT hand-written: `stacks/apps/declarations.nix` reads
`stacks/apps/apps.json`, an export of daedalus's `apps` table. DB =
editing surface, JSON = contract — nix eval is pure and can never query
Postgres, and the committed file is what keeps "the repo IS the system"
true. Never edit apps.json by hand; it is overwritten on the next
Apply, and daedalus shows the app as drifted until then. daedalus
itself is the one app declared by hand
(`stacks/daedalus/daedalus.nix`, `source.mode = "local"`) — an Apply
that broke its entry would take down the UI you'd use to undo it.

Per-app surface: `postgres.enable` (role+db on the shared cluster),
`storage.enable` (bind-mount `<stateRoot>/apps/<name>/data` at
/app/data), `litellm`, `prometheus.enable`, `auth.mode`
("proxy" = forward-auth gate, "native" = the app is the OIDC client),
`stage` ("off"/"lab"/"live" — live flips exposeRemotely), `resources`,
`egress` (ride a dedicated gluetun netns — argus), `env`. Conventions
enforced: every app container listens on **port 3000**; disk goes to
**/app/data**. We build the images, so the rules are ours.

## App hostnames

`fleet.apps.<name>.hostname` overrides the derived
`<name>.<baseDomain>`; null keeps the default. An **assertion requires
exactly one label under `baseDomain`** — the wildcard cert matches one
label, so `a.b.toscanini.me` routes fine and then serves a cert no
browser accepts. Renaming moves the traefik router, pi-hole record,
gatus probe, CF route and `AUTH_URL`/`APP_PUBLIC_URL`; the container,
postgres role/database, sops file and GitHub repo stay keyed by the
attribute name. Collisions are caught twice: the `fleet.traefikRoutes`
assertion (fires mid-Apply — costs a revert) and daedalus's live
hostname check (a red input box, the cheap path).

## Auto-deploy (the Vercel loop)

Every registry app gets `app-<name>-deploy.timer` (2 min). The oneshot
pulls, and **only if the digest moved** restarts the container and
health-checks it through traefik. Push to main → self-hosted runner
(`stacks/gha-runner`) builds and pushes
`registry.toscanini.me/<name>:latest` (zot, `stacks/registry`) → live
within ~2 min. Nothing leaves the house.

- Watch a deploy: `journalctl -fu app-<name>-deploy.service`
- Last result: `/var/lib/app-deploy/<name>` (`<digest> ok|failed`;
  sibling `<name>.pull` marker = pulls currently failing)
- Freeze an app: `deploy.enable = false` + a `sha-`pinned `image`

**Deploy-and-report, not auto-rollback.** A new image that doesn't
answer within 90s keeps running and the unit stays `failed`
(persistently, via the state file). Check `systemctl --failed`.

The deploy unit runs as **root** (it restarts a system unit) and drops
to santiago with `setpriv` for podman calls — `setpriv`, not
`runuser`/`sudo`, which would log a PAM session every 2 minutes into
journald/Loki forever.

The default images ride the local registry's anonymous-read policy —
no credential involved. The `--authfile`
(`stacks/apps/ghcr-auth.json.sops`) is inert unless an `image`
override points at a private GHCR package, which accepts **only a
classic PAT** with `read:packages`. If apps quietly stop updating,
look at the runner and at zot first, not at tokens.

## daedalus's host side

The app talks to the box through file-drop bridges under
`<stateRoot>/apps/daedalus/apply/` watched by systemd path units:
`request.json` → daedalus-apply (commit apps.json + rebuild),
`deploy-request.json` → deploy trigger, `ci-request.json` → CI verbs,
`power-request.json` → reboot, `image-request.json` →
daedalus-image-update (rewrite a container's digest pin + rebuild).
Read-only state flows IN via /run snapshot dirs (env, images, system,
ci) refreshed by timers. The container holds no host privilege at all.

**A bridge agent that runs `nixos-rebuild switch` must set
`restartIfChanged = false`.** switch-to-configuration restarts units
whose definition changed, and these agents can change their own: the
image-update agent embeds the pin registry, so the digest it just
rewrote lands in its own ExecStart, and the switch SIGTERMs it
mid-run — losing its verify and push phases and leaving a status file
stuck on `running` that disables the button until the container
restarts. daedalus-apply carries the same flag defensively; its
sibling deploy-trigger already embeds a list derived from apps.json,
so escaping this is luck rather than design.
