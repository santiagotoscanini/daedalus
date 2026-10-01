# platform/upgrade-guard — reboot-level changes are never activated live, and
# the first boot of one is checked with a way back.
#
# Three pieces, one comparison:
#
#   fleet-switch-guard (switch-guard.sh) — the ONE answer to "may this
#     generation be activated on the running system, or does it need a
#     reboot?" It compares kernel, initrd, kernel-module tree, ZFS userland
#     major.minor, systemd major and the D-Bus implementation. Asked by:
#       - every generation's own pre-switch check (`system.preSwitchChecks`),
#         which `switch-to-configuration` runs for switch/test/check — the new
#         generation's check, so it holds on the FIRST move to a new release,
#         even from a running system that predates this module, and for a
#         person typing `nixos-rebuild switch` as much as for any agent;
#       - daedalus's rebuilding verbs (apply, engine/image/version update),
#         after their build and before activating, so a refusal is reported as
#         "reboot required" rather than as a failed switch to roll back;
#       - platform/autoupgrade, which only ever runs `boot` and so says in its
#         log when the generation it staged needs the reboot to take effect;
#       - fleet-upgrade-preflight --target.
#     The deliberate override is nixpkgs' own: NIXOS_NO_CHECK=1.
#
#   switch inhibitors — the same facts as nixpkgs' `system.switch.inhibitors`,
#     so its own check compares them too.
#
#   fleet-upgrade-preflight (preflight.sh) and upgrade-selfcheck
#     (selfcheck.sh) — read-only readiness checks before the reboot, and the
#     armed-only check after it (the header of selfcheck.sh has the flow).
#     Both run checks.sh; a host adds its own (fleet.upgradeGuard.checks).
#
# The host brings: `fleet.upgradeGuard.criticalContainers` / `minContainers`
# if it wants the selfcheck to insist on them, and `bootFallback.enable`.

