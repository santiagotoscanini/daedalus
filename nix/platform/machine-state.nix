# Machine-generated state — the passwords and keys this box mints for itself
# (the pg cluster and per-app roles, each app's AUTH_SECRET, the builder's
# registry credential) — and where it lives.
#
# It used to live INSIDE the configuration checkout, under `stacks/*/secrets/`,
# gitignored. Three things were wrong with that: plaintext credentials sat in
# a directory whose whole point is to be cloned and pushed; `/etc/nixos` is not
# a snapshotted dataset, so the one copy of every database password on the box
# was in no backup; and an importable engine (plan, Phase 11) has no checkout
# of its own to keep them in. `fleet.stateRoot` answers all three — it is the
# snapshotted, mirrored tree every other piece of container state already
# lives in.
#
# ── the migration ─────────────────────────────────────────────────────────
#
# Owners register the path they used to use (`fleet.machineStateLegacy.<name>`)
# and read `${fleet.machineState}/<name>` from now on. One root oneshot moves
# each legacy tree across, once: copy with ownership and modes, compare, and
# only then delete the original. It is idempotent — a legacy path that is gone
# is a migration that already happened.
#
# The ordering is the load-bearing part, and it is `requiredBy`, not just
# `before`. Every bootstrap here GENERATES a fresh secret when it finds none:
# run ahead of the migration, `app-db-cluster-bootstrap` would mint a new
# superuser password beside a cluster initialised with the old one, and every
# tenant on the box would fail to authenticate. So a failed migration must
# stop the bootstraps rather than race them, and the unit lists every reader
# by name (derived from the same registries that generate those units).
{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.fleet;

  pairs = lib.mapAttrsToList (name: from: {
    inherit name from;
    to = "${cfg.machineState}/${name}";
  }) cfg.machineStateLegacy;
in
{
  options.fleet = {
    machineState = lib.mkOption {
      type = lib.types.str;
      default = "${cfg.stateRoot}/daedalus/state";
      defaultText = lib.literalExpression ''"''${config.fleet.stateRoot}/daedalus/state"'';
      description = ''
        Root of the state this box generates for itself — credentials minted
        by bootstrap oneshots, rotated by deleting the file. One directory per
        owner underneath. Never inside the configuration checkout.
      '';
    };

    machineStateLegacy = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      example = lib.literalExpression ''{ app-db = "''${config.fleet.config.repo}/stacks/app-db/secrets"; }'';
      description = ''
        Owner name → the in-checkout directory its state lived in before it
        moved under `fleet.machineState`. Read only by the one-time migration;
        an entry can be deleted once no box still carries the old tree.
      '';
    };

    machineStateReaders = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      description = ''
        Units that read or generate machine state. Each is ordered after the
        migration AND requires it, so a migration that failed stops them
        instead of letting a bootstrap mint a fresh secret over a moved one.
      '';
    };
  };

  config = lib.mkIf (pairs != [ ]) {
    systemd.services.machine-state-migrate = {
      description = "Move machine-generated state out of the configuration checkout";
      wantedBy = [ "multi-user.target" ];
      after = [ "local-fs.target" ];
      before = [ "state-paths.service" ] ++ cfg.machineStateReaders;
      requiredBy = [ "state-paths.service" ] ++ cfg.machineStateReaders;
      unitConfig.RequiresMountsFor = [ cfg.stateRoot ];
      path = [
        pkgs.coreutils
        pkgs.diffutils
      ];
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
      };
      script = ''
        set -eu
        umask 077
        install -d -m 0755 -o ${cfg.operator.user} -g ${cfg.operator.group} ${lib.escapeShellArg (dirOf cfg.machineState)}
        install -d -m 0755 -o ${cfg.operator.user} -g ${cfg.operator.group} ${lib.escapeShellArg cfg.machineState}

        migrate() {
          name=$1 from=$2 to=$3
          if [ ! -d "$from" ]; then
            return 0
          fi
          if [ -z "$(ls -A "$from")" ]; then
            rmdir "$from"
            return 0
          fi
          if [ -e "$to" ] && [ -n "$(ls -A "$to" 2>/dev/null)" ]; then
            # Both exist. Only acceptable when they are the same bytes — an
            # earlier run copied and died before deleting. Anything else is
            # two diverged sets of credentials, and choosing between them is
            # not this unit's call.
            if diff -r "$from" "$to" >/dev/null; then
              rm -rf "$from"
              echo "machine-state: $name was already copied; removed $from"
              return 0
            fi
            echo "machine-state: $from and $to both hold state and differ — refusing to choose" >&2
            return 1
          fi
          rm -rf "$to.partial"
          cp -a "$from" "$to.partial"
          diff -r "$from" "$to.partial" >/dev/null
          [ -e "$to" ] && rmdir "$to"
          mv "$to.partial" "$to"
          rm -rf "$from"
          echo "machine-state: moved $name from $from to $to"
        }

        ${lib.concatMapStringsSep "\n" (
          p: "migrate ${lib.escapeShellArg p.name} ${lib.escapeShellArg p.from} ${lib.escapeShellArg p.to}"
        ) pairs}
      '';
    };

    # A migration that refuses is a box whose credentials need a person.
    fleet.monitoredJobs.machine-state-migrate = { };
  };
}
