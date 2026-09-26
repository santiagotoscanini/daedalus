# daedalus-build — the host side of daedalus's `build` bridge verb: turn a
# `build-request.json` the engine drops into the apply dir into an image in
# the box's registry, then start the app's deploy.
#
# ── the units ─────────────────────────────────────────────────────────────
#
#   daedalus-build.path       watches build-request.json, starts:
#   daedalus-build.service    one build, three scripts in order —
#     ExecStartPre   host/build-fence-gate.sh  no egress fence, no build
#     ExecStart      host/build.sh             token, clone, railpack prepare,
#                                              checks, build + push, deploy
#     ExecStopPost   host/build-reaper.sh      a run that died unannounced
#                                              reads `failed: interrupted`
#   daedalus-build-cancel.{path,service}   build-cancel-request.json →
#                                          host/build-cancel.sh
#   daedalus-build-gc.{timer,service}      nightly sweep → host/build-gc.sh
#
# ── how each script is made ───────────────────────────────────────────────
#
# A writeShellApplication whose text is, in order: the variables nix hands it
# (`NAME='value'` lines, fixed when the system is built), the shared helpers
# (host/lib.sh — the bridge's rules for touching files the container can
# write; host/github-lib.sh for the build itself), then the script under
# host/. So a change to apps.json or to a builder path is a new script, never
# a run-time lookup. host/build.sh opens with the trust model.
#
# Gated like the builder itself (`fleet.builder.enable`: the GitHub App's
# vault file is in the flake). Nothing here exists before the App does. The
# daemon, the build user, the scratch dataset and the egress fence are
# ./builder.nix; the Railpack and mise pins are ./railpack.nix.
#
# What it reads from elsewhere, and why each is a derivation rather than a copy:
#   BUILDABLE, DEPLOYABLE  daedalus-lib.nix's `buildableApps` / `deployableApps`,
#               from the committed site/apps.json — the same lists the deploy
#               trigger gets, because a name in them becomes part of a unit
#               root starts.
#   OWNER_ID    fleet.github.expectedOwnerId — the box's constant, never
#               site.json's copy (platform/site.nix asserts they agree).
#   OWNER, CLIENT_ID  site.json's github.app, as the token minter reads them.
#   fenceCheck, miseBinary/misePath — builder.nix's, never restated.
#
# Known residuals, accepted:
#   - Sandbox escape. A build step that escapes BuildKit's sandbox lands as
#     `buildkit`: its own subuids, no socket, no secrets, fenced (builder.nix).
#   - ONBUILD cache mounts. build.sh refuses a repo Dockerfile whose cache
#     mounts are not `<app>-` namespaced, but an `ONBUILD RUN
#     --mount=type=cache,id=<otherapp>-…` inherited from a hostile FROM base
#     image is invisible to that scan, and BuildKit has no daemon-side switch
#     that refuses cache mounts or ONBUILD triggers. The cheapest real fix,
#     not built: resolve each FROM with `skopeo inspect --config` and refuse a
#     base whose config carries OnBuild triggers. Railpack builds are immune
#     (LLB never runs ONBUILD), and every app is on Railpack now — no repo in
#     the fleet still carries a Dockerfile — so this residual is dormant
#     rather than fixed: the strategy is still supported, and the first repo
#     to bring a Dockerfile back brings it with them.
#   - The mise cache outlives a build and is the build user's to write, so
#     code a repo's mise config runs during `railpack prepare` can
#     leave files that a later prepare runs. Each app has its own cache
#     (build.sh mounts `miseCacheDir/<app>` at /tmp/railpack for that app's
#     prepare alone, under a root-only parent), so this no longer crosses
#     apps; within one app a commit can still leave files for that app's next
#     prepare — same repository, same trust.

{
  config,
  lib,
  pkgs,
  ...
}:

