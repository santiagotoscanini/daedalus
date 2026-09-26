# A nightly `git bundle` of the configuration checkout into the state tree.
#
# The checkout (`fleet.config.repo`) IS the system, and on the reference host
# it lives on the root filesystem, which nothing snapshots. Its only other
# copy is the GitHub remote — so a commit that has
# not been pushed (the weekly upgrade when the WAN is down, a session that
# stopped before its push) exists exactly once, on the one disk whose failure
# is the reason to want it. The state tree is snapshotted and mirrored to the
# second pool; a bundle there rides both for free.
#
# A bundle, not a copy: one file, every ref, verifiable with `git bundle
# verify`, and restorable with `git clone <file>`. It carries tracked history
# only — no working-tree dirt, and none of the secrets a checkout never held.
#
# 03:47, not the hour: :00 is where scheduled network-heavy work (a
# speedtest) lands, and a job there shares its blackout.
{
  config,
  pkgs,
  ...
}:

let
  cfg = config.fleet;
  dir = "${cfg.stateRoot}/daedalus/config-bundle";
in
{
  fleet.statePaths."${dir}" = { };

  systemd.services.config-bundle = {
    description = "Bundle the configuration checkout into the snapshotted state tree";
    after = [ "state-paths.service" ];
    path = [
      pkgs.git
      pkgs.coreutils
    ];
    serviceConfig = {
      Type = "oneshot";
      User = cfg.operator.user;
      Group = cfg.operator.group;
    };
    script = ''
      set -eu
      cd ${cfg.config.repo}
      tmp=$(mktemp ${dir}/.config.bundle.XXXXXX)
      trap 'rm -f "$tmp"' EXIT
      git bundle create "$tmp" --all >/dev/null 2>&1
      git bundle verify "$tmp" >/dev/null 2>&1
      mv -f "$tmp" ${dir}/config.bundle
      trap - EXIT
      echo "config-bundle: $(git rev-parse --short HEAD), $(du -h ${dir}/config.bundle | cut -f1)"
    '';
  };

  systemd.timers.config-bundle = {
    wantedBy = [ "timers.target" ];
    timerConfig = {
      OnCalendar = "*-*-* 03:47:00";
      Persistent = true;
      RandomizedDelaySec = "5m";
    };
  };

  fleet.monitoredJobs.config-bundle = { };
}
