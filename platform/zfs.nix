# Single source of truth for ZFS on this host: boot config, pool
# maintenance, snapshot timers, dataset properties, mounts.
#
# Each entry in `datasets` may set:
#   properties = { ... };  Re-applied every rebuild by zfs-converge.service
#                          (diff-then-`zfs set`, no-op when matching).
#                          Missing datasets are skipped + logged.
#   mount      = "/path";  Emits a fileSystems."<path>" entry. rpool/*
#                          mounts live in hardware-configuration.nix.
#
# Dataset CREATION is NOT automated. Pools are created once at install
# and children via `zfs create -o mountpoint=legacy <pool>/<name>`.
# The list below documents which children exist if you ever need to recreate.
#
# Snapshot policy: services.zfs.autoSnapshot fires every 15min/hour/day/week
# and prunes to the count below. Per-dataset opt-in via
# `com.sun:auto-snapshot=true`; per-tier override via
# `com.sun:auto-snapshot:<tier>`. Window math: count × cadence = retention.
# Older data is an off-site-backup problem, not local snapshots.
#
# Per-dataset tier choices:
#   rpool/{home,selfhost}     skip weekly (frequent+hourly+daily is plenty;
#                             selfhost's DB churn × 1-month would balloon).
#   s2-pool/{santi,sofi,shared,
#            immich,books}    skip frequent (files don't change every 15min).
#   s2-pool/tv                no snapshots (re-downloadable).

{
  lib,
  pkgs,
  utils,
  ...
}:

let
  # Opt-in for any dataset we want snapshotted. Per-tier opt-outs layered on top.
  snapshotOn = {
    "com.sun:auto-snapshot" = "true";
  };

  datasets = {
    # rpool (SSD) — properties only. Mounts in hardware-configuration.nix.

    "rpool" = {
      properties = {
        compression = "lz4";
        atime = "off";
        xattr = "on";
        acltype = "posix";
        mountpoint = "none";
      };
    };

    "rpool/root" = {
      properties = {
        mountpoint = "legacy";
        "com.sun:auto-snapshot" = "false";
      };
    };

    "rpool/nix" = {
      properties = {
        mountpoint = "legacy";
        "com.sun:auto-snapshot" = "false";
      };
    };

    "rpool/home" = {
      properties = snapshotOn // {
        mountpoint = "legacy";
        "com.sun:auto-snapshot:weekly" = "false";
      };
    };

    "rpool/selfhost" = {
      properties = snapshotOn // {
        mountpoint = "legacy";
        # Matches typical postgres page size; 128K would amplify writes
        # ~8x for small-row DB updates.
        recordsize = "16K";
        "com.sun:auto-snapshot:weekly" = "false";
      };
    };

    # s2-pool (HDD) — properties + mount.

    "s2-pool" = {
      properties = {
        compression = "lz4";
        mountpoint = "legacy";
      };
      mount = "/s2";
    };

    "s2-pool/santi" = {
      mount = "/s2/santi";
      properties = snapshotOn // {
        mountpoint = "legacy";
        "com.sun:auto-snapshot:frequent" = "false";
      };
    };

    "s2-pool/sofi" = {
      mount = "/s2/sofi";
      properties = snapshotOn // {
        mountpoint = "legacy";
        "com.sun:auto-snapshot:frequent" = "false";
      };
    };

    "s2-pool/shared" = {
      mount = "/s2/shared";
      properties = snapshotOn // {
        mountpoint = "legacy";
        "com.sun:auto-snapshot:frequent" = "false";
      };
    };

    "s2-pool/immich" = {
      mount = "/s2/immich";
      properties = snapshotOn // {
        mountpoint = "legacy";
        "com.sun:auto-snapshot:frequent" = "false";
      };
    };

    "s2-pool/books" = {
      mount = "/s2/books";
      properties = snapshotOn // {
        mountpoint = "legacy";
        "com.sun:auto-snapshot:frequent" = "false";
      };
    };

    "s2-pool/tv" = {
      mount = "/s2/tv";
      properties.mountpoint = "legacy";
    };

    # Local replication targets (platform/backup.nix). Not mounted
    # (replica, never mounts over the live tree) and NOT snapshotted on
    # the receive side (auto-snapshot=false; its history is whatever the
    # source sent). Parent created once by hand:
    #   zfs create -o mountpoint=none -o com.sun:auto-snapshot=false s2-pool/backup
    # Children are born on the first `zfs receive` — skipped+logged by
    # zfs-converge until then.
    "s2-pool/backup" = {
      properties = {
        mountpoint = "none";
        "com.sun:auto-snapshot" = "false";
      };
    };

    "s2-pool/backup/selfhost" = {
      properties = {
        mountpoint = "none";
        "com.sun:auto-snapshot" = "false";
      };
    };

    "s2-pool/backup/home" = {
      properties = {
        mountpoint = "none";
        "com.sun:auto-snapshot" = "false";
      };
    };
  };

  toMount = lib.filterAttrs (_: v: v ? mount) datasets;

  mountUnits = lib.mapAttrsToList (_: v: "${utils.escapeSystemdPath v.mount}.mount") toMount;

  # One bad property must not abort the rest (or, worse, block the
  # mounts ordered after this unit): each `zfs set` failure logs and
  # continues, and the unit exits nonzero at the end for visibility.
  convergeScript = pkgs.writeShellScript "zfs-converge" ''
    set -u
    ZFS=${pkgs.zfs}/bin/zfs
    fail=0

    # Reads current value, writes only on diff. Skips missing datasets
    # (e.g. recovery boot before s2-pool import).
    set_if_different() {
      local ds="$1" key="$2" want="$3" have
      have=$($ZFS get -H -o value "$key" "$ds" 2>/dev/null) || {
        echo "  skip:  $ds ($key — dataset missing)"
        return 0
      }
      if [ "$have" != "$want" ]; then
        echo "  set:   $ds  $key: $have -> $want"
        $ZFS set "$key=$want" "$ds" || {
          echo "  FAIL:  $ds  $key" >&2
          fail=1
        }
      fi
    }

    ${lib.concatStringsSep "\n" (
      lib.mapAttrsToList (
        ds: v:
        lib.optionalString (v ? properties) (
          lib.concatMapStringsSep "\n" (
            k:
            "    set_if_different ${lib.escapeShellArg ds} "
            + "${lib.escapeShellArg k} "
            + "${lib.escapeShellArg v.properties.${k}}"
          ) (lib.attrNames v.properties)
        )
      ) datasets
    )}

    exit "$fail"
  '';
