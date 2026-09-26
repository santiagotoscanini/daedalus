# builder/storage — where builds do their work: the scratch dataset's layout,
# the check that it is really mounted, and the build log directory. A plain
# function imported by ../builder.nix; never a module.
#
# A dataset of its own (the host's `fleet.zfs.datasets`) at
# /var/lib/daedalus-builds, quota 150G, never snapshotted, `nofail`. The layout
# under it is created by daedalus-builds-layout.service, which carries
# RequiresMountsFor — NOT by systemd.tmpfiles: a nofail mount is not ordered
# before local-fs.target, so boot-time tmpfiles could create the dirs in the
# underlay a moment before the dataset mounts over them. `nofail` also makes a
# FAILED mount silent, which is what daedalus-builds-mounted.service (below,
# hourly, monitoredJobs) is for.
#
# The build logs are NOT on the dataset: /var/log/daedalus-builds is on the
# root filesystem, so the log dir (and app-daedalus's read-only mount of it)
# never depends on the dataset.
{
  config,
  lib,
  pkgs,
}:

rec {
  cfg = config.fleet.builder;

  # miseCacheDir holds one Railpack mise cache per app, `<app>/`, each the
  # build user's (host/build.sh creates them and mounts one at /tmp/railpack
  # for that app's `railpack prepare`, with the pinned mise read-only inside).
  # The directory itself is root's alone: the build user must reach an app's
  # cache only through that mount, never by its path, or one app's prepare
  # could write into another's. build.sh refuses to mount unless it is root
  # 0700. (A `mise/` left from the shared-cache layout is inert.)
  layoutRules = pkgs.writeText "daedalus-builds-layout.conf" ''
    d ${cfg.root} 0755 root root -
    d ${cfg.root}/buildkit 0700 buildkit buildkit -
    d ${cfg.workDir} 0700 ${cfg.user} ${cfg.user} -
    d ${cfg.root}/cache 0700 ${cfg.user} ${cfg.user} -
    d ${cfg.root}/home 0700 ${cfg.user} ${cfg.user} -
    d ${cfg.miseCacheDir} 0700 root root -
  '';

  # `findmnt --target` answers for the nearest mount point at or above the
  # path, so an unmounted dataset does not error here — it reports the root dataset
  # (also zfs, which is why the SOURCE is what gets compared, not the fstype).
  # The expected device comes from the fileSystems entry platform/zfs.nix
  # generates, so the dataset name is never restated.
  # Likewise what an unmounted path falls through to (the root filesystem's
  # device) and the pool to look at — read off the box, not spelled.
  inherit (config.fileSystems.${cfg.root}) device;
  rootDevice = config.fileSystems."/".device;
  pool = lib.head (lib.splitString "/" device);

  buildsMountCheck = pkgs.writeShellScript "daedalus-builds-mounted" ''
    set -eu
    src=$(${pkgs.util-linux}/bin/findmnt -n -o SOURCE --target ${cfg.root} 2>/dev/null || true)
    if [ "$src" != ${lib.escapeShellArg device} ]; then
      echo "${device} is NOT mounted at ${cfg.root} (findmnt reports '$src')." >&2
      echo "It mounts nofail, so this is silent: buildkitd and daedalus-build carry" >&2
      echo "RequiresMountsFor and refuse to start, and no build has landed on ${rootDevice}." >&2
      unit=$(${config.systemd.package}/bin/systemd-escape -p --suffix=mount ${cfg.root})
      echo "Check: zpool status ${pool}; zfs list ${device}; systemctl status $unit" >&2
      exit 1
    fi
  '';

  # What ../builder.nix merges into the system, while the builder exists.
  settings = {
    # The dataset mounts `nofail` (the host's dataset table), so a mount that fails
    # is SILENT. Nothing is corrupted by that — buildkitd, daedalus-build
    # and the layout unit all carry RequiresMountsFor and simply refuse to
    # start, so no build ever lands in the underlay on the root filesystem — but
    # nothing SAYS so either: the box reports "builds don't run", never "the
    # disk isn't there". This unit is the thing that says it.
    #
    # Deliberately NOT ordered on the mount: a RequiresMountsFor here would
    # make the failed mount cancel the alarm along with the builds, which is
    # exactly the silence being fixed. It just looks, and the timer looks
    # again — a dataset can also go away mid-life (a manual `zfs unmount`,
    # a quota/IO fault), and the builder units are long-lived enough not to
    # notice. :17 rather than the hour, per the network-heavy-jobs rule.
    systemd.services.daedalus-builds-mounted = {
      description = "Assert ${device} is mounted at ${cfg.root}";
      wantedBy = [ "multi-user.target" ];
      after = [
        "local-fs.target"
        "zfs-mount.service"
      ];
      serviceConfig = {
        Type = "oneshot";
        ExecStart = buildsMountCheck;
      };
    };

    systemd.timers.daedalus-builds-mounted = {
      wantedBy = [ "timers.target" ];
      timerConfig = {
        OnCalendar = "*-*-* *:17:00";
        Persistent = true;
      };
    };

    # A silent missing dataset is the whole point of the unit — mail it.
    fleet.monitoredJobs.daedalus-builds-mounted = { };

    systemd.services.daedalus-builds-layout = {
      description = "Create the build scratch layout on ${device}";
      wantedBy = [ "multi-user.target" ];
      before = [ "buildkitd.service" ];
      unitConfig.RequiresMountsFor = [ cfg.root ];
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        ExecStart = "${config.systemd.package}/bin/systemd-tmpfiles --create ${layoutRules}";
      };
    };

    systemd.tmpfiles.settings."10-daedalus-builds-logs".${cfg.logDir}.d = {
      mode = "0755";
      user = "root";
      group = "root";
    };
  };
}
