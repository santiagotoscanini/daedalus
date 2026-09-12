| [`PLAN.md`](PLAN.md) | The productization plan: twelve phases, each with its outcome once it lands, and a status table at the top. |
<div align="center">
  <img src="app/public/icon.svg" width="96" height="96" alt="Daedalus" />

  # Daedalus

  **A home server manager.** One app runs the box — NixOS is the
  backend that keeps it reproducible.

  [daedalus.toscanini.me](https://daedalus.toscanini.me) · [docs](https://daedalus.toscanini.me/docs)
</div>

---

Daedalus declares the apps on the machine it lives on, builds and
deploys them from their own repositories, publishes their hostnames and
certificates, watches their containers, databases, disks and mail, and
reads their logs. When you change something, it doesn't reach into a
running system — it commits the change to git and rebuilds the machine
to match. The craftsman, not the labyrinth.

## Why it's different

- **The repo IS the system.** The machine Daedalus manages is a NixOS
  flake: every package, container, route, dashboard and alert is
  declared, every input is pinned in `flake.lock`, and secrets are
  sops-encrypted in-tree. Any checkout plus a decryption key rebuilds
  the exact running machine.
- **Every change is a commit.** Daedalus's Apply flow exports its
  database to a committed JSON contract, rebuilds, and pushes — so the
  box can always be reproduced and every change can always be
  explained. A failed rebuild reverts itself.
- **Push to main, live in minutes.** A push wakes the box, which builds
  the app's image itself, lands it in its own registry, and deploys on
  the digest change. Nothing leaves the house.
- **The app holds zero host privilege.** Daedalus runs in a rootless
  container and talks to the machine through file-drop bridges watched
  by systemd — it can't rebuild, restart or read anything the host
  didn't explicitly hand it.
- **Honest by construction.** Every panel distinguishes "no" from
  "couldn't ask": a dead probe renders as unknown, never as healthy;
  a stale snapshot is treated as absent, never served as current.

## What's in this repository

| Where | What |
|---|---|
| [`app/`](app/) | Daedalus itself — the TypeScript app (TanStack Start + React 19, drizzle-orm, Tailwind v4). |
| [`website/`](website/) | The landing site and the [external-setup docs](https://daedalus.toscanini.me/docs), deployed to GitHub Pages by [`.github/workflows/website.yml`](.github/workflows/website.yml). |
| [`.claude/`](.claude/) | Path-scoped rules for Claude Code sessions working on the app and its UI. |
| [`PLAN.md`](PLAN.md) | The productization plan: twelve phases, each with its outcome once it lands, and a status table at the top. |

The NixOS module that runs the app is not in this repository yet. It
lives in the author's machine configuration, alongside the host-side
agents (the bridges that apply, deploy and snapshot on the app's
behalf) and the platform layer it depends on. It moves here as an
importable module in Phase 11 of [`PLAN.md`](PLAN.md); today this repo is
the app and its site.

## Developing

The app runs as a `source.mode = "local"` app on the machine it
manages: the container bind-mounts `app/` and runs the Vite dev server
against it, so saving a file is the deploy. `CLAUDE.md` has the loop,
the verification commands and where everything else lives.
