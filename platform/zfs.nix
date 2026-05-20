# Single source of truth for everything ZFS on this host: boot config,
# pool maintenance, snapshot timers, dataset properties, and mounts.
#
# Datasets are declared once in `datasets` below. Each entry may set:
#
#   properties = { ... };  Re-applied on every nixos-rebuild via
#                          zfs-converge.service. Each property is
#                          diffed against the current value and `zfs
#                          set` runs only if they differ. Silent
#                          no-op when on-disk state matches.
#                          Missing datasets are skipped (logged).
#
#   mount      = "/path";  Emits a fileSystems."<path>" entry. rpool/*
#                          mounts live in hardware-configuration.nix
#                          and are deliberately not declared here.
#
# Dataset CREATION is intentionally not automated. Pools are created
# once at install time and their children are created once with
# `zfs create -o mountpoint=legacy <pool>/<name>`. If you ever need
# to rebuild them, the list below tells you exactly which datasets to
# create. Adding `create = true` plumbing would mostly run for nothing
# on the boots that matter.
#
# ── Snapshot policy ─────────────────────────────────────────────────
#
# The `services.zfs.autoSnapshot` timers fire on a fixed cadence
# (every 15 min / hour / day / week) and prune the corresponding tier
# to the count below. Tier counts are GLOBAL; per-dataset opt-in is
# via the `com.sun:auto-snapshot` property, with per-tier override via
# `com.sun:auto-snapshot:<tier>`.
#
# Window math (count × cadence): a tier's count IS its retention
# window. frequent=4 → 1 hour back. hourly=24 → 1 day. daily=7 →
# 1 week. weekly=4 → 1 month. Anything older is gone — that's an
# off-site backup problem, not a local-snapshot one.
#
# Per-dataset choices below:
# - rpool/{home,selfhost}: skip weekly. Frequent + hourly + daily are
#   plenty for fat-finger recovery on active data; selfhost's high DB
#   churn × 1-month weekly window would balloon snapshot size.
# - s2-pool/{santi,sofi,shared,immich}: skip frequent (files don't
#   change every 15 min). Hourly + daily + weekly give 1 month of
#   coarse recovery for personal files / photos — cheap because the
#   data is read-mostly.
# - s2-pool/supabase-storage: hourly + daily only. Drop frequent
#   (writes are big files, no value at 15-min grain) and weekly
#   (will grow with usage; revisit when it does).
# - s2-pool/tv: no snapshots. Re-downloadable; not worth the space.

{ config, lib, pkgs, utils, ... }:

