# Local ZFS replication — the box's only backup today.
#
# Replicates the two irreplaceable rpool (NVMe SSD) datasets onto the
# s2-pool (2×16 TB HDD mirror) so a single NVMe failure no longer loses
# every container DB + the home dir:
#
#   rpool/selfhost  ->  s2-pool/backup/selfhost   (all stack state/DBs)
#   rpool/home      ->  s2-pool/backup/home       ($HOME, incl. the repo)
#
# This is NOT off-site (that's a FUTURE.md item) — it only survives an
# rpool-side failure, not a house fire or a two-drive s2-pool loss. It is
# still the single biggest data-safety win available on one box.
#
# ── Why syncoid --no-sync-snap (ride the existing auto-snapshots) ────────
# `services.zfs.autoSnapshot` already takes frequent (15-min) / hourly /
# daily snapshots on both source datasets (platform/zfs.nix). With
# `--no-sync-snap`, syncoid replicates up to the newest EXISTING snapshot
# instead of taking its own `syncoid_*` snapshot every run. Rationale:
#   - No duplicate snapshot churn on rpool/selfhost, whose 16K recordsize
#     + high DB write rate already makes snapshot deltas the thing we watch.
#   - Hourly replication always has a <15-min-old `frequent` snapshot to
#     sync to, so the replica is never more than ~1 h + 15 min behind.
#   - The replica's history mirrors the source's snapshot history for free
#     — restores can reach into `.zfs/snapshot/` on the backup copy too.
#
# ── Target datasets: not mounted, not re-snapshotted ─────────────────────
# `s2-pool/backup` is created with mountpoint=none and
# com.sun:auto-snapshot=false; children inherit both. mountpoint=none keeps
# the replica from ever mounting over /home or the live selfhost tree, and
# auto-snapshot=false keeps the receive side from growing its own snapshot
# set (which would also break incremental `zfs receive`). The replica's
# retained history is whatever came across from the source.
#
# ── One-time bootstrap (imperative, allowed) ─────────────────────────────
# The parent dataset must exist before the first receive:
#   zfs create -o mountpoint=none -o com.sun:auto-snapshot=false s2-pool/backup
# The two child datasets are created automatically by the first
# `zfs receive`. The `datasets` attrset in platform/zfs.nix carries all
# three so zfs-converge re-asserts the properties and the declaration
# matches reality (missing children are skipped+logged until first run).
#
# Permission delegation (zfs allow send/hold on source, create/mount/
# receive/rollback on target) is handled automatically by the NixOS
# syncoid module for the unprivileged `syncoid` user — no manual grants.

{ ... }:

{
  services.syncoid = {
    enable = true;
    interval = "hourly";

    # --no-sync-snap: ride the auto-snapshots instead of cutting our own
    #   (see header).
    # --quiet: drop syncoid's `pv` progress-meter stage from the
    #   `zfs send | mbuffer | pv | zfs receive` pipe. The bundled
    #   pv-1.10.1 aborts intermittently (SIGABRT) under headless piping,
    #   and a crashed pv breaks the pipe and fails the whole replication.
    #   A progress bar is worthless in a systemd service with no TTY, and
    #   suppressing it also keeps the per-snapshot INFO spam out of
    #   journald/Loki — only errors remain. mbuffer (buffering) stays.
    commonArgs = [ "--no-sync-snap" "--quiet" ];

    commands = {
      "rpool/selfhost".target = "s2-pool/backup/selfhost";
      "rpool/home".target = "s2-pool/backup/home";
    };
  };
}
