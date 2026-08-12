# Disaster recovery

The repo is the system, so recovery is a clone plus a decryption key.

1. Fresh NixOS install (any version with flakes) on new hardware.
2. `git clone git@github.com:santiagotoscanini/daedalus.git /etc/nixos`
3. Restore the decryption identity — either the old host SSH key to
   `/etc/ssh/ssh_host_ed25519_key`, or santiago's age key (password
   manager) to `~/.config/sops/age/keys.txt` + re-encrypt for the new
   host key: `sops updatekeys` after adding it to `.sops.yaml`.
4. `sudo nixos-rebuild switch --flake /etc/nixos#s2-server`
5. Data: `zpool import` both pools; machine-generated secrets and app
   data restore from ZFS snapshots / `/s2/shared/` backups. The
   bootstrap oneshots re-roll anything missing (new DB passwords —
   apps reconnect via the regenerated env files).

What is NOT in this repo: ZFS pool contents (`/s2/*`, app data under
`/home/santiago/selfhost/`), pi-hole's gravity.db, `acme.json`
(re-issues automatically; LE rate-limits apply), the machine-generated
`secrets/` dirs, and grafana's own DB state (UI users/service accounts
— on the shared app-db cluster, covered by its backup story).
