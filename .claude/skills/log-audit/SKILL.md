---
name: log-audit
description: Post-reboot audit of ALL system + container logs on s2-server. Sweeps journald (the single log source) for errors, warnings, flapping units, silent-failure patterns and cross-stack inconsistencies; produces a prioritized findings report with proposed declarative fixes. Analysis only — never edits nix code.
---

> Baseline discipline: when the operator accepts findings and you append
> them to `baseline.md`, commit that change in the same session
> (`git -C /etc/nixos add .claude/skills/log-audit/baseline.md && git commit`)
> — an uncommitted baseline is invisible to a fresh checkout and to the
> next audit.

# log-audit — full-boot log sweep for s2-server

You are auditing the logs of a NixOS home server after a reboot. The
goal: a **prioritized findings report** — every error, warning, and
inconsistency, categorized by priority and impact, each with a root
cause hypothesis and a proposed (declarative, nix-level) fix. The ideal
end state the operator is driving toward is a boot with zero errors and
zero warnings.

**Hard rule: this is analysis only.** Do NOT edit anything under
`/etc/nixos/`, do not restart services, do not "fix while you're in
there". Propose; never apply. Read-only shell commands only
(`journalctl`, `systemctl status/list-units`, `podman ps/inspect`,
`zpool status`, `cat`, `grep`...).

## How logging works on this box (read before querying)

- **journald is the ONE source.** Every container runs rootless podman
  with `--log-driver=journald`. Native NixOS services (pihole-ftl,
  pihole-web, ddclient, smartd, sshd, zfs-* timers/oneshots,
  app-*-deploy, nixos-rebuild activation) log as normal systemd units.
- **Container output is NOT under `podman-<name>.service`.** That unit
  only records lifecycle (`podman run` output, restarts, failures).
  The app's stdout/stderr lands in santiago's user journal
  (`_SYSTEMD_UNIT=user@1000.service`) tagged `CONTAINER_NAME=<name>`.
  Query with `journalctl -b CONTAINER_NAME=<name>`, never `-u podman-<name>`
  (query that too, but only for lifecycle problems).
- **Priority is unreliable for containers.** The journald driver maps
  stdout → PRIORITY=6 (info) and stderr → PRIORITY=3 (err), regardless
  of content. Apps that log errors to stdout hide them from `-p err`;
  apps that log everything to stderr (common) flood `-p err` with
  harmless lines. You need BOTH priority filtering AND content pattern
  matching, and you must judge each hit on its content.
- **Volume**: a multi-day boot accumulates tens of thousands of
  warning+ entries. NEVER dump raw logs into context. Aggregate first
  (`wc -l`, `awk | sort | uniq -c | sort -rn`), then sample the top
  patterns with `head`/`grep -m`.
- Loki + Alloy (stacks/logging) mirror the journal, but Loki is
  reachable only on monitoring-net (no host port, no traefik route by
  design). Use `journalctl` directly; don't try to query Loki.
- Podman as the operator user:
  `sudo -u santiago env HOME=/home/santiago XDG_RUNTIME_DIR=/run/user/1000 podman ...`
  (needed if the session runs as root; plain `podman` if already santiago).
- Reference docs: `/etc/nixos/CLAUDE.md` (or the repo copy in the cwd)
  documents known quirks — the oneshot trap, sdnotify nag, pi-hole
  sinkholed registries, the 70-vs-105 postgres UID trap, etc. Check a
  suspected finding against it before reporting; some "issues" are
  documented, accepted trade-offs (report those separately, see
  Baseline below).

## Phase 0 — establish scope

1. `journalctl --list-boots` — confirm which boot to audit. Default is
   the current boot (`-b`). If the operator says "since the reboot" and
   the current boot is recent, that's `-b`; if they rebooted twice,
   ask which one matters or audit both.
2. Boot health snapshot:
   - `systemd-analyze` and `systemd-analyze blame | head -20` — slow or
     stuck units at boot.
   - `systemctl --failed` and `sudo -u santiago env XDG_RUNTIME_DIR=/run/user/1000 systemctl --user --failed`
   - `systemctl is-system-running` (expect `running`, not `degraded`)
3. Read the baseline file (`baseline.md` next to this skill, if it
   exists) — findings the operator has already triaged as accepted.
   Don't re-report them as new; list them in a short "known/accepted"
   appendix only if their volume or shape changed.

