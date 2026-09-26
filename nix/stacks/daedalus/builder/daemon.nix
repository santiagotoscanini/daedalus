# builder/daemon — buildkitd: the rootless BuildKit daemon every build runs
# in. Its config file, the three scripts around its start, and the unit. A
# plain function imported by ../builder.nix; never a module.
#
# The three things that are not what they look like:
#   - Rootless means rootlesskit: a user + mount + network namespace
#     (slirp4netns, host loopback unreachable) with /etc copied up. Steps run
#     in the daemon's cgroup (rootless strips per-step cgroups), so the unit's
#     MemoryMax/CPUQuota/TasksMax ARE the build's limits and `systemctl restart
#     buildkitd` kills every step. None of NoNewPrivileges, PrivateUsers,
#     RestrictNamespaces or RestrictSUIDSGID: each one breaks rootlesskit (it
#     needs the setuid newuidmap in /run/wrappers). Add other hardening one
#     directive at a time, with a real build after each.
#   - /etc/resolv.conf inside the namespace is a bind mount of rootlesskit's
#     generated file (nameserver 10.0.2.3), so start.sh OVERWRITES it in place
#     with pi-hole's LAN address — an `rm` fails "Device or resource busy"
#     (measured). Steps get the same nameserver from `[dns]`, and their queries
#     leave slirp4netns for <lanIp>:53, pi-hole's budget for <lanIp>. That is
#     a default, not a boundary: a step can still ask slirp4netns' built-in
#     forwarder at 10.0.2.3, which relays to the HOST resolver, 127.0.0.1:53 —
#     the one budget every container shares, and exhausting it is the
#     house-wide auth outage. The fence is the boundary (./fence.nix): loopback
#     DNS is open to daedalus-build only, so that relay, made as buildkit, is
#     refused.
#   - slirp4netns runs sandboxed and seccomp-filtered (rootlesskit's `auto`:
#     on whenever the binary supports it, which 1.3.3 does) — it is the process
#     that parses every packet a build step sends.
#   - The socket's group. buildkitd supports `[grpc] uid/gid`, but it chowns
#     from INSIDE the user namespace, where the host's daedalus-build gid is not
#     mapped: the chown would fail and the daemon exit. buildkitd also runs
#     under umask 0, so the socket is created 0777 and chmod'ed 0660 by its
#     listener an instant later, owned buildkit:buildkit — its mode is not the
#     boundary. /run/buildkit is: root sets it group daedalus-build, 0750,
#     before the daemon starts, so no other user can reach the socket at all.
#     ExecStartPost (as root, `+`) waits until the daemon answers `buildctl
#     debug workers`, then gives the socket group daedalus-build with
#     `chgrp -h`, which never follows a link buildkit could plant at that name.
#     "Active" on this unit means "answering, with the right group" — the
#     build agent's `requires=` can trust it.
#
# BuildKit's GC is written as explicit gcpolicy blocks: a bare maxUsedSpace
# expands into the default four rules, one of them 512 MB / 48 h.
#
# A change to the toml, the start script or the limits restarts buildkitd,
# which kills a running build.
{
  config,
  lib,
  pkgs,
  buildkit,
  fenceCheck,
}:

