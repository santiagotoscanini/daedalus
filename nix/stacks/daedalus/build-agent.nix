# daedalus-build — the host side of the root helper's `build` verb: turn the
# build request the engine hands it (the run file's payload) into an image in
# the box's registry, then start the app's deploy.
#
# ── the units ─────────────────────────────────────────────────────────────
#
#   daedalus-build@<run>.service   one build, started by the root helper
#                                  (`build`), one at a time —
#     ExecStartPre   fleet.builder.fenceCheck  no egress fence, no build
#     ExecStart      host/build.sh             token, clone, railpack prepare,
#                    + host/build-stages/*     checks, build + push, deploy
#                                              (one file per stage; not named
#                                              `build/`, which editors hide)
#     ExecStopPost   host/build-reaper.sh      a run that died unannounced
#                                              reads `failed: interrupted`,
#                                              one that never started (the
#                                              fence) fails its build;
#                                              then the run file goes
#   daedalus-build-cancel@<app>.service    the root helper's `build-cancel` →
#                                          host/build-cancel.sh
#   daedalus-build-gc.{timer,service}      nightly sweep → host/build-gc.sh
#
# ── how each script is made ───────────────────────────────────────────────
#
# A writeShellApplication whose text is, in order: the variables nix hands it
# (`NAME='value'` lines, fixed when the system is built), the shared helpers
# (host/lib.sh — the rules for touching files the operator can write;
# host/github-lib.sh for the build itself), then the script under host/. So
# a change to a builder path is a new script; the one run-time lookup is the
# registry (host/build.sh opens with the trust model, and that is in it).
#
# Gated like the builder itself (`fleet.builder.enable`: the GitHub App's
# vault file is in the flake). Nothing here exists before the App does. The
# daemon, the build user, the scratch dataset and the egress fence are
# ./builder.nix; the Railpack and mise pins are ./railpack.nix.
#
# What it reads from elsewhere, and why each is a derivation rather than a copy:
#   DEPLOYABLE  daedalus-lib.nix's `deployableApps`, from the committed
#               site/apps.json — the same list the root helper's `deploy`
#               takes, because a name in it becomes part of a unit root starts.
#               Which apps it may BUILD is not baked: build.sh reads the
#               committed registry at run time (its header says why that
#               holds), and NIX_APPS is the one list it needs beside it.
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
    verbsDir
    registryApps
    deployableApps
    dropRunFile
    mkAgent
    mkRootVerb
    operatorVars
    operatorHomeVars
    rootRunDir
    ;

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

  # ── the scripts ───────────────────────────────────────────────────────────
  #
  # Each is daedalus-lib.nix's mkAgent: the variables below, then the named
  # files under host/, as one shell script.

  # daedalus-build's ExecStart.
  buildScript = mkAgent {
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
      pkgs.git # the registry read, as the operator
    ];
    vars = operatorHomeVars // {
      # where the status is published (the request is the run file's)
      VERBS_DIR = verbsDir;

      # which apps it may build: the committed registry in the site directory,
      # read at run time, minus the apps the host declares by hand (an
      # entry could shadow one: nix would refuse it, the read does not
      # evaluate it)
      SITE_DIR = config.fleet.site.path;
      NIX_APPS = lib.concatStringsSep " " (
        lib.attrNames (removeAttrs config.fleet.apps (lib.attrNames registryApps))
      );
      # the apps whose deploy it starts once the image is pushed
      DEPLOYABLE = lib.concatStringsSep " " deployableApps;

      # the GitHub App; its private key never leaves the host
      OWNER = appField "owner";
      OWNER_ID = config.fleet.github.expectedOwnerId; # the trusted constant
      CLIENT_ID = appField "clientId";
      PEM = config.sops.secrets."github-app-pem".path;

      # where images go, and where installs come from: the npm mirror's name
      # is pinned to the LAN address inside BuildKit
      REGISTRY = builder.registryHost;
      NPM_MIRROR_HOST = builder.npmMirrorHost;
      LAN_IP = config.fleet.lanIp;

      # BuildKit: the rootless daemon's socket, the gateway image that turns
      # a Railpack plan into build steps, and the push credential (copied in
      # for the one publishing call)
      BUILDKIT_ADDR = builder.socket;
      RAILPACK_FRONTEND = builder.railpackFrontend;
      DOCKER_CONFIG_DIR = builder.dockerConfigDir;

      # scratch: one work dir per build, one log per build
      BUILD_ROOT = builder.root;
      WORK_ROOT = builder.workDir;
      LOG_DIR = builder.logDir;

      # Railpack's mise: one cache per app, where railpack looks for mise,
      # and the pinned binary bound there
      MISE_CACHE_DIR = builder.miseCacheDir;
      MISE_MOUNT = dirOf (dirOf builder.misePath);
      MISE_PATH = builder.misePath;
      MISE_BINARY = builder.miseBinary;

      # the unprivileged build user, and its whole PATH
      BUILD_USER = builder.user;
      BUILD_GROUP = buildGroup;
      BUILD_PATH = buildPath;

      # the Dockerfile route — unused while every app builds with Railpack
      NODE_IMAGE = nodeImage;
      CHECKS_DOCKERFILE = ./host/build-stages/Dockerfile.checks;

      # the egress fence, checked again per build
      FENCE_CHECK = builder.fenceCheck;
    };
    files = [
      ./host/lib.sh
      ./host/github-lib.sh
      ./host/build.sh
      ./host/build-stages/states.sh
      ./host/build-stages/helpers.sh
      ./host/build-stages/0-request.sh
      ./host/build-stages/1-token.sh
      ./host/build-stages/2-clone.sh
      ./host/build-stages/3-detect.sh
      ./host/build-stages/4-checks.sh
      ./host/build-stages/5-publish.sh
      ./host/build-stages/6-done.sh
    ];
  };

  # daedalus-build's ExecStopPost: marks a run that died without publishing
  # its own end, and drops its work dir.
  buildReaper = mkAgent {
    name = "daedalus-build-reaper";
    runtimeInputs = [
      pkgs.jq
      pkgs.coreutils
    ];
    vars = operatorVars // {
      STATUS = "${verbsDir}/build-status.json";
      LOG_DIR = builder.logDir;
      WORK_ROOT = builder.workDir;
      BUILD_USER = builder.user;
      BUILD_GROUP = buildGroup;
    };
    files = [
      ./host/lib.sh
      ./host/build-stages/states.sh
      ./host/build-reaper.sh
    ];
  };

  # daedalus-build-cancel@'s ExecStart: stops the build in flight, and only
  # when it is the named app's (the request's `app`, in its run file).
  cancelScript = mkAgent {
    name = "daedalus-build-cancel";
    runtimeInputs = [
      pkgs.jq
      pkgs.coreutils
      pkgs.util-linux # setpriv, for lib.sh's operator-side reads
      config.systemd.package # systemctl
    ];
    vars = operatorVars // {
      STATUS = "${verbsDir}/build-status.json";
    };
    files = [
      ./host/lib.sh
      ./host/build-stages/states.sh
      ./host/build-cancel.sh
    ];
  };

  # daedalus-build-gc's ExecStart: old work dirs, old logs, unused cache. It
  # touches no container-writable directory, so it needs no operator.
  gcScript = mkAgent {
    name = "daedalus-build-gc";
    runtimeInputs = [
      pkgs.coreutils
      pkgs.findutils
      pkgs.util-linux # setpriv, flock
    ];
    vars = {
      WORK_ROOT = builder.workDir;
      LOG_DIR = builder.logDir;
      BUILDKIT_ADDR = builder.socket;
      BUILD_USER = builder.user;
      BUILD_GROUP = buildGroup;
      BUILD_PATH = buildPath;
      SETPRIV = "${pkgs.util-linux}/bin/setpriv";
      ENV_BIN = "${pkgs.coreutils}/bin/env";
    };
    files = [ ./host/build-gc.sh ];
  };
