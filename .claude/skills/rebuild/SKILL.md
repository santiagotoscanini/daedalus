---
name: rebuild
description: Apply pending /etc/nixos changes the right way — git add, nixos-rebuild test, container-level verification matched to what changed, switch, commit + push. Use whenever config edits need to reach the running system.
argument-hint: [optional note about what changed, e.g. "new stack foo" or "secret rotation"]
---

# /rebuild — the deploy loop, with the right verification

You are applying pending changes in `/etc/nixos` to the running s2-server.
The loop is fixed (CLAUDE.md hard rule 1); the *verification* step is where
judgment goes — match it to what actually changed.

## 1. Review what's pending

```bash
git -C /etc/nixos status --short && git -C /etc/nixos diff --stat
```

Classify the change set (drives step 4's verification):

- **container/stack change** — a module's image, volumes, env, ports
- **secret change** — a `*.sops` edited, or a `secrets/` file deleted for
  rotation
- **pg-touching change** — anything in `stacks/app-db/` (even one line)
- **gluetun-touching change** — anything that recreates a gluetun container
  (bounces every netns tenant)
- **platform change** — `platform/*.nix`, `configuration.nix`, `flake.*`
- **boot/kernel/filesystem change** — kernel params, bootloader,
  `fileSystems`, ZFS pool layout → **pause and confirm with the operator
  first (hard rule 3)**, and consider a pre-switch review by the
  `nix-reviewer` agent

## 2. Stage — the flake only sees tracked files

```bash
git -C /etc/nixos add -A
```

Plain `git`, NEVER `sudo git` (root-owned objects break the repo). An
un-added file fails eval with "file not found".

## 3. Test

```bash
sudo nixos-rebuild test
```

This activates the config WITHOUT making it the boot default. Read the
activation output: which units restarted/started is the checklist for step 4.
On eval failure: fix, re-add, re-test. Never jump straight to `switch`.

## 4. Verify — container-level, never unit-level

`systemctl is-active` lies here (`Type=oneshot` + `RemainAfterExit`: a dead
container leaves a green unit). Always:

```bash
systemctl --failed
sudo -u santiago env XDG_RUNTIME_DIR=/run/user/1000 \
  podman ps --filter name=<changed> --format '{{.Names}}\t{{.Status}}'
```

Then per change class:

- **container/stack**: `podman logs --since 5m <name> | tail -20` (container
  output is NOT in journald); if it has a hostname:
  `curl -sk --resolve <host>:443:192.168.0.2 -o /dev/null -w '%{http_code}' https://<host>/`
  → expect 200/30x/401, never 5xx. Migrations may need 30–60s; retry twice.
  If the change's point is VISUAL (a UI, a landing, a dashboard):
  `shot quick https://<host>/` and read the run's `events.json` — a 200
  can render broken, and events outrank pixels (stacks/shotter).
- **secret**: if ANY `mkSecretRender` unit reads the rotated secret, the
  rebuild is NOT enough — `/rotate-secret` has the map; restart the render
  unit AND its consumer, then verify the consumer actually picked up the new
  value.
- **pg-touching**: the fleet event. After the rebuild:
  `sudo systemctl restart podman-pocket-id`, then
  `curl -sk --resolve id.toscanini.me:443:192.168.0.2 https://id.toscanini.me/.well-known/openid-configuration`
  → expect 200. Then check `podman ps` for anything else that died
  (wealthfolio and other OIDC-at-startup apps hard-exit).
- **gluetun-touching**: every netns tenant needs a restart after gluetun is
  back; then verify one tenant end-to-end.
- **platform**: broader blast radius — `systemctl --failed` plus a spot-check
  of one service per affected subsystem, and the traefik smoke test:
  `curl -sk --resolve pihole.toscanini.me:443:192.168.0.2 -o /dev/null -w '%{http_code}' https://pihole.toscanini.me/` → 302.

If verification fails: fix forward or revert the file(s)
(`git -C /etc/nixos checkout -- <file>`), re-add, re-test. Never `switch` on
a failing verify.

## 5. Switch — make it the boot generation

```bash
sudo nixos-rebuild switch
```

## 6. Commit + push

```bash
git -C /etc/nixos commit -m "<what and why, present tense>"
git -C /etc/nixos push
```

As santiago, never sudo. One logical change per commit — don't bundle
unrelated pending edits; commit them separately or ask.

## Report

State plainly: what changed, test/switch results, what was verified and how
(the actual curl codes / container statuses, not "looks good"), anything
still pending.