let
  # Common opt-in for any dataset we want snapshotted. Per-tier opt-outs
  # are layered on top in each entry below.
  snapshotOn = { "com.sun:auto-snapshot" = "true"; };

  datasets = {
    # ── rpool (SSD) — properties only ─────────────────────────────────
    # Pool root + OS datasets created at install; mounts in
    # hardware-configuration.nix.

    "rpool" = {
      properties = {
        compression = "lz4";
        atime       = "off";
        xattr       = "on";
        acltype     = "posix";
        mountpoint  = "none";
      };
    };

    "rpool/root" = {
      properties = {
        mountpoint              = "legacy";
        "com.sun:auto-snapshot" = "false";
      };
    };

    "rpool/nix" = {
      properties = {
        mountpoint              = "legacy";
        "com.sun:auto-snapshot" = "false";
      };
    };

    "rpool/home" = {
      properties = snapshotOn // {
        mountpoint                       = "legacy";
        "com.sun:auto-snapshot:weekly"   = "false";
      };
    };

    "rpool/selfhost" = {
      properties = snapshotOn // {
        mountpoint                       = "legacy";
        # 16K matches typical postgres page size. Every container's DB
        # and bind mount lives here; 128K would amplify writes ~8x for
        # small-row updates.
        recordsize                       = "16K";
        "com.sun:auto-snapshot:weekly"   = "false";
      };
    };

    # ── s2-pool (HDD) — properties + mount ────────────────────────────

    "s2-pool" = {
      properties = {
        compression = "lz4";
        mountpoint  = "legacy";
      };
      mount = "/s2";
    };

    "s2-pool/santi" = {
      mount = "/s2/santi";
      properties = snapshotOn // {
        mountpoint                       = "legacy";
        "com.sun:auto-snapshot:frequent" = "false";
      };
    };

    "s2-pool/sofi" = {
      mount = "/s2/sofi";
      properties = snapshotOn // {
        mountpoint                       = "legacy";
        "com.sun:auto-snapshot:frequent" = "false";
      };
    };

    "s2-pool/shared" = {
      mount = "/s2/shared";
      properties = snapshotOn // {
        mountpoint                       = "legacy";
        "com.sun:auto-snapshot:frequent" = "false";
      };
    };

    "s2-pool/immich" = {
      mount = "/s2/immich";
      properties = snapshotOn // {
        mountpoint                       = "legacy";
        "com.sun:auto-snapshot:frequent" = "false";
      };
    };

    "s2-pool/supabase-storage" = {
      mount = "/s2/supabase-storage";
      properties = snapshotOn // {
        mountpoint                       = "legacy";
        "com.sun:auto-snapshot:frequent" = "false";
        "com.sun:auto-snapshot:weekly"   = "false";
      };
    };

    # tv is intentionally NOT snapshotted (re-downloadable).
    "s2-pool/tv" = {
      mount = "/s2/tv";
      properties.mountpoint = "legacy";
    };
  };

  toMount = lib.filterAttrs (_: v: v ? mount) datasets;

  mountUnits = lib.mapAttrsToList
    (_: v: "${utils.escapeSystemdPath v.mount}.mount") toMount;

  convergeScript = pkgs.writeShellScript "zfs-converge" ''
    set -eu
    ZFS=${pkgs.zfs}/bin/zfs

    # Converge a single property. Reads the current value, only writes
    # when different. Skips datasets that don't exist (e.g. recovery
    # boot before s2-pool import).
    set_if_different() {
      local ds="$1" key="$2" want="$3" have
      have=$($ZFS get -H -o value "$key" "$ds" 2>/dev/null) || {
        echo "  skip:  $ds ($key — dataset missing)"
        return 0
      }
      if [ "$have" != "$want" ]; then
        echo "  set:   $ds  $key: $have -> $want"
        $ZFS set "$key=$want" "$ds"
      fi
    }

    ${lib.concatStringsSep "\n"
      (lib.mapAttrsToList
        (ds: v: lib.optionalString (v ? properties)
          (lib.concatMapStringsSep "\n"
            (k:
              "    set_if_different ${lib.escapeShellArg ds} "
              + "${lib.escapeShellArg k} "
              + "${lib.escapeShellArg v.properties.${k}}")
            (lib.attrNames v.properties)))
        datasets)}
  '';
in
{
  # ── Boot-time ZFS support ──────────────────────────────────────────
  boot.supportedFilesystems = [ "zfs" ];

  boot.zfs = {
    # Stable by-id device paths so the pool survives kernel drive renames.
    devNodes = "/dev/disk/by-id";
    # Off after the first force-import re-stamped rpool with this host's
    # hostid; split-brain guard now active.
    forceImportRoot = false;
  };

  # ── Mounts (rpool/* stay in hardware-configuration.nix) ────────────
  fileSystems = lib.mapAttrs'
    (ds: v: lib.nameValuePair v.mount {
      device = ds;
      fsType = "zfs";
    })
    toMount;

  # ── Maintenance + snapshot timers ──────────────────────────────────
  services.zfs = {
    # Monthly scrub — verifies every block's checksum, catches bit-rot.
    autoScrub.enable = true;

    # SSD/NVMe TRIM. Pool-level; no-op on rotational drives in s2-pool.
    trim.enable = true;

    # Snapshot tiers fire on every dataset with
    # `com.sun:auto-snapshot=true` (and not opted out of the specific
    # tier). Counts apply globally; opt-in is per-dataset above.
    autoSnapshot = {
      enable   = true;
      flags    = "-k -p --utc";
      frequent = 4;   # 4 × 15 min = last hour
      hourly   = 24;  # last day
      daily    = 7;   # last week
      weekly   = 4;   # last month
      monthly  = 0;   # monthly+ belongs in off-site backups, not local
    };
  };

  # ── Property convergence ───────────────────────────────────────────
  # Runs on every nixos-rebuild + every boot. Quiet no-op when on-disk
  # properties already match `datasets`; logs `set:` lines on every
  # actual change.
  systemd.services.zfs-converge = {
    description = "Converge ZFS dataset properties";
    after = [
      "zfs-import-rpool.service"
      "zfs-import-s2-pool.service"
    ];
    wants = [
      "zfs-import-rpool.service"
      "zfs-import-s2-pool.service"
    ];
    before     = mountUnits;
    requiredBy = mountUnits;
    unitConfig.DefaultDependencies = false;
    serviceConfig = {
      Type            = "oneshot";
      RemainAfterExit = true;
      ExecStart       = convergeScript;
    };
  };
}