in

{
  config = lib.mkIf (config.fleet.modules.daedalus.enable && builder.enable) (
    lib.mkMerge [
      {
        # The checks target's base, listed on System › Updates. Not the control
        # plane's own node (NODE_IMAGE in the engine's Dockerfile): the two are
        # bumped apart, on purpose.
        fleet.manualPins.build-checks-node = {
          image = nodeImage;
          upstream = "nodejs/node";
          note = "Candidate-build a Dockerfile-strategy app before any live one.";
        };
      }

      # ── the build ───────────────────────────────────────────────────────
      #
      # The root helper's `build`: the engine's scheduler asks for it with the
      # request as the payload (app lib/builds.ts buildRequestDecoder), and
      # the helper starts `daedalus-build@<run>`, one at a time. Refusals (a
      # bad request, failed checks, GitHub saying no) exit 0 and are on the
      # build page; what mails is the agent itself breaking.
      (mkRootVerb {
        verb = "build";
        unit = "daedalus-build";
        description = "Build an app image on daedalus's behalf (BuildKit + Railpack)";
        verbDescription = "Build an app's image and start its deploy";
        script = buildScript;
        # Clone 5 + detect 3 (twice, with a retry) + checks 30 + build and
        # publish 45, plus slack. The engine's hard cap is 100 min from
        # dispatch (BUILD_HARD_CAP_MS); this must stay under it.
        timeoutStartSec = 95 * 60;
        # The engine's request, at most BUILD_REQUEST_MAX_BYTES (60 KiB);
        # build.sh refuses one past 64 KiB on its own.
        payloadMax = 65536;
        # Marks a run that died without publishing its own end, and drops its
        # work dir.
        execStopPost = [ "${buildReaper}/bin/daedalus-build-reaper" ];
        unitAttrs = {
          after = [
            "network-online.target"
            "buildkitd.service"
            "daedalus-build-dockerconfig.service"
          ];
          wants = [
            "network-online.target"
            "daedalus-build-dockerconfig.service"
          ];
          # A buildkitd restart — the documented backstop for a wedged build —
          # stops this unit with it, and the reaper marks the run interrupted.
          requires = [ "buildkitd.service" ];
          unitConfig.RequiresMountsFor = [ builder.root ];
        };
        serviceConfig = {
          # Fail closed, first thing: no fence, no start. The egress fence is
          # firewall extraCommands (builder.nix), and a reload that failed
          # halfway leaves no OUTPUT jump — then the start fails here instead
          # of a build reaching the LAN; the reaper (ExecStopPost) then
          # publishes the build failed under its own id, so the engine folds
          # it however long the app was away. `+`: as root,
          # outside this unit's sandboxing, where iptables can read the
          # tables. build.sh runs fenceCheck again per build, for a fence
          # removed after the daemon started.
          ExecStartPre = [ "+${builder.fenceCheck}" ];
          # A SIGTERM stop is a requested stop: the operator cancelling a
          # build (daedalus-build-cancel), a shutdown, or buildkitd going
          # down and taking its Requires= with it. None of those are worth
          # mail, and build.sh's TERM trap publishes the interrupted state. A
          # crash, an OOM kill or the timeout SIGKILL exits otherwise, fails
          # the unit, mails, and leaves the state to the ExecStopPost reaper.
          SuccessExitStatus = "143";
          # The token, the JWT, the secret files, the per-build push
          # credential copy and root's plan copies live in a mktemp dir under
          # /tmp; a private /tmp keeps even their names off the shared one.
          #
          # It is also the mount namespace Railpack's mise cache lives in.
          # Railpack hard-codes /tmp/railpack/mise, and which app's cache goes
          # there is only known per request, so there is no unit-level bind:
          # build.sh mounts `miseCacheDir/<app>` at /tmp/railpack and the
          # pinned mise read-only at `misePath` (the file exists, so Railpack's
          # unverified download never happens; railpack.nix) around `railpack
          # prepare`, and unmounts both before the checks. The mounts never
          # leave this unit's namespace.
          PrivateTmp = true;
          UMask = "0077";
          # build.sh's reap (every build-user process killed before root
          # mounts the mise cache and before it copies the push credential)
          # finds those processes by uid. A build-user process that exec'd a
          # setuid program would read as another uid and survive it. Nothing
          # here needs setuid: root already holds its capabilities, and the
          # `+` fence check runs outside this setting. (buildkitd cannot take
          # it — builder.nix.)
          NoNewPrivileges = true;
        };
      })

      {
        # ── cancel ────────────────────────────────────────────────────────────

        # The root helper's `build-cancel` (root-helper.nix): a template the
        # run id instantiates, the app a pattern selector in its run file —
        # not a list, because a new app's first build runs before any rebuild
        # could have put its name in one. The name never reaches a unit name;
        # the script stops the build in flight only when the status (written
        # by the build, which authorized the app) names that app.
        systemd.services."daedalus-build-cancel@" = {
          description = "Stop an app's build, on daedalus's behalf";
          # Deliberately NOT monitoredJobs: its refusals are the normal case
          # (a late cancel, a build that already finished) and they exit 0.
          # No start limit: the moment an operator presses Cancel twice is exactly
          # the moment they most want it to work.
          startLimitIntervalSec = 0;
          serviceConfig = {
            Type = "oneshot";
            ExecStart = "${cancelScript}/bin/daedalus-build-cancel";
            LoadCredential = "request:${rootRunDir}/%i.json";
            ExecStopPost = dropRunFile;
            NoNewPrivileges = true;
          };
        };

        fleet.daedalus.rootVerbs.build-cancel = {
          unit = "daedalus-build-cancel@.service";
          description = "Stop an app's build in flight";
          # An app name the builder takes (host/build.sh): no hyphen.
          patterns.app = {
            regex = "^[a-z0-9]{1,63}$";
            maxLength = 63;
          };
          # The stop waits for the build's TERM trap and its reaper.
          timeoutSec = 150;
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
      }
    ]
  );
}
