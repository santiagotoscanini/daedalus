# The builder — rootless BuildKit as its own user, the fenced client user that
# drives it, the scratch dataset they share, and the registry credential the
# box pushes with. The build AGENT (host/build.sh,
# daedalus-build.service) is ./build-agent.nix; everything it needs from here
# it reads as `config.fleet.builder.*`, declared at the bottom of this file
# (the railpack and mise fields are filled by ./railpack.nix).
#
# Gated like daedalus.nix's App half: nothing here exists until
# site/vault/github-app.sops is in the flake. The option values and the
# firewall cleanup are NOT gated — see those blocks for why.
#
# Two users, two jobs:
#   buildkit        runs the daemon. Owns a subuid/subgid range of its own
#                   (300000+65536, clear of the operator's 100000+65536), so a build
#                   step that escapes its sandbox lands as a uid that owns
#                   nothing of the operator's, holds no secret and reaches no LAN.
#   daedalus-build  runs everything that touches repo content on the host:
#                   clones, `railpack prepare`, the `buildctl` client. Holds the
#                   clone token, and the registry push credential only as the
#                   per-build copy host/build.sh makes for the one publishing
#                   buildctl call: `railpack prepare` runs repository mise code
#                   as this user, so the rendered original is root 0400. The
#                   daemon reads neither (credentials reach BuildKit over the
#                   session).
#
# buildkitd.service, and the three things that are not what they look like:
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
#     house-wide auth outage. The fence is the boundary: loopback DNS is open to
#     daedalus-build only, so that relay, made as buildkit, is refused.
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
# Storage: a dataset of its own (the host's `fleet.zfs.datasets`) at /var/lib/daedalus-builds,
# quota 150G, never snapshotted, `nofail`. The layout under it is created by
# daedalus-builds-layout.service, which carries RequiresMountsFor — NOT by
# systemd.tmpfiles: a nofail mount is not ordered before local-fs.target, so
# boot-time tmpfiles could create the dirs in the underlay a moment before the
# dataset mounts over them. `nofail` also makes a FAILED mount silent, which
# is what daedalus-builds-mounted.service (below, hourly, monitoredJobs) is
# for.
#
# BuildKit's GC is written as explicit gcpolicy blocks: a bare maxUsedSpace
# expands into the default four rules, one of them 512 MB / 48 h.
#
# The egress fence (firewall extraCommands): every packet sent by buildkit, by
# buildkit's subuid range (a step that got out into the host network
# namespace) or by daedalus-build passes one chain — pi-hole at <lanIp>:53 and
# traefik at <lanIp>:443 (Verdaccio, zot) are allowed; loopback, RFC 1918,
# CGNAT, link-local, multicast and the IPv6 local ranges are rejected; the
# internet returns to the normal path. Owner matching works for the daemon
# because slirp4netns is what opens the host sockets, as buildkit. One
# exception, for daedalus-build alone: 127.0.0.1:53, because railpack and
# buildctl are Go and their resolver asks /etc/resolv.conf's 127.0.0.1
# directly (glibc tools go through nscd) — a handful of lookups per build on
# the shared budget, never a build step's.
#
# The fence runs inside firewall-start, BEFORE the INPUT rules go in, under
# `bash -e`: one failing command there makes the reload fall back to
# firewall-stop, which leaves the host with no INPUT filtering at all. So the
# uids are pinned and matched as numbers (no name lookup at early boot), no
# fence command can abort the script (failures are logged to firewall.service's
# journal), and the OUTPUT jumps go in only once the chain is complete. The
# fence fails CLOSED at its consumers instead: buildkitd, and the build agent
# through `fleet.builder.fenceCheck`, refuse to start unless the jump for every
# fenced owner (both uids and the subuid range) is loaded in iptables and
# ip6tables.
#
# The registry credential is machine-generated state, not a sops secret:
# daedalus-build-registry-password.service writes a random password once to
# <machineState>/builder/registry-builder.env (fleet.machineState; the file root 0600
# via a temp file and a rename, its directory operator 0755). Every reader goes through `fleet.builder.registryPasswordRead`,
# which parses the file rather than sourcing it and refuses anything that is not
# root-owned 0600 with exactly 64 hex characters: an empty password in htpasswd
# would be an unauthenticated push to every app's :latest, live two minutes
# later. modules/registry renders it into zot's htpasswd as `builder` (read +
# create + update on every repository, never delete; left OUT of htpasswd when
# the reader refuses), and the render below writes the docker config.json
# (root 0400; host/build.sh copies it for the build user around the one
# publishing buildctl call only). Rotation:
#   rm <machineState>/builder/registry-builder.env
#   systemctl restart daedalus-build-registry-password.service
# Both renders are PartOf that unit and zot is PartOf its render, so the one
# restart regenerates the password, re-renders htpasswd and config.json and
# restarts zot — no false-success window. The unit is restartIfChanged = false:
# a rebuild that edits it must not bounce zot through that chain.
#
# Which rebuilds matter:
#   the toml / start script / limits  → buildkitd restarts (kills a running build)
#   the fence                         → firewall reload
#   ./railpack.nix                    → nothing restarts; the next build uses it

