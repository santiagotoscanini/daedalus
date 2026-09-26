# snapshots-lib — the scripts that publish what only the host can see into
# /run directories the container mounts read-only: app environments, image
# labels and their freshness, SMART/ZFS/generation facts, Claude Code's
# state, the repositories, the project workspaces, the committed registry.
# The services and timers that run them are daedalus-snapshots.nix. A plain
# function, imported by path; never a module.
{
  config,
  lib,
  pkgs,
}:

let
  inherit (import ./daedalus-lib.nix { inherit config lib pkgs; })
    registryApps
    mkAgent
    operatorVars
    operatorHomeVars
    workspaceVars
    workspaceRuntimeInputs
    envDir
    imageDir
    systemDir
    claudeDir
    repoDir
    ;

  # One body, two cadences: sync (fetch + fast-forward, network) and publish
  # (local facts only, safe to gate the container's start on). See
  # host/workspace-sync.sh for the split.
  mkWorkspaceSyncScript =
    doSync:
    mkAgent {
      name = "daedalus-workspace-${if doSync then "sync" else "publish"}";
      runtimeInputs = workspaceRuntimeInputs;
      vars = workspaceVars // {
        DO_SYNC = if doSync then "1" else "0";
      };
      files = [
        ./host/lib.sh
        ./host/workspace-lib.sh
        ./host/workspace-sync.sh
      ];
    };

  # Every snapshot below publishes into an operator-owned /run directory
  # ($OUT_DIR) as the operator (host/lib.sh), hence operatorVars throughout.

  envSnapshotScript = mkAgent {
    name = "daedalus-env-snapshot";
    runtimeInputs = [
      pkgs.podman
      pkgs.util-linux # setpriv
      pkgs.coreutils
      pkgs.gnugrep
      pkgs.jq # write_json_atomic validates before publishing
    ];
    vars = operatorHomeVars // {
      OUT_DIR = envDir;
      OPERATOR_RUNTIME_DIR = config.fleet.operator.runtimeDir;
      # The registry's apps plus daedalus itself — exactly the set with a page
      # in the UI. Derived from apps.json, so an Apply keeps it current. ALL
      # registry apps, not just the deployable ones: a frozen app still has a
      # page, and that page still shows its environment.
      APPS = lib.concatStringsSep " " (lib.attrNames registryApps ++ [ "daedalus" ]);
      PODMAN = "${pkgs.podman}/bin/podman";
    };
    files = [
      ./host/lib.sh
      ./host/env-snapshot.sh
    ];
  };

  imageSnapshotScript = mkAgent {
    name = "daedalus-image-snapshot";
    runtimeInputs = [
      pkgs.podman
      pkgs.util-linux # setpriv
      pkgs.coreutils
      pkgs.gnused
      pkgs.jq
    ];
    # Same exclusion and the same reason as the system snapshot below: the jq
    # programs here bind their own variables with --arg, and `$cv` in single
    # quotes is jq's variable, not the shell's. Letting the shell near it is
    # the bug SC2016 is warning about, in reverse.
    excludeShellChecks = [ "SC2016" ];
    vars = operatorHomeVars // {
      OUT_DIR = imageDir;
      OPERATOR_RUNTIME_DIR = config.fleet.operator.runtimeDir;
      PODMAN = "${pkgs.podman}/bin/podman";
      JQ = "${pkgs.jq}/bin/jq";
    };
    files = [
      ./host/lib.sh
      ./host/image-snapshot.sh
    ];
  };

  # Every image pinned as `:tag@sha256:…`, rendered at eval so the freshness
  # script stays dumb: container → the tag ref to ask about and the digest the
  # flake holds.
  #
  # Parsed in platform/export.nix rather than here, because the update agent
  # (verbs-lib.nix) needs the same parse and two regexes over the same strings is how
  # the probe and the thing that rewrites a pin come to disagree about what a
  # pin is. The shape is `{ image, repo, tag, digest }`; this renames `digest`
  # to the `pinnedDigest` the probe already speaks.
  pinnedImages = lib.mapAttrs (_: p: {
    inherit (p) image repo tag;
    pinnedDigest = p.digest;
  }) config.fleet.imagePins;

  # Whether each of those tags has moved on from its pin — the one version
  # question only the registry can answer. A snapshot file beside labels.json
  # rather than a fleet.export domain, deliberately: export domains carry
  # nix-eval facts and re-publish when the CONFIG changes, whereas this is a
  # runtime probe whose answer changes while the config sits still. The
  # snapshot contract (timer, envelope, staleness aged by the reader) is
  # exactly the shape of that.
  imageFreshnessScript = mkAgent {
    name = "daedalus-image-freshness";
    runtimeInputs = [
      pkgs.skopeo
      pkgs.jq
      pkgs.gnugrep
      pkgs.gnused
      pkgs.coreutils
    ];
    vars = operatorVars // {
      OUT_DIR = imageDir;
      PINNED = pkgs.writeText "daedalus-pinned-images.json" (builtins.toJSON pinnedImages);
    };
    files = [
      ./host/lib.sh
      ./host/image-freshness.sh
    ];
  };

  systemSnapshotScript = mkAgent {
    name = "daedalus-system-snapshot";
    # SC2016 is "expressions don't expand in single quotes", which is exactly
    # what every jq program in this script relies on: `$dev`, `$status` and
    # friends are jq's own variables, bound with --arg, and letting the shell
    # near them is the bug the check is warning about in reverse. Same for the
    # one awk program's `$1`/`$2`.
    excludeShellChecks = [ "SC2016" ];
    runtimeInputs = [
      pkgs.smartmontools
      pkgs.zfs
      pkgs.coreutils
      pkgs.dmidecode
      pkgs.gnused
      pkgs.gnugrep
      pkgs.gawk
      pkgs.nix
      pkgs.jq
      pkgs.systemd
    ];
    vars = operatorVars // {
      OUT_DIR = systemDir;
      # The replications the host declares (fleet.backup), one "source<TAB>target"
      # per line, so the panel watches exactly what the backup does.
      REPLICATION_PAIRS = lib.concatStringsSep "\n" (
        lib.mapAttrsToList (source: r: "${source}\t${r.target}") config.fleet.backup.replications
      );
      SMARTCTL = "${pkgs.smartmontools}/bin/smartctl";
      DMIDECODE = "${pkgs.dmidecode}/bin/dmidecode";
      ZPOOL = "${pkgs.zfs}/bin/zpool";
      ZFS = "${pkgs.zfs}/bin/zfs";
      LSBLK = "${pkgs.util-linux}/bin/lsblk";
      NIX_ENV = "${pkgs.nix}/bin/nix-env";
      UNAME = "${pkgs.coreutils}/bin/uname";
      SED = "${pkgs.gnused}/bin/sed";
      GREP = "${pkgs.gnugrep}/bin/grep";
      AWK = "${pkgs.gawk}/bin/awk";
      JQ = "${pkgs.jq}/bin/jq";
      SYSTEMCTL = "${pkgs.systemd}/bin/systemctl";
    };
    files = [
      ./host/lib.sh
      ./host/system-snapshot.sh
    ];
  };

  claudeSnapshotScript = mkAgent {
    name = "daedalus-claude-snapshot";
    # Same reason as the system snapshot: every `$name` inside the jq
    # programs is jq's own variable, bound with --arg. Letting the shell near
    # them is the bug this check warns about, in reverse.
    excludeShellChecks = [ "SC2016" ];
    runtimeInputs = [
      pkgs.coreutils
      pkgs.gnused
      pkgs.gnugrep
      pkgs.gawk
      pkgs.jq
      pkgs.systemd
    ];
    vars = operatorVars // {
      OUT_DIR = claudeDir;
      # The CLI's own state directory, and the /tmp dir the Remote Control
      # bridge writes a per-session debug log into — both keyed off the
      # operator this unit reads on behalf of, so neither is a literal that
      # can drift from platform/claude-rc.nix's User=.
      CLAUDE_HOME = "${config.users.users.${config.fleet.operator.user}.home}/.claude";
      BRIDGE_LOG_DIR = "/tmp/claude-${toString config.fleet.operator.uid}";
      # What the flake built. Read from the package rather than by running
      # `claude --version`, which is a node start-up to learn a string nix
      # already knows — and which would report the same number either way,
      # hiding exactly the drift this is here to show.
      CLI_VERSION = pkgs.claude-code.version;
      CLI_STORE = toString pkgs.claude-code;
      SED = "${pkgs.gnused}/bin/sed";
      GREP = "${pkgs.gnugrep}/bin/grep";
      AWK = "${pkgs.gawk}/bin/awk";
      JQ = "${pkgs.jq}/bin/jq";
      SYSTEMCTL = "${pkgs.systemd}/bin/systemctl";
      JOURNALCTL = "${pkgs.systemd}/bin/journalctl";
    };
    files = [
      ./host/lib.sh
      ./host/claude-snapshot.sh
    ];
  };

  repoSnapshotScript = mkAgent {
    name = "daedalus-repo-snapshot";
    # The jq program binds its own variables with --arg; `$path` in single
    # quotes is jq's, not the shell's — the same exclusion as image-snapshot.
    excludeShellChecks = [ "SC2016" ];
    runtimeInputs = [
      pkgs.coreutils
      pkgs.gawk # app_secret_history parses one git log
      pkgs.git
      pkgs.jq
      pkgs.util-linux # setpriv
    ];
    vars = operatorHomeVars // {
      OUT_DIR = repoDir;
      REPO_DIR = config.fleet.config.repo;
      SITE_DIR = config.fleet.site.path;
      GIT = "${pkgs.git}/bin/git";
      JQ = "${pkgs.jq}/bin/jq";
      AWK = "${pkgs.gawk}/bin/awk";
      DATE = "${pkgs.coreutils}/bin/date";
    };
    files = [
      ./host/lib.sh
      ./host/repo-snapshot.sh
    ];
  };

  # Copies the committed registry to a FIXED path inside the bind mount, so the
  # container can read what Nix last built without that content being part of
  # its unit.
  #
  # The store-path dependency moves here, which is the point: this tiny oneshot
  # re-runs whenever apps.json changes (its ExecStart embeds the file's store
  # path, so the unit definition changes and systemd restarts it), while the
  # container's definition stays put. Nothing else about the app moves.
  # Into /run/daedalus-export — the READ-ONLY mount — not the rw apply dir:
  # applied.json is the drift-comparison target, the one file the app must
  # not be able to overwrite.
  registrySnapshot = pkgs.writeShellApplication {
    name = "daedalus-registry-snapshot";
    runtimeInputs = [ pkgs.coreutils ];
    text = ''
      install -d -m 0755 /run/daedalus-export
      install -m 0644 ${config.fleet.registry.file} /run/daedalus-export/applied.json
    '';
  };
in
{
  inherit
    mkWorkspaceSyncScript
    envSnapshotScript
    imageSnapshotScript
    imageFreshnessScript
    systemSnapshotScript
    claudeSnapshotScript
    repoSnapshotScript
    registrySnapshot
    ;
}
