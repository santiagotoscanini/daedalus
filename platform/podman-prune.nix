# platform/podman-prune — weekly reclaim of the rootless image store.
#
# The fleet pins images and pulls out-of-band (see CLAUDE.md "A moving
# tag is never re-pulled"), so every update, every mkLocalImage rebuild,
# and every apps-platform redeploy leaves the previous image behind as an
# unreferenced orphan. Left alone the santiago rootless store grows
# unbounded (it had crept to ~26 GB reclaimable / 46% before the first
# manual sweep). This prunes it on a schedule.
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
    description = "Prune unreferenced images from santiago's rootless podman store";
    serviceConfig.Type = "oneshot";
    # Runs as root and drops to santiago via setpriv (no PAM session,
    # matching stacks/apps + autoupgrade) — the image store lives in
    # santiago's rootless graphroot, reachable only through her runtime
    # session (lingering is on, so /run/user/1000 exists at boot).
    script = ''
      ${pkgs.util-linux}/bin/setpriv --reuid santiago --regid users --init-groups --inh-caps=-all \
        ${pkgs.coreutils}/bin/env HOME=/home/santiago XDG_RUNTIME_DIR=/run/user/1000 \
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
