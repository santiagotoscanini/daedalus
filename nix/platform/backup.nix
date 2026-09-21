# Local ZFS replication — syncoid, from one dataset to another on the same
# box. DECLARES `fleet.backup.replications`; the host DEFINES which dataset
# goes where (this box: host/backup.nix). An empty table is no syncoid at all.
#
# A second pool is not an off-site backup: it survives the loss of the source
# pool, not a fire or the loss of both.
#
# ── Why syncoid --no-sync-snap (ride the existing auto-snapshots) ────────
# `services.zfs.autoSnapshot` already takes frequent (15-min) / hourly /
# daily snapshots on a source that opts in (platform/zfs.nix). With
# `--no-sync-snap`, syncoid replicates up to the newest EXISTING snapshot
# instead of taking its own `syncoid_*` snapshot every run. Rationale:
#   - No duplicate snapshot churn on a small-recordsize, write-heavy dataset (container
#     DBs), where snapshot deltas are already the thing to watch.
#   - Hourly replication always has a <15-min-old `frequent` snapshot to
#     sync to, so the replica is never more than ~1 h + 15 min behind.
#   - The replica's history mirrors the source's snapshot history for free
#     — restores can reach into `.zfs/snapshot/` on the backup copy too.
#
# ── Target datasets: not mounted, not re-snapshotted, mirror-pruned ──────
# The target parent is created with mountpoint=none and
# com.sun:auto-snapshot=false; children inherit both. mountpoint=none keeps
# the replica from ever mounting over the live tree it copies, and
# auto-snapshot=false keeps the receive side from growing its own snapshot
# set (which would also break incremental `zfs receive`).
#
# `--delete-target-snapshots` makes the replica a strict MIRROR of the
# source's snapshot set: after each successful sync, target snapshots
# that no longer exist on the source are destroyed (oldest-first). The
# common incremental base is structurally safe — it exists on both
# sides, so it's never in the delete set. Without this flag nothing
# prunes the target: every 15-min/hourly/daily snapshot that ever
# crossed would accumulate forever (~28/day/dataset).
# Consequence to remember: MANUAL snapshots (`pre-*`) also live
# and die with their source copy — the replica is a mirror, not an
# archive. Anything to keep forever needs its own dataset or a `zfs
# send` to somewhere else first.
#
# ── One-time bootstrap (imperative, allowed) ─────────────────────────────
#
# The target's parent dataset must exist before the first receive (created
# once, by hand, `mountpoint=none` + `com.sun:auto-snapshot=false`); children
# are born on the first `zfs receive`.
#
# Permission delegation (zfs allow send/hold on source, create/mount/
# receive/rollback on target) is handled automatically by the NixOS
# syncoid module for the unprivileged `syncoid` user — no manual grants.

{ config, lib, ... }:

let
  cfg = config.fleet.backup;

  # The NixOS module names each unit `syncoid-<this>`; the monitored job must
  # carry the same name, so the escaping is restated rather than guessed.
  escapeUnitName =
    name:
    lib.concatMapStrings (s: if lib.isList s then "-" else s) (
      builtins.split "[^a-zA-Z0-9_.\\-]+" name
    );
in
{
  options.fleet.backup.replications = lib.mkOption {
    default = { };
    example = lib.literalExpression ''
      {
        "fast/state" = {
          target = "big/backup/state";
          slug = "backup-state";
        };
      }
    '';
    description = ''
      Source dataset → where syncoid mirrors it, hourly. Keyed by the source
      because that is what names the unit (`syncoid-<source, escaped>`).
    '';
    type = lib.types.attrsOf (
      lib.types.submodule {
        options = {
          target = lib.mkOption {
            type = lib.types.str;
            description = "Dataset the source is received into. A strict mirror of the source's snapshot set.";
          };
          slug = lib.mkOption {
            type = lib.types.str;
            description = "Dead-man ping slug (`fleet.monitoredJobs.<unit>.slug`) — pages when the replication stops running at all.";
          };
        };
      }
    );
  };

  config = lib.mkIf (cfg.replications != { }) {
    # Email on a failed run; healthchecks pages if replication stops
    # running entirely (period/grace: hourly).
    fleet.monitoredJobs = lib.mapAttrs' (
      source: r: lib.nameValuePair "syncoid-${escapeUnitName source}" { inherit (r) slug; }
    ) cfg.replications;

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
      commonArgs = [
        "--no-sync-snap"
        "--delete-target-snapshots"
        "--quiet"
      ];

      # Module default + destroy: --delete-target-snapshots prunes via
      # `zfs destroy` on the target, which the default delegation set
      # doesn't include — without it the flag is a silent no-op (syncoid
      # swallows the permission error under --quiet).
      localTargetAllow = [
        "change-key"
        "compression"
        "create"
        "destroy"
        "mount"
        "mountpoint"
        "receive"
        "rollback"
      ];

      commands = lib.mapAttrs (_: r: { inherit (r) target; }) cfg.replications;
    };
  };
}
