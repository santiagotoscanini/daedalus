---
name: add-stack
description: Scaffold a new service stack in /etc/nixos — taxonomy placement, module from the fleet template, statePaths/webApps/secrets wiring, and the full verify loop. Use when adding any new self-hosted service to the box.
argument-hint: [service name + a line about what it is]
---

# /add-stack — new service, done the fleet way

You are adding a new containerized service. The module-system rule
(`.claude/rules/module-system.md`) loads once you create the `.nix` file —
it has the full option reference and template. This skill is the checklist.

## 0. Decisions before any file exists

Work these out (ask the operator only for genuine preference calls):

1. **Image** — find the canonical image; registry-qualify it; pin
   `tag@sha256:digest` (`nix run nixpkgs#skopeo -- inspect --no-tags
   --format '{{.Digest}}' docker://<image>:<tag>`). Beware pi-hole
   sinkholes: `getent hosts <registry>` first if it's an unusual registry.
2. **State placement** — `${config.fleet.stateRoot}/<group-or-name>` per
   the taxonomy (ai/ apps/ books/ tv/ or root-level). A service joining an
   existing group goes IN the group dir.
3. **Which UID the image runs as** — decides the `statePaths` uid
   (CONTAINER id; 0 = santiago). Check the image docs/Dockerfile. Postgres:
   alpine=70, debian=105 — the classic trap.
4. **Networking shape** — default: `bridgeMemberships = [ "traefik" ]` +
   `webApps` with `serviceName`+`port` (no host port). Host port only for
   non-HTTP protocols or netns constraints. Header-trusting admin UI →
   `isolated = true`. VPN egress needed → it's a gluetun tenant
   (`.claude/rules/vpn-netns.md`).
5. **Auth** — admin/household UI → `auth = "oidc"` (+ MANDATORY
   `healthPath`, asserted; `authGroups` for household apps). Native-auth
   apps (device logins) stay `"none"` — see AUTH.md.
6. **Exposure** — LAN-only by default; `exposeRemotely = true` only if it
   genuinely needs to work off-LAN.
7. **Database** — needs postgres? `fleet.appDatabases.<name>` on the shared
   cluster (NOT its own postgres container) unless it needs an extension
   the cluster lacks (the Immich precedent).

## 1. Scaffold

```bash
mkdir -p /etc/nixos/stacks/<stack>/assets
```

Write `stacks/<stack>/<stack>.nix` from the template in the module-system
rule. **The header comment is the canonical doc for this stack** — write it
for the next reader: what the service is, its quirks, why any non-default
choice was made. Describe the current system, never the change history.

Wire as decided: `bridgeMemberships`, `webApps` (+ `healthPath`),
`statePaths` (interpolate `config.fleet.stateRoot`), `appDatabases`,
`fleet.logStacks` entry in the module if log grouping matters,
`fleet.monitoredJobs` for any timer it ships.

If it fetches OIDC discovery at startup → one line in
`fleet.sso.discoveryConsumers`, never a hand-rolled ExecStartPre.

## 2. Secrets (if any)

```bash
$EDITOR /tmp/env   # KEY=value lines
sops -e --input-type dotenv --output-type dotenv /tmp/env \
  > /etc/nixos/stacks/<stack>/env.sops && shred -u /tmp/env
```

Run from inside /etc/nixos (the `.sops.yaml` catch-all must be found). In
the module: `sops.secrets."<stack>-env" = mkDotenvSecret ./env.sops;` and
`environmentFiles = [ config.sops.secrets."<stack>-env".path ];`.

## 3. Build + verify (the /rebuild loop)

```bash
git -C /etc/nixos add -A      # untracked files are invisible to the flake
sudo nixos-rebuild test
```

Then container-level verification (green unit proves nothing):

```bash
sudo -u santiago env XDG_RUNTIME_DIR=/run/user/1000 \
  podman ps --filter name=<stack> --format '{{.Names}}\t{{.Status}}'
podman logs --since 3m <stack> | tail -20
curl -sk --resolve <host>:443:192.168.0.2 -o /dev/null -w '%{http_code}' https://<host>/
systemctl --failed
```

First-start checks worth doing once: state files landed under the intended
`stateRoot` dir with the intended ownership (`ls -la`), no anonymous podman
volume appeared (`podman volume ls` — if one did, the image has a VOLUME
you didn't bind; add the bind mount), gatus picked up the healthPath probe.

## 4. Switch, commit, push

```bash
sudo nixos-rebuild switch
git -C /etc/nixos commit -m "stacks/<stack>: <what it serves>"
git -C /etc/nixos push
```

## 5. Post-add configuration

In-app setup (admin account, integrations) follows rule 2: use the app's
own UI/API, or make it declarative — never its database. If the app was
gated with `auth = "oidc"`, its Pocket ID client already exists
(auto-derived) — set the consent-screen copy via `fleet.ssoClients.<name>`
(`displayName`/`description`).
