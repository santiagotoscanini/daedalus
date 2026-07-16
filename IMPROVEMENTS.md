# IMPROVEMENTS.md — upgrade tracker

From the 2026-07-15 gap-to-SOTA audit. Deferred items: `FUTURE.md`.

Decisions locked in: no off-site backup for now (see FUTURE.md) ·
alert email via Gmail relay (`s2.toscanini.me@gmail.com`) · email
wired to all consumers · no OIDC yet (FUTURE.md) · keep Google DNS
upstream · reboot happens LAST, as the closing validation.

## P0 — Data safety

- [x] **1. Local ZFS replication to the mirror**
      Declarative sanoid/syncoid: `rpool/selfhost` + `rpool/home` →
      `s2-pool/backup/{selfhost,home}`. New `platform/backup.nix` +
      one-time `zfs create` of the backup parent dataset.
      *Why: one NVMe failure currently loses every DB + home dir.*

## P1 — Email & alerting

Prereq (operator): 2-Step Verification on the Gmail account, then 6
app passwords: `system`, `grafana`, `nextcloud`, `immich`, `n8n`, `tv`.

- [x] **2. System mail** — msmtp as sendmail (new `platform/mail/`),
      smartd mail notifications, ZFS ZED email on pool events,
      `OnFailure` email hooks (autoupgrade, backup units), weekly
      heartbeat email so a dead/locked relay is itself detectable.
      *Why: disk + pool failures are currently journal-only/silent.*
- [x] **3. Grafana alert delivery** — `GF_SMTP_*` env (secret in
      `stacks/monitoring/env.sops`), replace the `noop` contact point
      in grafana alerting provisioning, send test alert.
      *Why: 21 existing rules currently page nobody.*
- [x] **4. Container liveness metric** — timer script exporting
      `container_up{name=…}` via node-exporter textfile collector;
      point container alert rules at it.
      *Why: cadvisor can't see rootless containers — a dead container
      triggers nothing and its systemd unit stays green.*
- [x] **5. Outside-in uptime probing** — gatus (or blackbox_exporter)
      probing the public/LAN HTTPS endpoints + cert expiry, alerting
      through the same email path.
- [x] **6. n8n SMTP env** — `N8N_EMAIL_MODE=smtp` + `N8N_SMTP_*`
      (secret in `stacks/n8n/env.sops`).
- [ ] **7. Per-app SMTP in UIs** (operator, each has a test button):
      - [x] Nextcloud — Admin settings → Basic settings → Email server
      - [x] Immich — Administration → Settings → Notifications
      - [x] radarr — Settings → Connect → Email (health events only)
      - [x] sonarr — Settings → Connect → Email (health events only)
      - [ ] n8n — workflow SMTP credential (Credentials → SMTP)

## P2 — Security & reproducibility

- [x] **8. Pin the ~20 `:latest`/moving images** to the versions
      actually running (`podman inspect` per container → version tag
      in each stack module). Apps platform keeps its intentional
      `:latest` CD loop.
      *Why: DR must re-pull what ran, not whatever `:latest` is that day.*
- [x] **9. Traefik logging fix** — DEBUG→INFO, log to stdout
      (journald→Loki), enable access log.
- [x] **10. `no-new-privileges` fleet-wide** — add to
      `mkRootlessContainer`; opt-outs where needed (gluetun, cadvisor,
      intel-gpu-exporter).

## P3 — Hygiene

- [x] **11. flake-autoupgrade: add `git push`** — and verify the timer's
      first-ever scheduled run fires Mon 2026-07-20.
- [x] **12. Drift cleanup** — inspect then destroy orphaned
      `s2-pool/supabase-storage` dataset (explicit OK required);
      remove stale `stacks/immich/migration-key.sops`.
- [x] **13. Quarterly restore drill** — one file back from a ZFS
      snapshot; one sops secret decrypted with the password-manager
      age key. Calendar it.
- [x] **14. Lint/format tooling** — treefmt (nixfmt) + statix +
      deadnix as pre-commit.

## Final step

- [ ] **15. Reboot into the staged generation** — validates the
      flakes+sops+linger+ZFS boot chain end-to-end (never cold-boot
      tested since the migration; kernel is 47 days old). Watch
      `systemctl --failed` + container convergence after boot.
