# The ZFS mechanism: boot config, pool maintenance, snapshot timers, and the
# converge of dataset properties + mounts from one table.
#
# DECLARES `fleet.zfs.*`; the host DEFINES it (this box: host/storage.nix).
# No pool or dataset is named here — an engine cannot know what disks a box
# has. Each entry in `fleet.zfs.datasets` may set:
#   properties = { ... };  Re-applied every rebuild by zfs-converge.service
#                          (diff-then-`zfs set`, no-op when matching).
#                          Missing datasets are skipped + logged.
#   mount      = "/path";  Emits a fileSystems."<path>" entry. Install-time
#                          mounts stay in hardware-configuration.nix; datasets
#                          created later declare theirs in the table.
#   mountOptions = [ ... ]; fileSystems options for that entry (e.g.
#                          "nofail" for a dataset the boot must not wait on).
#
# Dataset CREATION is NOT automated — the table documents and tunes what
# exists, it never runs `zfs create`.
#
# Snapshot policy: services.zfs.autoSnapshot fires every 15min/hour/day/week
# and prunes to the count below. Per-dataset opt-in via
# `com.sun:auto-snapshot=true`; per-tier override via
# `com.sun:auto-snapshot:<tier>`. Window math: count × cadence = retention.
# Older data is an off-site-backup problem, not local snapshots.

{
  config,
  lib,
  pkgs,
  utils,
  ...
}:

let
  cfg = config.fleet.zfs;

  inherit (cfg) datasets;

  toMount = lib.filterAttrs (_: v: v.mount != null) datasets;

  mountUnits = lib.mapAttrsToList (_: v: "${utils.escapeSystemdPath v.mount}.mount") toMount;

  # One bad property must not abort the rest (or, worse, block the
  # mounts ordered after this unit): each `zfs set` failure logs and
  # continues, and the unit exits nonzero at the end for visibility.
  convergeScript = pkgs.writeShellScript "zfs-converge" ''
    set -u
    ZFS=${pkgs.zfs}/bin/zfs
    fail=0

    # Reads current value, writes only on diff. Skips missing datasets
    # (e.g. a recovery boot before the data pool is imported).
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
        lib.optionalString (v.properties != { }) (
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
  options.fleet.zfs = {
    datasets = lib.mkOption {
      default = { };
      example = lib.literalExpression ''
        {
          "tank/photos" = {
            mount = "/data/photos";
            properties = {
              mountpoint = "legacy";
              "com.sun:auto-snapshot" = "true";
            };
          };
        }
      '';
      description = ''
        Dataset name → how it is tuned and where it mounts. The single source
        of truth for the box's ZFS layout; pools appear as their own root
        dataset. Defined by the host, never by a stack.
      '';
      type = lib.types.attrsOf (
        lib.types.submodule {
          options = {
            properties = lib.mkOption {
              type = lib.types.attrsOf lib.types.str;
              default = { };
              description = "ZFS properties zfs-converge re-asserts on every rebuild, as `zfs get` reports them.";
            };
            mount = lib.mkOption {
              type = lib.types.nullOr lib.types.str;
              default = null;
              description = "Mountpoint to emit a `fileSystems` entry for (the dataset must be `mountpoint=legacy`). Null: not mounted from here.";
            };
            mountOptions = lib.mkOption {
              type = lib.types.listOf lib.types.str;
              default = [ ];
              description = "`fileSystems.<mount>.options`; empty leaves the NixOS default.";
            };
          };
        }
      );
    };

    arcMaxBytes = lib.mkOption {
      type = lib.types.nullOr lib.types.ints.positive;
      default = null;
      description = ''
        Cap on the ARC (`zfs_arc_max`), in bytes. Null leaves OpenZFS's own
        default, which grows to nearly all of RAM — wrong for a box whose RAM
        is mostly for containers. Applies at module load (reboot).
      '';
    };
  };

  config = {
    boot.supportedFilesystems = [ "zfs" ];

    boot.zfs = {
      # Stable by-id paths survive kernel drive renames.
      devNodes = "/dev/disk/by-id";
      # The pool carries this host's hostid — force-import would defeat
      # ZFS's split-brain guard.
      forceImportRoot = false;
    };

    # The ARC cap is the host's call (fleet.zfs.arcMaxBytes): it depends on
    # how much RAM the box has and what else wants it.
    boot.extraModprobeConfig = lib.mkIf (
      cfg.arcMaxBytes != null
    ) "options zfs zfs_arc_max=${toString cfg.arcMaxBytes}";

    # Install-time mounts stay in hardware-configuration.nix.
    fileSystems = lib.mapAttrs' (
      ds: v:
      lib.nameValuePair v.mount (
        {
          device = ds;
          fsType = "zfs";
        }
        // lib.optionalAttrs (v.mountOptions != [ ]) { options = v.mountOptions; }
      )
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
      trim.enable = true; # no-op on pools of spinning disks

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

    # monthly = 0 still generates an active timer whose service is a
    # no-op (and no monthly snapshots exist to prune) — keep it out of
    # list-timers and the log sweep.
    systemd.timers.zfs-snapshot-monthly.enable = false;

    # Quiet no-op when properties match; logs `set:` on actual changes.
    # wantedBy (not requiredBy): a failed converge must never block the
    # data mounts — and with them most of the container fleet. Ordering
    # via `before` still guarantees properties apply first when it runs;
    # a failure surfaces through its monitoredJobs mail (below) + the
    # failed-units alert.
    systemd.services.zfs-converge = {
      description = "Converge ZFS dataset properties";
      # zfs-import.target covers every imported pool (the root pool is imported in
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
  };
}
