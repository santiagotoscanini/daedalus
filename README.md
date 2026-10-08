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
  container and asks the machine for a fixed list of systemd
  verbs through one root helper — it can't rebuild, restart or read
  anything the host didn't explicitly hand it.
- **Honest by construction.** Every panel distinguishes "no" from
  "couldn't ask": a dead probe renders as unknown, never as healthy;
  a stale snapshot is treated as absent, never served as current.

## What's in this repository

| Where | What |
|---|---|
| [`app/`](app/) | Daedalus itself — the TypeScript app (TanStack Start + React 19, drizzle-orm, Tailwind v4). |
| [`nix/`](nix/) | The NixOS side: the platform layer, the control plane's own module and its host verbs (the units that apply, build, deploy and snapshot on the app's behalf), and the catalog of stacks a host can switch on. Exported by [`flake.nix`](flake.nix); [`nix/README.md`](nix/README.md) says how a host imports it and what is not done yet. |
| [`example-host/`](example-host/) | A complete example host to start from (`nix flake init -t github:santiagotoscanini/daedalus#config`), and the host `nix flake check` evaluates. |
| [`agent/`](agent/) | The Rust service for the other machines the box talks to — [`agent/README.md`](agent/README.md). |
| [`session-host/`](session-host/) | santree's remote projects, served on the box to approved machines — [`session-host/README.md`](session-host/README.md). |
| [`website/`](website/) | The landing site and the [external-setup docs](https://daedalus.toscanini.me/docs), deployed to GitHub Pages by [`.github/workflows/website.yml`](.github/workflows/website.yml). |
| [`.claude/`](.claude/) | Path-scoped rules for Claude Code sessions working on the app, its UI and the nix tree. |
| [`PLAN.md`](PLAN.md) | What is still missing, and how to build it — forward-looking only; what landed is in git history. |

## Developing

A box runs the control plane as an image built from the engine rev its
configuration pins, so a change reaches it as a commit and a lock bump;
[`AGENTS.md`](AGENTS.md) has that loop and the verification commands.

None of that is needed to work on it. Node 24, a throwaway Postgres and
two environment variables are enough, and the checks need nothing at all:
[CONTRIBUTING.md](CONTRIBUTING.md) — every command in it was run from a
fresh clone with no host present.

[ARCHITECTURE.md](ARCHITECTURE.md) is how the pieces fit together, and
why an unprivileged container can drive a machine safely.
[BUILDS.md](BUILDS.md) is what happens between a push and a running
container.
