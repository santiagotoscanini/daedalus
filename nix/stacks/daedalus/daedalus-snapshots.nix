# daedalus-snapshots — the services and timers that keep the container's
# read-only /run mounts current, each snapshot's service, timer and
# monitoredJobs entry together. Most are ordered before the container so a
# cold boot renders real facts; the ones that touch the network are not. The
# scripts are snapshots-lib.nix. Part of the daedalus stack (daedalus.nix
# holds the switch); never imports its siblings.
{
  config,
  lib,
  pkgs,
  ...
}:

let
  inherit (import ./daedalus-lib.nix { inherit config lib pkgs; }) registryApps bridgeAgent;
  inherit (import ./snapshots-lib.nix { inherit config lib pkgs; })
    mkWorkspaceSyncScript
    envSnapshotScript
    imageSnapshotScript
    imageFreshnessScript
    systemSnapshotScript
    claudeSnapshotScript
    repoSnapshotScript
    registrySnapshot
    ;
in

{
  config = lib.mkIf config.fleet.modules.daedalus.enable {
    # Refresh the published environments. A timer rather than an on-demand
    # request/response through the bind mount: a container's env only changes
    # when it restarts, so a page render should read a recent snapshot rather
    # than wait on a round trip through systemd.
    systemd.services.daedalus-env-snapshot = {
      description = "Publish app container environments for daedalus";
      # Runs rootless podman, so it must not be the boot's first podman:
      # platform/podman.nix creates the userns once, in the gate.
      after = [
        "podman-rootless-ready.service"
        "linger-users.service"
      ];
      wants = [
        "podman-rootless-ready.service"
        "linger-users.service"
      ];
      before = [ "podman-app-daedalus.service" ];
      wantedBy = [ "podman-app-daedalus.service" ];
      serviceConfig = {
        Type = "oneshot";
        ExecStart = "${envSnapshotScript}/bin/daedalus-env-snapshot";
      };
    };

    systemd.timers.daedalus-env-snapshot = {
      wantedBy = [ "timers.target" ];
      timerConfig = {
        OnBootSec = "2min";
        OnUnitActiveSec = "2min";
      };
    };

    # Silent from the reader's side for the image snapshot's reason below.
    fleet.monitoredJobs.daedalus-env-snapshot = { };

    # The running images' OCI labels — where a service pinned to a moving tag
    # states the version its pin cannot. Ordered before daedalus like the env
    # snapshot, so a fresh boot has one before the first render.
    systemd.services.daedalus-image-snapshot = {
      description = "Publish running container image labels for daedalus";
      # Same gate as the env snapshot: on 2026-09-10 this unit was the
      # boot's first rootless podman, ran before the user manager had a
      # bus, and left a pause process that died with it.
      after = [
        "podman-rootless-ready.service"
        "linger-users.service"
      ];
      wants = [
        "podman-rootless-ready.service"
        "linger-users.service"
      ];
      before = [ "podman-app-daedalus.service" ];
      wantedBy = [ "podman-app-daedalus.service" ];
      serviceConfig = {
        Type = "oneshot";
        ExecStart = "${imageSnapshotScript}/bin/daedalus-image-snapshot";
      };
    };

    # Fifteen minutes, not two: an image label changes only when an image does,
    # which means a rebuild or a deploy pull — both of which restart the
    # container and re-run this via the ordering above. The timer is the
    # backstop for the third case, an out-of-band `podman pull`.
    systemd.timers.daedalus-image-snapshot = {
      wantedBy = [ "timers.target" ];
      timerConfig = {
        OnBootSec = "3min";
        OnUnitActiveSec = "15min";
      };
    };

    # Both snapshots fail SILENTLY from the reader's side, which is the whole
    # reason they are monitored. A missing image snapshot does not blank a page —
    # `imageVersion` falls back to the flake pin, and for the services whose pin
    # is a channel it reports "unknown", which is indistinguishable from a
    # service that genuinely has no version. So a stuck oneshot would show up as
    # Shelfmark and Recyclarr quietly going back to saying nothing.
    #
    # No `slug`: these are not dead-man jobs. A missed run costs a stale reading
    # of something that changes on rebuilds, so a failure email is the whole of
    # what is wanted.
    fleet.monitoredJobs.daedalus-image-snapshot = { };

    # Digest-vs-tag freshness. NOT ordered before the container, unlike the two
    # snapshots above: this dials fifty registries, and a network probe must
    # never gate the app's start — the reader treats an absent file as "not
    # checked yet" and the pages simply show no freshness verdict.
    systemd.services.daedalus-image-freshness = {
      description = "Check digest-pinned images against where their tags point now";
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];
      serviceConfig = {
        Type = "oneshot";
        ExecStart = "${imageFreshnessScript}/bin/daedalus-image-freshness";
        # ~55 refs with a polite sleep between network calls is a few minutes;
        # the oneshot default of 90s would SIGTERM it mid-list.
        TimeoutStartSec = "30min";
      };
    };

    # Daily is the honest cadence: upstream tags move on release schedules, the
    # answer feeds a verdict chip rather than an alert, and docker.io's
    # anonymous budget is the scarce resource. The four-hour jitter is the
    # rate-limit posture — never the same minute two days running, and never a
    # thundering herd with anything else nightly. The run itself is a few KB of
    # manifest reads, so the never-on-the-hour rule (a bandwidth rule) is not in
    # play; a run landing in the myspeed blackout costs error rows for a day,
    # which the reader renders as "registry did not answer".
    #
    # OnBootSec because /run is tmpfs: without it a reboot erases the file and
    # Persistent=true only covers a missed CALENDAR trigger, so the verdicts
    # would stay blank for up to a day after every boot.
    systemd.timers.daedalus-image-freshness = {
      wantedBy = [ "timers.target" ];
      timerConfig = {
        OnCalendar = "daily";
        RandomizedDelaySec = "4h";
        OnBootSec = "15min";
        Persistent = true;
      };
    };

    # Same argument as its siblings: the failure mode is silent from the
    # reader's side — verdicts quietly go stale, then (after the reader's 3-day
    # window) quietly disappear. No slug: a missed run costs a day-old reading
    # of something that moves in days.
    fleet.monitoredJobs.daedalus-image-freshness = { };

    # The host facts behind three System tabs. Reads as ROOT: smartctl needs a
    # raw device, and `zpool status` needs the pool.
    # Unlike the env and image snapshots it reads no rootless store, so it
    # drops to the operator only to publish (host/lib.sh).
    systemd.services.daedalus-system-snapshot = {
      description = "Publish SMART, ZFS and generation facts for daedalus";
      before = [ "podman-app-daedalus.service" ];
      wantedBy = [ "podman-app-daedalus.service" ];
      serviceConfig = {
        Type = "oneshot";
        ExecStart = "${systemSnapshotScript}/bin/daedalus-system-snapshot";
      };
    };

    # Same argument as the image snapshot: it fails silently from the reader's
    # side. A stale file does not blank the Disks tab, it shows yesterday's
    # temperatures as though they were now — which is worse than an empty panel,
    # because it looks like an answer.
    fleet.monitoredJobs.daedalus-system-snapshot = { };

    # Ten minutes. Everything in it moves in hours at best — a scrub runs
    # monthly, a self-test weekly, snapshot usage grows over days — and the one
    # genuinely live number, drive temperature, is not worth a shorter interval
    # on a box whose alerting has its own thresholds.
    systemd.timers.daedalus-system-snapshot = {
      wantedBy = [ "timers.target" ];
      timerConfig = {
        OnBootSec = "4min";
        OnUnitActiveSec = "10min";
      };
    };

    # Root for the same shape of reason as its sibling, though a narrower one:
    # the journal read wants the system journal rather than a user one. What it
    # reads out of ~/.claude it reads as the operator (host/claude-snapshot.sh).
    systemd.services.daedalus-claude-snapshot = {
      description = "Publish Claude Code remote-control and session facts for daedalus";
      before = [ "podman-app-daedalus.service" ];
      wantedBy = [ "podman-app-daedalus.service" ];
      serviceConfig = {
        Type = "oneshot";
        ExecStart = "${claudeSnapshotScript}/bin/daedalus-claude-snapshot";
      };
    };

    # One minute, and it is the shortest timer daedalus runs for a reason: a
    # session list is the one thing here that is worth nothing when it is old.
    # Somebody opening this page has usually just started a session from a
    # phone and wants to see it, and a ten-minute snapshot would answer "no
    # sessions" to a question asked about one that is running.
    #
    # It costs a systemctl call, four bounded journal seeks and a handful of
    # /proc reads — cheaper than the env snapshot, which already runs at two.
    systemd.timers.daedalus-claude-snapshot = {
      wantedBy = [ "timers.target" ];
      timerConfig = {
        OnBootSec = "90s";
        OnUnitActiveSec = "1min";
      };
    };

    # Silent from the reader's side like every snapshot here, and with a twist
    # of its own: the page it feeds is about Remote Control, which is how the
    # operator would be TALKING to this box when it broke. A mail is the only
    # channel that does not depend on the thing it reports on.
    fleet.monitoredJobs.daedalus-claude-snapshot = { };

    # Ordered before the container like the other snapshots, so a fresh boot
    # has a repo.json before the first render of the settings page.
    systemd.services.daedalus-repo-snapshot = {
      description = "Publish the configuration and site repositories' state for daedalus";
      before = [ "podman-app-daedalus.service" ];
      wantedBy = [ "podman-app-daedalus.service" ];
      serviceConfig = {
        Type = "oneshot";
        ExecStart = "${repoSnapshotScript}/bin/daedalus-repo-snapshot";
      };
    };

    # Five minutes: the facts change when someone commits or an Apply lands,
    # and both are rare enough that a reading up to five minutes old is the
    # truth for every practical purpose. The apply agent's own status file is
    # what the page reads for "is an Apply running now".
    systemd.timers.daedalus-repo-snapshot = {
      wantedBy = [ "timers.target" ];
      timerConfig = {
        OnBootSec = "2min";
        OnUnitActiveSec = "5min";
      };
    };

    fleet.monitoredJobs.daedalus-repo-snapshot = { };

    # Keep the clones current. Two triggers on one unit:
    #
    #   - the 30-minute timer — the cadence for the off-box projects, whose
    #     pushes nothing on this box hears about;
    #   - the path unit below — the hosted apps' push channel. Their deploy
    #     units rewrite /var/lib/app-deploy/<name>.json exactly when a new
    #     image lands (modules/apps/assets/deploy.sh), which is minutes after
    #     the push that built it, so the workspace pulls right behind the code
    #     it is now running.
    #
    # Monotonic timer, deliberately off the hour (the myspeed rule); a sync is
    # a handful of `git fetch`es, so the cost is SSH round trips, not bandwidth.
    systemd.services.daedalus-workspace-sync = bridgeAgent // {
      description = "Fetch and fast-forward the project workspaces";
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];
      serviceConfig = {
        Type = "oneshot";
        ExecStart = "${mkWorkspaceSyncScript true}/bin/daedalus-workspace-sync";
        TimeoutStartSec = "15min";
      };
    };

    systemd.timers.daedalus-workspace-sync = {
      wantedBy = [ "timers.target" ];
      timerConfig = {
        OnBootSec = "6min";
        OnUnitActiveSec = "30min";
      };
    };

    systemd.paths.daedalus-workspace-sync = {
      description = "Sync the workspaces when an app deploy lands";
      wantedBy = [ "multi-user.target" ];
      # One entry per registry app, derived from the same apps.json the deploy
      # units are generated from — a path unit cannot glob, and a hand-kept
      # list would miss the next app.
      pathConfig.PathChanged = map (n: "/var/lib/app-deploy/${n}.json") (lib.attrNames registryApps);
    };

    # Silent from the reader's side like every snapshot: a stopped sync shows
    # yesterday's HEAD as though it were current, which reads as "no news from
    # this project" — the exact opposite of what happened.
    fleet.monitoredJobs.daedalus-workspace-sync = { };

    # Publish-only variant, ordered before the container for the same two
    # reasons as the system snapshot: the mount source must exist (rootless
    # podman cannot create a root-owned /run dir) and the page should have
    # facts on a cold boot. No network in it — a GitHub outage must never gate
    # the app's start (the image-freshness rule).
    systemd.services.daedalus-workspace-publish = {
      description = "Publish the project workspace facts for daedalus";
      before = [ "podman-app-daedalus.service" ];
      wantedBy = [ "podman-app-daedalus.service" ];
      serviceConfig = {
        Type = "oneshot";
        ExecStart = "${mkWorkspaceSyncScript false}/bin/daedalus-workspace-publish";
      };
    };

    # Refreshes /run/daedalus-export/applied.json (the read-only /export mount)
    # from the committed registry. Ordered before
    # the container so the file exists on a cold boot; re-runs on any rebuild
    # that changed apps.json, because its ExecStart embeds that file's store path.
    systemd.services.daedalus-registry-snapshot = {
      description = "Publish the committed app registry for daedalus to read";
      before = [ "podman-app-daedalus.service" ];
      wantedBy = [
        "podman-app-daedalus.service"
        "multi-user.target"
      ];
      after = [ "local-fs.target" ];
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        ExecStart = "${registrySnapshot}/bin/daedalus-registry-snapshot";
      };
    };

    # The export publisher must have populated /run/daedalus-export before the
    # container mounts it: rootless podman cannot create a root-owned /run dir,
    # and a bind mount of a missing source fails the whole container start.
    # (The publisher itself lives in platform/export.nix; only the ordering is
    # daedalus's concern.)
    systemd.services.daedalus-export-publish = {
      before = [ "podman-app-daedalus.service" ];
      wantedBy = [ "podman-app-daedalus.service" ];
    };
  };
}