{
  config,
  lib,
  pkgs,
  nixpkgs-unstable,
  mkSecretRender,
  ...
}:

let
  cfg = config.fleet.builder;
  inherit (config.fleet) lanIp;

  # The same condition as daedalus-lib.nix's `haveGithubApp`, restated: the
  # App's credentials are in the flake.
  githubAppVault =
    if config.fleet.site.source == null then
      null
    else
      "${config.fleet.site.source}/vault/github-app.sops";
  haveGithubApp = githubAppVault != null && builtins.pathExists githubAppVault;

  # buildkit 0.32 from unstable: 25.11 ships 0.25, and `[frontend."gateway.v0"]
  # allowedRepositories` needs >= 0.26. legacyPackages rather than a second
  # `import` (claude-code needs one for allowUnfree; buildkit is Apache-2.0).
  inherit (nixpkgs-unstable.legacyPackages.${pkgs.stdenv.hostPlatform.system}) buildkit;

  runDir = "/run/buildkit";
  socketPath = "${runDir}/buildkitd.sock";
  secretsDir = "${config.fleet.machineState}/builder";

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

  fenceChain = "daedalus-build-egress";

  # Removes every trace of the fence, whatever the users are called now: jumps
  # are found by target in `-S` output (numeric uids), so a uid left behind by a
  # deleted user can never keep a stale match. Every command tolerates absence
  # — the firewall scripts run under `sh -e`, and a failure there stops the
  # whole firewall.
  fenceClear = ''
    for ipt in iptables ip6tables; do
      $ipt -w -S OUTPUT 2>/dev/null | while read -r rule; do
        case "$rule" in
          *" -j ${fenceChain}") $ipt -w -D OUTPUT ''${rule#-A OUTPUT } || true ;;
        esac
      done
      $ipt -w -F ${fenceChain} 2>/dev/null || true
      $ipt -w -X ${fenceChain} 2>/dev/null || true
    done
  '';

  # Pinned, so the fence matches numbers: a name lookup is one more thing that
  # can fail inside the firewall script at early boot. Free on this box and in
  # nixos/modules/misc/ids.nix (which ends at 327; dynamic system ids count
  # down from 999). Each group shares its user's number.
  buildkitUid = 350;
  buildUid = 351;
  # buildkit's subordinate ids: clear of the operator's 100000+65536.
  subIdStart = 300000;
  subIdCount = 65536;
  # Every owner the fence matches: the daemon, its subuid range (a step that
  # escaped into the host netns runs as one of those), the client.
  fenceOwners = "${toString buildkitUid} ${toString buildUid} ${toString subIdStart}-${
    toString (subIdStart + subIdCount - 1)
  }";
  iptablesBin = "${config.networking.firewall.package}/bin";

  # No command here may abort firewall-start (header): each runs through
  # `builder_fence`, which logs a failure and marks the chain incomplete. An
  # incomplete chain gets no OUTPUT jumps, so fenceCheck refuses to start the
  # daemon and the build agent.
  fenceSetup = ''
    # ── daedalus builder egress fence (stacks/daedalus/builder.nix) ──
    ${fenceClear}
    builder_fence_ok=1
    builder_fence() {
      "$@" || {
        builder_fence_ok=0
        echo "daedalus-build-egress: FAILED: $*" >&2
      }
    }
    builder_fence iptables -w -N ${fenceChain}
    for proto in udp tcp; do
      # Loopback DNS for daedalus-build ONLY: as buildkit it is slirp4netns
      # relaying a step's 10.0.2.3 query onto the shared budget (header).
      builder_fence iptables -w -A ${fenceChain} -m owner --uid-owner ${toString buildUid} \
        -d 127.0.0.1/32 -p "$proto" --dport 53 -j RETURN
      builder_fence iptables -w -A ${fenceChain} -d ${lanIp}/32 -p "$proto" --dport 53 -j RETURN
    done
    builder_fence iptables -w -A ${fenceChain} -d ${lanIp}/32 -p tcp --dport 443 -j RETURN
    for net in 0.0.0.0/8 127.0.0.0/8 10.0.0.0/8 100.64.0.0/10 169.254.0.0/16 \
               172.16.0.0/12 192.168.0.0/16 224.0.0.0/4 240.0.0.0/4; do
      builder_fence iptables -w -A ${fenceChain} -d "$net" -j REJECT
    done
    builder_fence iptables -w -A ${fenceChain} -j RETURN
    ${lib.optionalString config.networking.enableIPv6 ''
      builder_fence ip6tables -w -N ${fenceChain}
      for net in ::/128 ::1/128 fe80::/10 fc00::/7 ff00::/8; do
        builder_fence ip6tables -w -A ${fenceChain} -d "$net" -j REJECT
      done
      builder_fence ip6tables -w -A ${fenceChain} -j RETURN
    ''}
    if [ "$builder_fence_ok" = 1 ]; then
      for uid in ${fenceOwners}; do
        builder_fence iptables -w -A OUTPUT -m owner --uid-owner "$uid" -j ${fenceChain}
        ${lib.optionalString config.networking.enableIPv6 ''
          builder_fence ip6tables -w -A OUTPUT -m owner --uid-owner "$uid" -j ${fenceChain}
        ''}
      done
    else
      echo "daedalus-build-egress: chain incomplete, OUTPUT jumps withheld; buildkitd and daedalus-build will refuse to start" >&2
    fi
  '';

  # ExecStartPre (as root) of buildkitd, and of the build agent through
  # `fleet.builder.fenceCheck`: no fence, no start.
  fenceCheck = pkgs.writeShellScript "daedalus-build-fence-check" ''
    set -u
    missing=0
    for uid in ${fenceOwners}; do
      if ! ${iptablesBin}/iptables -w -C OUTPUT -m owner --uid-owner "$uid" -j ${fenceChain} 2>/dev/null; then
        echo "egress fence: no IPv4 OUTPUT jump for uid $uid" >&2
        missing=1
      fi
      ${lib.optionalString config.networking.enableIPv6 ''
        if ! ${iptablesBin}/ip6tables -w -C OUTPUT -m owner --uid-owner "$uid" -j ${fenceChain} 2>/dev/null; then
          echo "egress fence: no IPv6 OUTPUT jump for uid $uid" >&2
          missing=1
        fi
      ''}
    done
    if [ "$missing" = 1 ]; then
      echo "refusing to start without the daedalus builder egress fence; see journalctl -u firewall.service" >&2
      exit 1
    fi
  '';

  # The one way anything reads the builder password (header). Prints it on
  # stdout: capture it into a variable, never pass it as an argument.
  registryPasswordRead = pkgs.writeShellScript "daedalus-build-registry-password-read" ''
    set -eu
    f=${cfg.registryPasswordFile}
    if [ ! -f "$f" ] || [ -L "$f" ]; then
      echo "$f: missing" >&2
      exit 1
    fi
    meta=$(${pkgs.coreutils}/bin/stat -c '%u %a' "$f")
    if [ "$meta" != "0 600" ]; then
      echo "$f: expected uid 0 mode 600, found '$meta'; refusing it" >&2
      exit 1
    fi
    pw=$(${pkgs.gnused}/bin/sed -n 's/^REGISTRY_BUILDER_PASSWORD=//p' "$f")
    case "$pw" in
      *[!0-9a-f]*)
        echo "$f: malformed password; delete the file and restart ${passwordUnit}" >&2
        exit 1
        ;;
    esac
    if [ "''${#pw}" -ne 64 ]; then
      echo "$f: password is ''${#pw} characters, not 64; delete the file and restart ${passwordUnit}" >&2
      exit 1
    fi
    printf '%s' "$pw"
  '';

  passwordUnit = "daedalus-build-registry-password.service";