{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.fleet.upgradeGuard;

  switchGuard = pkgs.writeShellApplication {
    name = "fleet-switch-guard";
    runtimeInputs = [
      pkgs.coreutils
      pkgs.gnugrep
      pkgs.gnused
      pkgs.jq
    ];
    text = builtins.readFile ./switch-guard.sh;
  };

  # The facts, as switch inhibitors. Values compare as strings; store paths
  # for the boot artefacts (any change needs the reboot), versions for the
  # userland whose point releases are safe to activate live.
  inhibitors = {
    fleet-kernel = "${config.boot.kernelPackages.kernel}";
    fleet-initrd = "${config.system.build.initialRamdisk}";
    fleet-kernel-modules = "${config.system.modulesTree}";
    fleet-systemd = lib.versions.major config.systemd.package.version;
  }
  // lib.optionalAttrs (config.boot.supportedFilesystems.zfs or false) {
    fleet-zfs = lib.versions.majorMinor config.boot.zfs.package.version;
  };

  # Everything the checks read, as variables ahead of checks.sh.
  rootFs = config.fileSystems."/" or { };
  pools = lib.unique (
    map (ds: lib.head (lib.splitString "/" ds)) (
      lib.attrNames config.fleet.zfs.datasets
      ++ lib.optional ((rootFs.fsType or "") == "zfs") rootFs.device
    )
  );
  declaredContainers = pkgs.writeText "upgrade-guard-containers" (
    lib.concatMapStrings (n: n + "\n") (
      lib.attrNames (lib.filterAttrs (_: c: c.autoStart) config.virtualisation.oci-containers.containers)
    )
  );
  nodesFile = pkgs.writeText "upgrade-guard-nodes" (
    lib.concatMapStrings (n: "${n.id} ${n.name}\n") config.fleet.nodes
  );
  daedalusOn = config.fleet.modules.daedalus.enable or false;
  syncoidUnits = map (n: "syncoid-${lib.replaceStrings [ "/" ] [ "-" ] n}.service") (
    lib.attrNames config.services.syncoid.commands
  );
  # The identity provider's host, from the platform's issuer URL ("" when none).
  ssoHost = lib.head (lib.splitString "/" (lib.removePrefix "https://" config.fleet.sso.issuerUrl));

  vars = {
    POOLS = lib.concatStringsSep " " pools;
    ESP = config.boot.loader.efi.efiSysMountPoint;
    LOCKFILE = config.fleet.rebuildLock;
    # A root verb's template (`x@`) is asked as the glob of its instances:
    # `systemctl is-active` takes a pattern, and names no unit while none runs.
    REBUILD_UNITS =
      lib.concatMapStringsSep " " (n: if lib.hasSuffix "@" n then "${n}*.service" else "${n}.service")
        (
          lib.filter (n: config.systemd.services ? ${n}) [
            "flake-autoupgrade"
            "daedalus-apply"
            "daedalus-engine-update"
            "daedalus-image-update@"
            "daedalus-version-update@"
            "daedalus-claude-code-update"
          ]
        );
    AGE_KEYS = lib.concatStringsSep " " (
      config.sops.age.sshKeyPaths
      ++ lib.optional (config.sops.age.keyFile != null) config.sops.age.keyFile
    );
    # One entry per secret, plus `rendered/` when there are templates.
    EXPECTED_SECRETS = toString (
      lib.length (lib.attrNames config.sops.secrets) + (if config.sops.templates != { } then 1 else 0)
    );
    DECLARED_CONTAINERS = "${declaredContainers}";
    CRITICAL_CONTAINERS = lib.concatStringsSep " " cfg.criticalContainers;
    MIN_CONTAINERS = toString cfg.minContainers;
    # A start job running this long is a hung one (check_start_jobs).
    STUCK_MIN = "5";
    OPERATOR_USER = config.fleet.operator.user;
    OPERATOR_GROUP = config.fleet.operator.group;
    OPERATOR_HOME = config.fleet.operator.home;
    OPERATOR_RUNTIME_DIR = config.fleet.operator.runtimeDir;
    PODMAN = "${pkgs.podman}/bin/podman";
    SSO_HOST = ssoHost;
    DNS_PROBE = config.fleet.baseDomain;
    LAN_IP = config.fleet.lanIp;
    LAN_IF = config.fleet.lanInterface;
    STATUS_PORT = if daedalusOn then toString config.fleet.daedalus.statusPort else "";
    NODES = "${nodesFile}";
    SYNCOID_UNITS = lib.concatStringsSep " " syncoidUnits;
    SYNCOID_MAX_AGE = toString cfg.syncoidMaxAgeSec;
    HOST_CHECKS = lib.concatStringsSep " " (lib.attrNames cfg.checks);
  };

  varLines = lib.concatStrings (lib.mapAttrsToList (n: v: "${n}=${lib.escapeShellArg v}\n") vars);
  hostChecks = lib.concatStrings (
    lib.mapAttrsToList (n: body: ''
      host_check_${n}() {
      ${body}
      }
    '') cfg.checks
  );

  checkInputs = [
    switchGuard
    pkgs.coreutils
    pkgs.gawk
    pkgs.gnugrep
    pkgs.gnused
    pkgs.findutils
    pkgs.jq
    pkgs.curl
    pkgs.dnsutils
    pkgs.iproute2
    pkgs.procps
    pkgs.util-linux
    pkgs.systemd
    pkgs.inetutils # hostname
    config.boot.zfs.package
  ];

  # Each script runs a subset of checks.sh, by name through run_check, so the
  # rest read as never invoked (SC2329).
  preflight = pkgs.writeShellApplication {
    name = "fleet-upgrade-preflight";
    runtimeInputs = checkInputs;
    excludeShellChecks = [ "SC2329" ];
    text = varLines + builtins.readFile ./checks.sh + hostChecks + builtins.readFile ./preflight.sh;
  };

  selfcheck = pkgs.writeShellApplication {
    name = "upgrade-selfcheck";
    runtimeInputs = checkInputs;
    excludeShellChecks = [
      "SC2329"
      "SC2034" # the shared variables it does not read (HOST_CHECKS, …)
    ];
    text =
      varLines
      + ''
        STATE_DIR=${lib.escapeShellArg cfg.stateDir}
        DEADLINE_MIN=${toString cfg.deadlineMinutes}
        MAIL_FROM=${lib.escapeShellArg config.fleet.mail.sender}
        MAIL_TO=${lib.escapeShellArg config.fleet.mail.alertTo}
        MSMTP=${pkgs.msmtp}/bin/msmtp
      ''
      + builtins.readFile ./checks.sh
      + builtins.readFile ./selfcheck.sh;
  };
