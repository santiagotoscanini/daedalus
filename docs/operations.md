# Operations

The daily loop, and upgrades. The repo is the system: every change is
an edit here, a rebuild, and a commit.

## Daily driver commands

```bash
sudo nixos-rebuild test      # try the config without committing to it
sudo nixos-rebuild switch    # commit as the next boot generation
```

Both auto-detect `flake.nix` — no flags needed. The flake only sees
**git-tracked files**: `git add <newfile>` (plain git, never sudo —
root-owned .git objects break the push) before rebuilding, or the eval
fails with "file not found".

## Upgrades

```bash
cd /etc/nixos
nix flake update             # as santiago — the repo is santiago-owned;
                             # sudo would leave root-owned .git objects
sudo nixos-rebuild test      # verify
sudo nixos-rebuild switch
git add flake.lock && git commit -m "flake.lock: update" && git push
```

`flake-autoupgrade.timer` does all of this weekly — lock update, commit,
`nixos-rebuild boot` (staged for next boot, never auto-reboots), AND the
push to origin. Roll back an upgrade with `git revert` on the lock
commit + rebuild, or pick an older generation from the boot menu.

Container images are pinned per-stack; updating one is
`podman pull` + `systemctl restart podman-<name>` (moving tags) or a
tag edit + rebuild (pinned tags). Daedalus's image-freshness probe
reports which pins have fallen behind their tags.