## Phase 1 — system-level sweep (host, kernel, native services)

- Kernel: `journalctl -b -k -p warning --no-pager` — look for OOM
  kills, hardware errors (I/O, EDAC, thermal), ZFS module complaints,
  i915/GPU errors, filesystem errors. Kernel warnings are almost never
  noise; treat each distinct one as a finding.
- Coredumps: `coredumpctl list --since <boot time>` (if available).
- Storage integrity: `zpool status -x`; `zfs list -o name,mountpoint,mounted`
  — every declared dataset mounted? A container writing into an
  unmounted underlay is silent data loss (the RequiresMountsFor trap).
- Native units, warning+ per unit — aggregate first:
  `journalctl -b -p warning --no-pager | grep -v 'CONTAINER_NAME\|user@1000' | awk '{print $5}' | sort | uniq -c | sort -rn`
  then drill into each unit that appears: pihole-ftl (DNS/DHCP errors,
  rate limiting), ddclient (Cloudflare auth/update failures), smartd
  (ANY smartd warning is P1 — no mail notifications exist, logs are
  the only signal), sshd (auth failures — note volume/source IPs),
  sops-nix activation, zfs-snapshot/scrub/trim units, nixos activation.
- Timers: `systemctl list-timers --all --no-pager` — anything with
  `n/a` last-run that should have fired, or a timer whose service
  failed last run.
- Auto-deploy loop: `cat /var/lib/app-deploy/*` — any `failed` state;
  `journalctl -b -u 'app-*-deploy.service' -p warning`. Also check
  `flake-autoupgrade.service` last result.

## Phase 2 — container fleet integrity (before reading their logs)

The known failure mode here (documented in CLAUDE.md): podman units are
`Type=oneshot` + `RemainAfterExit`, so a container that crashed mid-life
leaves its unit **active (exited)** while the container is dead.
`systemctl --failed` will NOT catch it. So:

1. Expected fleet: `systemctl list-units 'podman-*' --all --no-pager`
   (exclude `podman-network-*` oneshots).
2. Actual fleet: `podman ps -a --format '{{.Names}} {{.State}} {{.Status}}'`.
3. Diff them. Flag: units without a running container, containers in
   `Exited`/`Created`, and containers whose uptime is much shorter than
   the boot (= they died and got restarted, or were started late).
4. Restart/flapping detection: a container restarted mid-boot shows
   multiple PIDs in the journal —
   `journalctl -b -p warning --no-pager | grep -oE '^[A-Za-z]+ [0-9]+ [0-9:]+ \S+ (\S+)\[[0-9]+\]' | awk '{print $NF}' | sort -u`
   or simpler: for each container, `podman inspect --format '{{.RestartCount}} {{.State.StartedAt}}' <name>`
   and compare StartedAt against boot time.
5. Health checks: `podman ps --filter health=unhealthy`.

## Phase 3 — per-container log sweep (the bulk of the work)

Enumerate every container that logged this boot:
`journalctl -b -F CONTAINER_NAME` (this includes short-lived ones —
deploy pulls, image builds — which is intentional; a repeatedly-failing
transient container is a finding).

For EACH container, in this order (cheap → expensive):

1. Volume + priority profile:
   `journalctl -b CONTAINER_NAME=<n> --no-pager | wc -l` and
   `journalctl -b CONTAINER_NAME=<n> -p warning --no-pager | wc -l`
2. If the warning+ count is nonzero, aggregate the shapes before
   reading: pipe through
   `sed 's/[0-9][0-9:T.,-]*//g' | sort | uniq -c | sort -rn | head -15`
   (strip timestamps/ids so identical messages collapse).
3. Content-level error scan of the FULL stream (catches errors that
   went to stdout at priority info):
   `journalctl -b CONTAINER_NAME=<n> -o cat --no-pager | grep -icE 'error|fatal|panic|fail|exception|traceback|denied|refused|unreachable|timeout|corrupt|read-only'`
   then the same aggregation trick on the matches. Expect false
   positives ("0 errors", "Failed: 0", URLs containing "fail") — judge
   content, count only real ones.
