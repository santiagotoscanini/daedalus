<div align="center">
  <img src="stacks/daedalus/app/public/icon.svg" width="96" height="96" alt="Daedalus" />

  # Daedalus

  **A home server manager.** One app runs the box — NixOS is the
  backend that keeps it reproducible.

  [daedalus.toscanini.me](https://daedalus.toscanini.me)
</div>

---

Daedalus declares the apps on the machine it lives on, deploys them
when CI ships a new image, publishes their hostnames and certificates,
watches their containers, databases, disks and mail, and reads their
logs. When you change something, it doesn't reach into a running
system — it commits the change to git and rebuilds the machine to
match. The craftsman, not the labyrinth.

## Why it's different

- **The repo IS the system.** Everything is a NixOS flake: every
  package, container, route, dashboard and alert is declared here,
  every input is pinned in `flake.lock`, and secrets are
  sops-encrypted in-tree. Any checkout plus a decryption key rebuilds
  the exact running machine.
- **Every change is a commit.** Daedalus's Apply flow exports its
  database to a committed JSON contract, rebuilds, and pushes — so the
  box can always be reproduced and every change can always be
  explained. A failed rebuild reverts itself.
- **Push to main, live in minutes.** Apps build on the box's own CI
  runners, land in its own registry, and deploy on a digest change.
  Nothing leaves the house.
- **The app holds zero host privilege.** Daedalus runs in a rootless
  container and talks to the machine through file-drop bridges watched
  by systemd — it can't rebuild, restart or read anything the host
  didn't explicitly hand it.
- **Honest by construction.** Every panel distinguishes "no" from
  "couldn't ask": a dead probe renders as unknown, never as healthy;
  a stale snapshot is treated as absent, never served as current.

## The shape of it

| Where | What |
|---|---|
| [`stacks/daedalus/app/`](stacks/daedalus/app/) | Daedalus itself — the TypeScript app (TanStack Start + React). |
| [`stacks/daedalus/host/`](stacks/daedalus/host/) | Its host-side agents: the bridges that apply, deploy and snapshot on the app's behalf. |
| [`stacks/apps/`](stacks/apps/) | The app platform it manages — `apps.json` is the committed contract between its database and the build. |
| [`stacks/`](stacks/) | Everything else on the box: media, network, monitoring, identity. Each stack's header comment is its canonical doc. |
| [`platform/`](platform/) | The OS layer: podman, publishing, ZFS, sops, mail, and the export domains Daedalus reads its facts from. |

## Documentation

| Doc | Covers |
|---|---|
| [Operations](docs/operations.md) | The daily rebuild loop and upgrades. |
| [Secrets](docs/secrets.md) | The two secret classes, sops recipients, rotation. |
| [Adding a stack](docs/adding-a-stack.md) | Declaring a new self-hosted service. |
| [Disaster recovery](docs/recovery.md) | Rebuilding the box from this repo and a key. |
| [External setup](https://daedalus.toscanini.me/docs) | Everything configured outside the repo: Cloudflare, the router, VPN keys, GitHub, mail, key custody. Source: [`website/src/routes/docs.tsx`](website/src/routes/docs.tsx). |
| [`CLAUDE.md`](CLAUDE.md) | The operator manual: hard rules, the `fleet.*` module system, cross-cutting gotchas, the debugging protocol, and the decisions that are settled. |
| [`AUTH.md`](AUTH.md) | The per-service SSO migration plan. |
| [`FUTURE.md`](FUTURE.md) | Deferred work and open follow-ups. |
| [`HARDWARE.md`](HARDWARE.md) | Dated physical-layer event log. |

The AI tooling is in-tree too: [`.claude/`](.claude/) carries the
permission matrix and PreToolUse guard that mechanically enforce the
operator manual's hard rules, plus path-scoped context, workflow
skills and a pre-switch reviewer agent — a fresh checkout brings the
guardrails with it, not just the system.