in
{
  options.fleet.upgradeGuard = {
    package = lib.mkOption {
      type = lib.types.package;
      readOnly = true;
      default = switchGuard;
      description = ''
        `fleet-switch-guard NEW [REF]`: exit 0 when NEW may be activated on
        the running system (or on REF), exit 3 with the reasons when it needs
        a reboot. The one comparison every activating path asks.
      '';
    };

    checks = lib.mkOption {
      type = lib.types.attrsOf lib.types.lines;
      default = { };
      example = {
        game-players = ''
          echo "nobody online"
        '';
      };
      description = ''
        Extra preflight checks, by name: a shell function body that prints one
        line and returns 0 (PASS), 1 (FAIL) or 2 (WARN). Contributed by the
        stack that knows how to ask (a game server's player count, say). Runs
        as root, read-only; `podman_op` runs podman as the operator.
      '';
    };

    criticalContainers = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      example = [
        "traefik"
        "pocket-id"
      ];
      description = "Containers upgrade-selfcheck insists are running before it calls an upgrade boot good.";
    };

    minContainers = lib.mkOption {
      type = lib.types.ints.unsigned;
      default = 0;
      description = "The floor on running containers upgrade-selfcheck insists on.";
    };

    deadlineMinutes = lib.mkOption {
      type = lib.types.ints.positive;
      default = 15;
      description = "Minutes after boot by which an armed upgrade boot must pass, or be rebooted away from.";
    };

    syncoidMaxAgeSec = lib.mkOption {
      type = lib.types.ints.positive;
      default = 3 * 3600;
      description = "How old the last successful syncoid run may be before the preflight fails it.";
    };

    stateDir = lib.mkOption {
      type = lib.types.str;
      default = "/var/lib/upgrade-guard";
      readOnly = true;
      description = "Where the arming marker (`armed`) and the last result live. Root's.";
    };

    bootFallback.enable = lib.mkEnableOption ''
      the stage-1 half of the upgrade fallback: on a systemd initrd, a boot
      that has not reached the root file system within ten minutes, or that
      landed in the emergency target, is force-rebooted (the one-shot boot
      entry is then spent, so the firmware comes back on the default one),
      and a kernel panic reboots after 30 s. Needs a systemd initrd'';
  };

  config = lib.mkMerge [
    {
      environment.systemPackages = [
        switchGuard
        preflight
        selfcheck
      ];

      # The new generation's own check: skipped for boot (installing for the
      # next boot is exactly what a reboot-level change wants) and
      # dry-activate.
      system.preSwitchChecks.fleet-switch-guard = ''
        case "''${2:-}" in
          boot | dry-activate) exit 0 ;;
        esac
        ${lib.getExe switchGuard} "$1"
      '';

      systemd.tmpfiles.settings.upgrade-guard.${cfg.stateDir}.d = {
        mode = "0700";
        user = "root";
        group = "root";
      };

      # Inert unless armed (selfcheck.sh). After basic.target — the default —
      # and deliberately not after multi-user.target, so a boot that stalls
      # before it is still reached by the deadline. Never restarted by a
      # switch: it is a boot-time check, and a restart mid-run would lose its
      # clock.
      systemd.services.upgrade-selfcheck = {
        description = "Check an armed upgrade boot, and fall back if it fails";
        wantedBy = [ "multi-user.target" ];
        after = [ "local-fs.target" ];
        restartIfChanged = false;
        serviceConfig = {
          Type = "oneshot";
          ExecStart = lib.getExe selfcheck;
          TimeoutStartSec = "infinity";
        };
      };

      # Stage 2 lands in emergency.target (a mount that fails, say) before the
      # selfcheck can run. Armed only: reboot after 90 s onto the default entry.
      systemd.services.upgrade-emergency-fallback = {
        description = "Reboot out of emergency mode during an armed upgrade boot";
        wantedBy = [ "emergency.target" ];
        unitConfig = {
          DefaultDependencies = false;
          ConditionPathExists = "${cfg.stateDir}/armed";
          SuccessAction = "reboot-force";
        };
        serviceConfig = {
          Type = "oneshot";
          ExecStart = "${pkgs.coreutils}/bin/sleep 90";
        };
      };
    }

    { system.switch.inhibitors = inhibitors; }

    (lib.mkIf cfg.bootFallback.enable {
      assertions = [
        {
          assertion = config.boot.initrd.systemd.enable;
          message = "fleet.upgradeGuard.bootFallback needs a systemd initrd (boot.initrd.systemd.enable).";
        }
      ];
    })

    (lib.mkIf cfg.bootFallback.enable {
      boot.kernelParams = [ "panic=30" ];
      boot.initrd.systemd = {
        # A hang: the root never mounted, or switch-root never came.
        targets.initrd.unitConfig = {
          JobTimeoutSec = "10min";
          JobTimeoutAction = "reboot-force";
        };
        targets.initrd-switch-root.unitConfig = {
          JobTimeoutSec = "12min";
          JobTimeoutAction = "reboot-force";
        };
        # A failure: emergency.target, whose shell is locked when
        # emergencyAccess is off, would otherwise wait at the console forever.
        services.fleet-emergency-reboot = {
          description = "Reboot out of the initrd's emergency mode";
          wantedBy = [ "emergency.target" ];
          unitConfig = {
            DefaultDependencies = false;
            SuccessAction = "reboot-force";
          };
          serviceConfig = {
            Type = "oneshot";
            ExecStart = "/bin/sleep 90";
          };
        };
      };
    })
  ];
}