let
  inherit (config.fleet) builder;
  inherit (import ./daedalus-lib.nix { inherit config lib pkgs; })
    applyDir
    buildableApps
    deployableApps
    ;
  esc = lib.escapeShellArg;

  # ── values the scripts are handed ─────────────────────────────────────────

  appField = f: if config.fleet.github.app == null then "" else toString config.fleet.github.app.${f};

  buildGroup = config.users.users.${builder.user}.group;

  # The Dockerfile checks target's base image. Pinned by the multi-arch index
  # digest, resolved 2026-09-12 with `skopeo inspect --raw
  # docker://docker.io/library/node:24-slim | sha256sum`. Bump by hand, with a
  # candidate build of a Dockerfile-strategy app before any live one.
  nodeImage = "docker.io/library/node:24-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553";

  # The PATH of every process build.sh runs as the build user: its environment
  # is rebuilt from nothing, so this is all it gets.
  buildPath = lib.makeBinPath [
    pkgs.git
    pkgs.coreutils
    pkgs.findutils
    pkgs.bash
    pkgs.gnutar
    pkgs.gzip
    pkgs.xz
    builder.railpack
    builder.buildkitPackage
  ];

  # Who host/lib.sh reads requests and publishes status as: the operator, so
  # root never touches a file in the container-writable apply dir by name.
  operatorVars = ''
    OPERATOR_USER=${esc config.fleet.operator.user}
    OPERATOR_GROUP=${esc config.fleet.operator.group}
    SETPRIV=${pkgs.util-linux}/bin/setpriv
  '';

  # ── the scripts ───────────────────────────────────────────────────────────

  # daedalus-build's ExecStart. Its variables, by what they are for:
  #   the bridge        APPLY_DIR — where the request and the status live
  #   allowlists        BUILDABLE — apps this may build at all
  #                     DEPLOYABLE — apps whose deploy it starts once pushed
  #   the GitHub App    OWNER, CLIENT_ID, OWNER_ID (the trusted constant),
  #                     PEM — the App's private key, which never leaves the host
  #   where images go   REGISTRY — the box's zot
  #                     NPM_MIRROR_HOST + LAN_IP — installs go through the
  #                     mirror, its name pinned to the LAN address in BuildKit
  #   BuildKit          BUILDKIT_ADDR — the rootless daemon's socket
  #                     RAILPACK_FRONTEND — the gateway image that turns a
  #                     Railpack plan into build steps
  #                     DOCKER_CONFIG_DIR — the push credential, copied in for
  #                     the one publishing call
  #   scratch           BUILD_ROOT, WORK_ROOT (one dir per build), LOG_DIR
  #   Railpack's mise   MISE_CACHE_DIR (one cache per app), MISE_MOUNT and
  #                     MISE_PATH (where railpack looks), MISE_BINARY (the pin)
  #   the build user    BUILD_USER, BUILD_GROUP, BUILD_PATH (its whole PATH)
  #   Dockerfile route  NODE_IMAGE, CHECKS_DOCKERFILE — unused while every app
  #                     builds with Railpack
  #   the fence         FENCE_CHECK — re-run per build
  #   the operator      OPERATOR_USER, OPERATOR_GROUP, SETPRIV (operatorVars)
  buildScript = pkgs.writeShellApplication {
    name = "daedalus-build";
    # SC2016 is "expressions don't expand in single quotes" — exactly what
    # every jq program here relies on ($state, $tip … are jq's own variables).
    excludeShellChecks = [ "SC2016" ];
    runtimeInputs = [
      pkgs.jq
      pkgs.curl
      pkgs.openssl # github-lib gh_jwt
      pkgs.coreutils
      pkgs.findutils
      pkgs.gnused
      pkgs.gnugrep
      pkgs.gawk # the redact filter needs gensub + IGNORECASE
      pkgs.util-linux # setpriv, flock
      pkgs.systemd # systemctl, journalctl
    ];
    text = ''
      APPLY_DIR=${esc applyDir}
      BUILDABLE=${esc (lib.concatStringsSep " " buildableApps)}
      DEPLOYABLE=${esc (lib.concatStringsSep " " deployableApps)}
      OWNER=${esc (appField "owner")}
      OWNER_ID=${esc (toString config.fleet.github.expectedOwnerId)}
      CLIENT_ID=${esc (appField "clientId")}
      PEM=${esc config.sops.secrets."github-app-pem".path}
      REGISTRY=${esc builder.registryHost}
      NPM_MIRROR_HOST=${esc (toString builder.npmMirrorHost)}
      LAN_IP=${esc config.fleet.lanIp}
      NODE_IMAGE=${esc nodeImage}
      BUILDKIT_ADDR=${esc builder.socket}
      RAILPACK_FRONTEND=${esc builder.railpackFrontend}
      DOCKER_CONFIG_DIR=${esc builder.dockerConfigDir}
      BUILD_ROOT=${esc builder.root}
      WORK_ROOT=${esc builder.workDir}
      MISE_CACHE_DIR=${esc builder.miseCacheDir}
      MISE_MOUNT=${esc (dirOf (dirOf builder.misePath))}
      MISE_PATH=${esc builder.misePath}
      MISE_BINARY=${esc "${builder.miseBinary}"}
      LOG_DIR=${esc builder.logDir}
      BUILD_USER=${esc builder.user}
      BUILD_GROUP=${esc buildGroup}
      BUILD_PATH=${esc buildPath}
      CHECKS_DOCKERFILE=${./build/Dockerfile.checks}
      FENCE_CHECK=${esc "${builder.fenceCheck}"}
      ${operatorVars}
      ${builtins.readFile ./host/lib.sh}
      ${builtins.readFile ./host/github-lib.sh}
      ${builtins.readFile ./host/build.sh}
    '';
  };

  # daedalus-build's ExecStartPre: the fence check, with an answer for the
  # pending request when it fails — a bare failed check would read as
  # "interrupted" on the build page.
  fenceGate = pkgs.writeShellApplication {
    name = "daedalus-build-fence-gate";
    runtimeInputs = [
      pkgs.jq
      pkgs.coreutils
      pkgs.util-linux # setpriv, for lib.sh's operator-side reads and publish
    ];
    text = ''
      APPLY_DIR=${esc applyDir}
      FENCE_CHECK=${esc "${builder.fenceCheck}"}
      ${operatorVars}
      ${builtins.readFile ./host/lib.sh}
      ${builtins.readFile ./host/build-fence-gate.sh}
    '';
  };

  # daedalus-build's ExecStopPost: marks a run that died without publishing
  # its own end, and drops its work dir.
  buildReaper = pkgs.writeShellApplication {
    name = "daedalus-build-reaper";
    runtimeInputs = [
      pkgs.jq
      pkgs.coreutils
    ];
    text = ''
      STATUS=${esc "${applyDir}/build-status.json"}
      LOG_DIR=${esc builder.logDir}
      WORK_ROOT=${esc builder.workDir}
      BUILD_USER=${esc builder.user}
      BUILD_GROUP=${esc buildGroup}
      ${operatorVars}
      ${builtins.readFile ./host/lib.sh}
      ${builtins.readFile ./host/build-reaper.sh}
    '';
  };

  # daedalus-build-cancel's ExecStart: stops the build in flight, and only
  # the one the request names.
  cancelScript = pkgs.writeShellApplication {
    name = "daedalus-build-cancel";
    runtimeInputs = [
      pkgs.jq
      pkgs.coreutils
      pkgs.util-linux # setpriv, for lib.sh's operator-side reads
      config.systemd.package # systemctl
    ];
    text = ''
      REQ=${esc "${applyDir}/build-cancel-request.json"}
      STATUS=${esc "${applyDir}/build-status.json"}
      ${operatorVars}
      ${builtins.readFile ./host/lib.sh}
      ${builtins.readFile ./host/build-cancel.sh}
    '';
  };

  # daedalus-build-gc's ExecStart: old work dirs, old logs, unused cache.
  gcScript = pkgs.writeShellApplication {
    name = "daedalus-build-gc";
    runtimeInputs = [
      pkgs.coreutils
      pkgs.findutils
      pkgs.util-linux # setpriv, flock
    ];
    text = ''
      WORK_ROOT=${esc builder.workDir}
      LOG_DIR=${esc builder.logDir}
      BUILDKIT_ADDR=${esc builder.socket}
      BUILD_USER=${esc builder.user}
      BUILD_GROUP=${esc buildGroup}
      BUILD_PATH=${esc buildPath}
      SETPRIV=${pkgs.util-linux}/bin/setpriv
      ENV_BIN=${pkgs.coreutils}/bin/env

      ${builtins.readFile ./host/build-gc.sh}
    '';
  };