rec {
  cfg = config.fleet.builder;
  inherit (config.fleet) lanIp;

  runDir = "/run/buildkit";
  socketPath = "${runDir}/buildkitd.sock";

  # Key names checked against buildkit 0.32.2's docs/buildkitd.toml.md and
  # cmd/buildkitd/config/config.go. The decoder IGNORES unknown keys, so a typo
  # here is silent: re-check the struct tags when editing.
  buildkitdToml = (pkgs.formats.toml { }).generate "buildkitd.toml" {
    root = "${cfg.root}/buildkit";
    grpc.address = [ cfg.socket ];
    worker.oci = {
      enabled = true;
      # Always under rootlesskit. buildkitd defaults to rootless inside a user
      # namespace anyway; stated so the file says what it runs.
      rootless = true;
      # Measured: `auto` picked overlayfs on this kernel + ZFS 2.3.7. Pinned so
      # a regression lands as an error, not as `native` quietly filling the
      # quota with full copies.
      snapshotter = "overlayfs";
      max-parallelism = 4;
      gc = true;
      # Read only by the default policy set, which the explicit blocks below
      # replace; kept so the worker's advertised caps match them.
      reservedSpace = "10GB";
      maxUsedSpace = "120GB";
      minFreeSpace = "15GB";
      # BuildKit's default four rules, with this dataset's numbers.
      gcpolicy = [
        # The cheapest to reproduce (build contexts, cache mounts, git
        # checkouts): unused for a week, or past 25 GB.
        {
          filters = [
            "type==source.local"
            "type==exec.cachemount"
            "type==source.git.checkout"
          ];
          keepDuration = "168h";
          maxUsedSpace = "25GB";
        }
        # Anything unused for 60 days.
        {
          keepDuration = "1440h";
          reservedSpace = "10GB";
          maxUsedSpace = "120GB";
          minFreeSpace = "15GB";
        }
        # Unshared cache under the cap.
        {
          reservedSpace = "10GB";
          maxUsedSpace = "120GB";
          minFreeSpace = "15GB";
        }
        # Then everything, internal records included.
        {
          all = true;
          reservedSpace = "10GB";
          maxUsedSpace = "120GB";
          minFreeSpace = "15GB";
        }
      ];
    };
    worker.containerd.enabled = false;
    dns.nameservers = [ lanIp ];
    # A repo's `# syntax=` line cannot pull an arbitrary frontend: only these
    # two repositories (compared without tag) may be gateway sources.
    frontend."gateway.v0".allowedRepositories = [
      "ghcr.io/railwayapp/railpack-frontend"
      "docker.io/docker/dockerfile"
    ];
    history = {
      maxAge = 604800; # 7 days, in seconds
      maxEntries = 100;
    };
  };

  # Runs inside rootlesskit's namespaces as the mapped root.
  #
  # Not `exec`: buildkitd exits 1 even on one clean SIGTERM (its cancel reason
  # comes back as an error), so every stop and every rebuild restart failed the
  # unit and mailed. The script forwards the stop and turns exactly that case —
  # a stop it was asked for, answered with 1 — into 0. A crash still exits
  # non-zero (restart + mail); SuccessExitStatus=1 would have hidden those.
  startScript = pkgs.writeShellScript "buildkitd-start" ''
    set -u
    # In place: /etc/resolv.conf is a bind mount here, `rm` is EBUSY (spike B1).
    printf 'nameserver %s\n' ${lib.escapeShellArg lanIp} > /etc/resolv.conf || exit 1
    ${buildkit}/bin/buildkitd --config ${buildkitdToml} &
    pid=$!
    stopping=0
    trap 'stopping=1; kill -TERM "$pid" 2>/dev/null' TERM INT
    # `wait` returns early when the trap fires; wait again until it is gone.
    while :; do
      wait "$pid"
      rc=$?
      kill -0 "$pid" 2>/dev/null || break
    done
    if [ "$stopping" = 1 ] && [ "$rc" = 1 ]; then
      exit 0
    fi
    exit "$rc"
  '';

  # ExecStartPre, as root. RuntimeDirectory is buildkit:buildkit; the client
  # needs to traverse it, and rootlesskit's state dir (its API socket, the
  # child pid) must stay the daemon's alone — pre-created 0700, which
  # rootlesskit's MkdirAll keeps.
  prepScript = pkgs.writeShellScript "buildkitd-prep" ''
    set -eu
    ${pkgs.coreutils}/bin/chgrp ${cfg.user} ${runDir}
    ${pkgs.coreutils}/bin/chmod 0750 ${runDir}
    ${pkgs.coreutils}/bin/install -d -m 0700 -o buildkit -g buildkit ${runDir}/rk
  '';

  # How long ExecStartPost waits for the daemon to answer. TimeoutStartSec is
  # derived from it (+10 s for ExecStartPre and the last probe), so the message
  # below names the real bound and prints before systemd kills the start.
  readySeconds = 80;

  # ExecStartPost, as root: readiness, then the socket's group (header).
  readyScript = pkgs.writeShellScript "buildkitd-ready" ''
    set -u
    # $SECONDS: a deadline, not an iteration count — a probe that hangs for its
    # full 5 s timeout must not stretch the wait past the unit's bound.
    while [ "$SECONDS" -lt ${toString readySeconds} ]; do
      if ${pkgs.coreutils}/bin/timeout 5 ${buildkit}/bin/buildctl --addr ${cfg.socket} \
          debug workers >/dev/null 2>&1; then
        # -h: a link planted at the socket's name gets its own group changed,
        # never its target's. No chmod: the listener already set 0660, and
        # chmod has no form that refuses to follow a link.
        if [ -S ${socketPath} ] && [ ! -L ${socketPath} ]; then
          ${pkgs.coreutils}/bin/chgrp -h ${cfg.user} ${socketPath}
          # The prep step's group on ${runDir} does not survive the start:
          # observed buildkit:buildkit 0750 once the daemon is up, so the
          # client could not traverse to the socket. Re-apply it here, after
          # the daemon has made its directory. /run/buildkit itself is a real
          # directory systemd created under root-owned /run — no link to follow.
          ${pkgs.coreutils}/bin/chgrp -h ${cfg.user} ${runDir}
          ${pkgs.coreutils}/bin/chmod 0750 ${runDir}
          exit 0
        fi
        echo "${socketPath} answered but is not a plain socket; refusing it" >&2
        exit 1
      fi
      ${pkgs.coreutils}/bin/sleep 0.5
    done
    echo "buildkitd did not answer on ${socketPath} within ${toString readySeconds} s" >&2
    exit 1
  '';

  # What ../builder.nix merges into the system, while the builder exists.
  settings = {
    systemd.services.buildkitd = {
      description = "Rootless BuildKit daemon for daedalus builds";
      wantedBy = [ "multi-user.target" ];
      after = [
        "network-online.target"
        "firewall.service"
        "daedalus-builds-layout.service"
      ];
      wants = [ "network-online.target" ];
      requires = [ "daedalus-builds-layout.service" ];
      # /run/wrappers first: rootlesskit must find the setuid newuidmap.
      path = [
        "/run/wrappers"
        pkgs.rootlesskit
        pkgs.slirp4netns
        pkgs.runc
        # rootlesskit sets up slirp4netns's tap with `nsenter … ip tuntap`:
        # both must be on PATH (a login shell's PATH hides the omission).
        pkgs.util-linux
        pkgs.iproute2
        buildkit
      ];
      environment.XDG_RUNTIME_DIR = runDir;
      unitConfig = {
        RequiresMountsFor = [ cfg.root ];
        # Three failed starts in ten minutes and it stays failed: one mail,
        # not one every RestartSec for as long as it crash-loops.
        StartLimitIntervalSec = 600;
        StartLimitBurst = 3;
      };
      serviceConfig = {
        User = "buildkit";
        Group = "buildkit";
        RuntimeDirectory = "buildkit";
        RuntimeDirectoryMode = "0750";
        ExecStartPre = [
          # Fail closed: no egress fence, no daemon (./fence.nix).
          "+${fenceCheck}"
          "+${prepScript}"
        ];
        ExecStart = lib.concatStringsSep " " [
          "${pkgs.rootlesskit}/bin/rootlesskit"
          "--net=slirp4netns"
          "--copy-up=/etc"
          "--disable-host-loopback"
          # slirp4netns in its own mount namespace + a seccomp filter (header).
          "--slirp4netns-sandbox=auto"
          "--slirp4netns-seccomp=auto"
          "--state-dir=${runDir}/rk"
          "${startScript}"
        ];
        ExecStartPost = "+${readyScript}";
        # The readiness deadline + 10 s (see readySeconds).
        TimeoutStartSec = "${toString (readySeconds + 10)}s";

        # The build's limits: every step runs in this cgroup.
        MemoryMax = "20G";
        MemoryHigh = "18G";
        MemorySwapMax = "0";
        CPUQuota = "800%";
        TasksMax = 8192;
        IOWeight = 50;
        # A step's OOM kill fails that build, not the daemon.
        OOMPolicy = "continue";

        Restart = "on-failure";
        RestartSec = "10s";
        # Stop signals the main process only: both rootlesskit layers forward
        # SIGTERM, so the default control-group kill delivered it three
        # times ("got 3 SIGTERM/SIGINTs, forcibly terminating"). With one
        # delivery, startScript turns the requested stop into exit 0 (a stop
        # drill). Anything left afterwards (build steps, slirp4netns) still
        # gets the cgroup-wide SIGKILL.
        KillMode = "mixed";
      };
    };

    # A dead daemon is "builder unavailable" on every push until someone looks.
    fleet.monitoredJobs.buildkitd = { };
  };
}