4. Look specifically for cross-cutting patterns:
   - DNS failures (pi-hole dependency, sinkholed registries)
   - connection refused/reset to `pg`, `host.containers.internal`,
     `traefik`, `loki` — inter-stack wiring breakage
   - permission denied / read-only filesystem — UID-mapping or
     tmpfiles-ownership problems (the 70-vs-105 trap)
   - TLS/cert errors (traefik ACME, expired internal certs)
   - repeated auth failures (expired tokens: GHCR PAT, Cloudflare,
     ProtonVPN port-forward 403)
   - "waiting for"/retry loops longer than a few minutes after boot —
     ordering races that converged but indicate missing `after=`/`wants=`
   - deprecation warnings announcing behavior changes on next image bump

**Fan-out**: this is ~50 containers. Group them by stack (tv, immich,
nextcloud, monitoring+logging, apps platform + app-db, traefik+network
infra, everything else) and run one read-only Explore subagent per
group in parallel, each returning: per-container real-error count,
top 3 distinct issues with one sample line each, and anything matching
the cross-cutting patterns. Give each agent the container-log gotchas
from "How logging works" above (CONTAINER_NAME queries, stdout/stderr
priority quirk, aggregate-don't-dump). Traefik deserves its own pass:
its access/error log reveals problems in OTHER stacks (404/502/503 per
router → broken upstream).

## Phase 4 — cross-checks and inconsistencies

These catch problems no single log line shows:

- **Boot ordering**: units that hit start-limit or needed many retries
  (`journalctl -b | grep -E 'start request repeated too quickly|Failed with result|scheduled restart' | sort | uniq -c` style aggregation).
  The platform allows 20 retries/10min for first-boot races — retries
  that happen EVERY boot are a finding (missing dependency), even if
  they eventually converge.
- **Time**: NTP sync (`timedatectl`), containers logging in the wrong
  timezone (TZ is injected by mkRootlessContainer — a mismatch means a
  stack bypasses the helper).
- **Disk/quota pressure**: `zfs list -o name,used,avail`, journal disk
  usage (`journalctl --disk-usage`), snapshot growth on
  `rpool/selfhost`.
- **Log hygiene as its own finding class**: a container producing
  thousands of routine lines per hour at err-priority (stderr abuse) or
  debug spam at info pollutes Loki and buries real errors. Recommend
  app-level log-level config (declaratively, via env/config in its nix
  module) — this is how the operator gets to "zero warnings".
- **Silence**: expected periodic loggers that logged NOTHING this boot
  (ddclient poll, zfs snapshot timers, nextcloud-cron, recyclarr,
  app deploy ticks) — absence of logs is an inconsistency too.

## Phase 5 — the report

Deliver a single markdown report in the final message. Structure:

1. **TL;DR** — one paragraph: boot verdict (clean / degraded / N real
   issues), the single most important finding.
2. **Findings by priority**, each with: affected stack/unit, evidence
   (1-3 sample log lines, counts), impact, root-cause hypothesis,
   proposed fix as a *declarative* change (which file under
   `/etc/nixos/`, what kind of change — but do NOT write the code
   unless the fix is a one-liner worth showing). Priorities:
   - **P1 — act now**: data-integrity risk (unmounted dataset being
     written, ZFS/SMART errors, backup-path breakage), security
     signal, a service down that others depend on (pi-hole, traefik,
     app-db pg), silent-failure states (dead container behind
     active-exited unit, failed deploy state).
   - **P2 — degraded / will bite soon**: flapping containers, retry
     loops on every boot, expiring credentials (GHCR PAT, wg0.conf,
     ACME), functional errors inside an app users actively use,
     unhealthy health checks.
   - **P3 — hygiene / noise**: log spam, stderr abuse, deprecation
     warnings, cosmetic eval warnings, timezone mismatches, chatty
     debug levels. These matter because the goal is zero-warning boots.
3. **Known/accepted** — anything matching `baseline.md` or documented
   as an accepted trade-off in CLAUDE.md (sdnotify nag, pi-hole hash,
   etc.). One line each.
4. **Stats appendix** — per-stack table: log lines this boot, warning+
   lines, real errors found. Makes noise trends visible across audits.

After the operator triages: offer to append accepted findings to
`baseline.md` (in this skill's directory — that file you MAY write) so
the next audit doesn't re-report them. Never write anything else.