in

{
  config = lib.mkIf (config.fleet.modules.daedalus.enable && builder.enable) {

    # ── the build ─────────────────────────────────────────────────────────

    systemd.paths.daedalus-build = {
      description = "Watch for a daedalus build request";
      wantedBy = [ "multi-user.target" ];
      # Fires on the rename the engine publishes the request with.
      pathConfig.PathChanged = "${applyDir}/build-request.json";
    };

    systemd.services.daedalus-build = {
      description = "Build an app image on daedalus's behalf (BuildKit + Railpack)";
      after = [
        "network-online.target"
        "buildkitd.service"
        "daedalus-build-dockerconfig.service"
      ];
      wants = [
        "network-online.target"
        "daedalus-build-dockerconfig.service"
      ];
      # A buildkitd restart — the documented backstop for a wedged build — stops
      # this unit with it, and the reaper marks the run interrupted.
      requires = [ "buildkitd.service" ];

      # A build can outlast a rebuild, and a rebuild that changes apps.json
      # changes this unit's ExecStart (BUILDABLE, DEPLOYABLE). switch must not
      # SIGTERM a push halfway; the next request gets the new definition.
      restartIfChanged = false;

      unitConfig.RequiresMountsFor = [ builder.root ];

      serviceConfig = {
        Type = "oneshot";
        # Fail closed, first thing: no fence, no start. The egress fence is
        # firewall extraCommands (builder.nix), and a reload that failed halfway
        # leaves no OUTPUT jump — then the start fails here instead of a build
        # reaching the LAN, and the gate answers the pending request with
        # `builder unfenced`. `+`: as root, outside this unit's sandboxing,
        # where iptables can read the tables. build.sh runs fenceCheck again
        # per build, for a fence removed after the daemon started.
        ExecStartPre = [ "+${fenceGate}/bin/daedalus-build-fence-gate" ];
        ExecStart = "${buildScript}/bin/daedalus-build";
        ExecStopPost = "${buildReaper}/bin/daedalus-build-reaper";
        # Clone 5 + detect 3 (twice, with a retry) + checks 30 + build and
        # publish 45, plus slack. The engine's hard cap is 100 min from
        # dispatch (BUILD_HARD_CAP_MS); this must stay under it.
        TimeoutStartSec = "95min";
        # A SIGTERM stop is a requested stop: the operator cancelling a
        # build (daedalus-build-cancel), a shutdown, or buildkitd going
        # down and taking its Requires= with it. None of those are worth
        # mail, and build.sh's TERM trap publishes the interrupted state. A
        # crash, an OOM kill or the timeout SIGKILL exits otherwise, fails
        # the unit, mails, and leaves the state to the ExecStopPost reaper.
        SuccessExitStatus = "143";
        # The token, the JWT, the secret files, the per-build push credential
        # copy and root's plan copies live in a mktemp dir under /tmp; a
        # private /tmp keeps even their names off the shared one.
        #
        # It is also the mount namespace Railpack's mise cache lives in.
        # Railpack hard-codes /tmp/railpack/mise, and which app's cache goes
        # there is only known per request, so there is no unit-level bind:
        # build.sh mounts `miseCacheDir/<app>` at /tmp/railpack and the pinned
        # mise read-only at `misePath` (the file exists, so Railpack's
        # unverified download never happens; railpack.nix) around `railpack
        # prepare`, and unmounts both before the checks. The mounts never leave
        # this unit's namespace.
        PrivateTmp = true;
        UMask = "0077";
        # build.sh's reap (every build-user process killed before root mounts
        # the mise cache and before it copies the push credential) finds those
        # processes by uid. A build-user process that exec'd a setuid program
        # would read as another uid and survive it. Nothing here needs setuid:
        # root already holds its capabilities, and the `+` fence gate runs
        # outside this setting. (buildkitd cannot take it — builder.nix.)
        NoNewPrivileges = true;
      };
    };

    # Refusals (a bad request, failed checks, GitHub saying no) exit 0 and are
    # on the build page; what mails is the agent itself breaking.
    fleet.monitoredJobs.daedalus-build = { };

    # ── cancel ────────────────────────────────────────────────────────────

    systemd.paths.daedalus-build-cancel = {
      description = "Watch for a daedalus build cancel request";
      wantedBy = [ "multi-user.target" ];
      pathConfig.PathChanged = "${applyDir}/build-cancel-request.json";
    };

    systemd.services.daedalus-build-cancel = {
      description = "Stop the build daedalus asked to cancel";
      # Deliberately NOT monitoredJobs: its refusals are the normal case
      # (a late request, a build that already finished) and they exit 0.
      #
      # No start limit, for the reason argued over bridgeAgent in
      # daedalus-lib.nix: a path unit makes each request a start, and a refused
      # start is a dropped verb rather than a delayed one. It matters more
      # here than anywhere — the moment an operator presses Cancel twice is
      # exactly the moment they most want it to work.
      startLimitIntervalSec = 0;
      serviceConfig = {
        Type = "oneshot";
        ExecStart = "${cancelScript}/bin/daedalus-build-cancel";
        NoNewPrivileges = true;
      };
    };

    # ── the nightly sweep ─────────────────────────────────────────────────

    systemd.services.daedalus-build-gc = {
      description = "Sweep daedalus build work dirs, old logs and unused BuildKit cache";
      after = [ "buildkitd.service" ];
      wants = [ "buildkitd.service" ];
      unitConfig.RequiresMountsFor = [ builder.root ];
      serviceConfig = {
        Type = "oneshot";
        # It runs as the build user too (fleet.builder.fenceCheck's rule for
        # every such unit); a fence that is down mails from here daily.
        ExecStartPre = [ "+${builder.fenceCheck}" ];
        ExecStart = "${gcScript}/bin/daedalus-build-gc";
        TimeoutStartSec = "45min";
        PrivateTmp = true;
      };
    };

    # 04:37, off the hour (a speed test on the hour takes the house's DNS down
    # for a minute or two) and after the nightly snapshot churn.
    systemd.timers.daedalus-build-gc = {
      wantedBy = [ "timers.target" ];
      timerConfig = {
        OnCalendar = "*-*-* 04:37:00";
        Persistent = true;
      };
    };

    fleet.monitoredJobs.daedalus-build-gc = { };
  };
}