in
{
  boot.supportedFilesystems = [ "zfs" ];

  boot.zfs = {
    # Stable by-id paths survive kernel drive renames.
    devNodes = "/dev/disk/by-id";
    # The pool carries this host's hostid — force-import would defeat
    # ZFS's split-brain guard.
    forceImportRoot = false;
  };

  # rpool/* mounts stay in hardware-configuration.nix.
  fileSystems = lib.mapAttrs' (
    ds: v:
    lib.nameValuePair v.mount {
      device = ds;
      fsType = "zfs";
    }
  ) toMount;

  # Dead-man's-switch pings only (email = false): a MISSED run is the
  # failure mode that matters for snapshots/scrub; a run that fails
  # loudly already lands in the failed-units alert.
  fleet.monitoredJobs = {
    zfs-snapshot-daily = {
      slug = "zfs-snapshot-daily";
      email = false;
    };
    zfs-scrub = {
      slug = "zfs-scrub";
      email = false;
    };
  };

  services.zfs = {
    autoScrub.enable = true; # monthly — catches bit-rot
    trim.enable = true; # SSD; no-op on HDDs in s2-pool

    autoSnapshot = {
      enable = true;
      flags = "-k -p --utc";
      frequent = 4; # last hour
      hourly = 24; # last day
      daily = 7; # last week
      weekly = 4; # last month
      monthly = 0; # off-site backup territory
    };
  };

  # Quiet no-op when properties match; logs `set:` on actual changes.
  # wantedBy (not requiredBy): a failed converge must never block the
  # /s2 mounts — and with them most of the container fleet. Ordering
  # via `before` still guarantees properties apply first when it runs;
  # a failure surfaces through emailOnFailure + the failed-units alert.
  systemd.services.zfs-converge = {
    description = "Converge ZFS dataset properties";
    # zfs-import.target covers every imported pool (rpool is imported in
    # initrd and has no per-pool import unit).
    after = [ "zfs-import.target" ];
    wants = [ "zfs-import.target" ];
    before = mountUnits;
    wantedBy = mountUnits;
    unitConfig.DefaultDependencies = false;
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      ExecStart = convergeScript;
    };
  };

  # A silently-failed converge would leave declared properties drifted.
  fleet.monitoredJobs.zfs-converge = { };
}