in
{
  options.fleet.builder =
    let
      ro =
        type: description:
        lib.mkOption {
          inherit type description;
          readOnly = true;
        };
      inherit (lib) types;
    in
    {
      # A default, unlike the rest (and so not readOnly — a default counts as
      # a definition there): modules/registry reads this to decide whether the
      # builder gets an htpasswd user, and must get "no" rather than an eval
      # error when the control plane is switched off.
      enable = lib.mkOption {
        type = types.bool;
        default = false;
        description = "Whether the builder exists (the GitHub App's vault file is in the flake, and the control plane is on).";
      };
      socket = ro types.str "buildctl --addr for the daemon; group daedalus-build, 0660.";
      buildkitPackage = ro types.package "The buildkit the daemon runs; use its buildctl.";
      railpack = ro types.package "The pinned railpack CLI (./railpack.nix).";
      railpackFrontend = ro types.str "The gateway frontend ref matching `railpack`, tag and digest.";
      miseBinary = ro types.path "The pinned mise railpack runs on the host (./railpack.nix). Bind it read-only at `misePath`.";
      misePath = ro types.str "Where railpack's ensureInstalled looks for mise; a file there means no download.";
      dockerConfigDir = ro types.str "DOCKER_CONFIG for buildctl: config.json with the registry push credential.";
      root = ro types.str "The scratch dataset's mount point.";
      workDir = ro types.str "Per-build work dirs (daedalus-build 0700).";
      miseCacheDir = ro types.str "Railpack's mise caches, one `<app>/` each (root 0700; build.sh mounts one at /tmp/railpack).";
      logDir = ro types.str "Build logs, on the root filesystem (root 0755).";
      user = ro types.str "The unprivileged client user (also its group).";
      registryHost = ro types.str "The registry the builder pushes to.";
      # Not readOnly: a host CONTRIBUTES it from the stack that publishes the
      # mirror, inside that stack's own switch.
      npmMirrorHost = lib.mkOption {
        type = types.nullOr types.str;
        default = null;
        example = "npm.example.org";
        description = ''
          Hostname of an npm registry mirror THIS box publishes (through the
          reverse proxy, on the LAN address): a build installs through
          `https://<host>/` and pins the name to the LAN address inside
          BuildKit, where the box's own resolver is not reachable. Null: builds
          install straight from registry.npmjs.org.
        '';
      };
      registryUser = ro types.str "zot htpasswd user for pushes.";
      registryPasswordFile = ro types.str "Machine-generated dotenv carrying REGISTRY_BUILDER_PASSWORD (root 0600).";
      registryPasswordRead = ro types.path "Script printing the builder password; refuses a missing, foreign-owned, non-0600, empty or short file. Capture into a variable, never argv.";
      fenceCheck = ro types.path "Fails unless the egress fence's OUTPUT jumps for both builder uids and buildkit's subuid range are loaded. Run it as root (`+`) in ExecStartPre of every unit that runs as, or drives, the builder users.";
    };

  config = lib.mkIf config.fleet.modules.daedalus.enable (
    lib.mkMerge [
      # ── Always: the contract values, and the fence cleanup ─────────────────
      {
        fleet.builder = {
          enable = haveGithubApp;
          socket = "unix://${socketPath}";
          buildkitPackage = buildkit;
          dockerConfigDir = "/run/daedalus-build";
          root = "/var/lib/daedalus-builds";
          workDir = "${cfg.root}/work";
          miseCacheDir = "${cfg.root}/railpack-mise";
          logDir = "/var/log/daedalus-builds";
          user = "daedalus-build";
          registryHost = config.fleet.webApps.registry.hostname;
          registryUser = "builder";
          registryPasswordFile = "${secretsDir}/registry-builder.env";
          inherit registryPasswordRead fenceCheck;
        };

        # Ungated on purpose: if the App's vault file ever leaves the flake, the
        # reload that follows must still tear the fence down, or its numeric-uid
        # jumps would outlive the users and match whoever gets those uids next.
        networking.firewall.extraStopCommands = fenceClear;
      }

      (lib.mkIf haveGithubApp {
        users.groups.buildkit.gid = buildkitUid;
        users.users.buildkit = {
          uid = buildkitUid;
          isSystemUser = true;
          group = "buildkit";
          description = "Rootless BuildKit daemon (stacks/daedalus/builder.nix)";
          subUidRanges = [
            {
              startUid = subIdStart;
              count = subIdCount;
            }
          ];
          subGidRanges = [
            {
              startGid = subIdStart;
              count = subIdCount;
            }
          ];
        };

        users.groups.${cfg.user}.gid = buildUid;
        users.users.${cfg.user} = {
          uid = buildUid;
          isSystemUser = true;
          group = cfg.user;
          description = "daedalus build client (clones, railpack prepare, buildctl)";
          # Created by daedalus-builds-layout, after the dataset mounts.
          home = "${cfg.root}/home";
          createHome = false;
        };

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

        # On the root filesystem, so the log dir (and app-daedalus's read-only mount of
        # it) never depends on the dataset.
        systemd.tmpfiles.settings."10-daedalus-builds-logs".${cfg.logDir}.d = {
          mode = "0755";
          user = "root";
          group = "root";
        };

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
              # Fail closed: no egress fence, no daemon (header).
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

        networking.firewall.extraCommands = fenceSetup;

        # ── Registry push credential ───────────────────────────────────────
        # It lived under stacks/daedalus/secrets in the checkout until it moved
        # (platform/machine-state.nix). The generator requires the migration: run
        # first, it would mint a password zot's htpasswd has never seen.
        fleet.machineStateLegacy.builder = "${config.fleet.config.repo}/stacks/daedalus/secrets";
        fleet.machineStateReaders = [ "daedalus-build-registry-password.service" ];

        systemd.services.daedalus-build-registry-password = {
          description = "Generate the zot `builder` push password on first boot";
          wantedBy = [ "multi-user.target" ];
          before = [
            "registry-config-render.service"
            "daedalus-build-dockerconfig.service"
          ];
          after = [ "local-fs.target" ];
          path = [
            pkgs.openssl
            pkgs.coreutils
          ];
          # Both renders and (through its render) zot are PartOf this unit: a
          # rebuild that edits it must not restart that chain.
          restartIfChanged = false;
          # A refused file fails the same way on every retry: three tries, then
          # failed and mailed (monitoredJobs below), not a silent 5 s loop.
          unitConfig = {
            StartLimitIntervalSec = 600;
            StartLimitBurst = 3;
          };
          serviceConfig = {
            Type = "oneshot";
            RemainAfterExit = true;
            Restart = "on-failure";
            RestartSec = "5s";
          };
          script = ''
            set -eu
            umask 077
            f=${cfg.registryPasswordFile}
            # The stacks' convention for secrets/ (operator 0755, as stacks/app-db);
            # only the file itself is restricted.
            [ -d ${secretsDir} ] || install -d -m 0755 -o ${config.fleet.operator.user} -g ${config.fleet.operator.group} ${secretsDir}
            if [ -e "$f" ] || [ -L "$f" ]; then
              # Present: it must still pass the reader, or nothing may use it.
              ${registryPasswordRead} >/dev/null
              exit 0
            fi
            pw=$(openssl rand -hex 32)
            case "$pw" in
              *[!0-9a-f]*)
                echo "openssl rand returned a malformed password" >&2
                exit 1
                ;;
            esac
            if [ "''${#pw}" -ne 64 ]; then
              echo "openssl rand returned ''${#pw} characters, not 64" >&2
              exit 1
            fi
            tmp=$(mktemp ${secretsDir}/.registry-builder.env.XXXXXX)
            trap 'rm -f "$tmp"' EXIT
            printf 'REGISTRY_BUILDER_PASSWORD=%s\n' "$pw" > "$tmp"
            chown root:root "$tmp"
            chmod 0600 "$tmp"
            mv -f "$tmp" "$f"
            trap - EXIT
            # The file as written is exactly what every reader will accept.
            ${registryPasswordRead} >/dev/null
          '';
        };

        # The docker config the publishing buildctl call reads. Root-only — dir
        # 0700, file 0400 — because `railpack prepare` runs repository-controlled
        # mise code as daedalus-build, which must never be able to read the push
        # credential in place: host/build.sh copies it into a per-build dir for
        # the one buildctl call that pushes and deletes it right after.
        # mkSecretRender makes the dir operator 0755; prep takes it back to root
        # 0700 before the file is written.
        systemd.services.daedalus-build-dockerconfig = lib.mkMerge [
          (mkSecretRender {
            description = "Render the builder's registry credential as a docker config.json";
            gates = [ "daedalus-build.service" ];
            after = [ passwordUnit ];
            wants = [ passwordUnit ];
            dir = cfg.dockerConfigDir;
            file = "${cfg.dockerConfigDir}/config.json";
            owner = "root";
            group = "root";
            prep = ''
              chown root:root ${cfg.dockerConfigDir}
              chmod 0700 ${cfg.dockerConfigDir}
              # Aborts the render on a missing, foreign-owned, empty or short
              # password (header): a failed unit, never a config with no secret.
              REGISTRY_BUILDER_PASSWORD=$(${registryPasswordRead})
              AUTH=$(printf '%s:%s' ${cfg.registryUser} "$REGISTRY_BUILDER_PASSWORD" | base64 -w0)
            '';
            content = ''{"auths":{"${cfg.registryHost}":{"auth":"$AUTH"}}}'';
          })
          {
            # Rendered at boot, not only when a build first starts.
            wantedBy = [ "multi-user.target" ];
            partOf = [ passwordUnit ];
            # mkSecretRender retries every 5 s; a refused password never heals by
            # retrying, so cap it and let the failure mail.
            unitConfig = {
              StartLimitIntervalSec = 600;
              StartLimitBurst = 3;
            };
          }
        ];

        # Without these, a bad password is a render retrying out of sight: every
        # build then fails at publishing, far from the cause.
        fleet.monitoredJobs.daedalus-build-registry-password = { };
        fleet.monitoredJobs.daedalus-build-dockerconfig = { };
      })
    ]
  );
}
