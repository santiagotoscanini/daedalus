# platform/podman-prune — weekly reclaim of the rootless image store.
#
# The fleet pins images and pulls out-of-band (oci-containers' `--pull
# missing` never re-pulls a tag), so every update, every mkLocalImage
# rebuild, and every apps-platform redeploy leaves the previous image behind
# as an unreferenced orphan. Left alone the operator's rootless store grows
# unbounded. This prunes it on a schedule.
#
# Scope is deliberately narrow: `image prune` only — never `system prune`,
# which would also drop the podman networks (the traefik/app-db/… bridges)
# whenever their containers happen to be momentarily down. Containers,
# networks and volumes are left untouched.
#
# `--filter until=168h` is the safety margin: an image is removed only if
# it is BOTH unreferenced by any container (running or stopped) AND older
# than 7 days. So a freshly built/pulled image that is briefly unreferenced
# — a redeploy mid-restart, a `--rm` seed helper that just exited — is kept
# for a week rather than pruned and re-pulled. Genuine orphans age out.

{
  config,
  pkgs,
  ...
}:

{
  # OnFailure mail (platform/mail). No dead-man ping: a skipped prune only
  # means disk creeps until the next run — not worth paging over.
  fleet.monitoredJobs.podman-image-prune = { };

  systemd.services.podman-image-prune = {
    description = "Prune unreferenced images from ${config.fleet.operator.user}'s rootless podman store";
    serviceConfig.Type = "oneshot";
    # Runs as root and drops to the operator via setpriv (no PAM session,
    # matching modules/apps + autoupgrade) — the image store lives in
    # the operator's rootless graphroot, reachable only through their runtime
    # session (lingering is on, so the runtime dir exists at boot).
    script = ''
      ${pkgs.util-linux}/bin/setpriv --reuid ${config.fleet.operator.user} --regid ${config.fleet.operator.group} --init-groups --inh-caps=-all \
        ${pkgs.coreutils}/bin/env HOME=${config.fleet.operator.home} XDG_RUNTIME_DIR=${config.fleet.operator.runtimeDir} \
        ${pkgs.podman}/bin/podman image prune --all --force --filter until=168h
    '';
  };

  systemd.timers.podman-image-prune = {
    wantedBy = [ "timers.target" ];
    timerConfig = {
      OnCalendar = "weekly";
      Persistent = true; # replay a window missed while the box was off
      RandomizedDelaySec = "30min";
    };
  };
}
