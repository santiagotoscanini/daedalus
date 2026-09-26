# Machine-generated state — the passwords and keys this box mints for itself
# (the pg cluster and per-app roles, each app's AUTH_SECRET, the builder's
# registry credential) — and where it lives.
#
# Never INSIDE the configuration checkout (where it once sat, under
# `stacks/*/secrets/`, gitignored): plaintext credentials do not belong in a
# directory whose whole point is to be cloned and pushed; the checkout is not
# a snapshotted dataset, so the one copy of every database password would be
# in no backup; and an importable engine has no checkout of its own to keep
# them in. `fleet.stateRoot` answers all three — it is the snapshotted,
# mirrored tree every other piece of container state already lives in.
#
# ── the migration (finished; being retired in two steps) ─────────────────
#
# Owners registered the path they used to use (`fleet.machineStateLegacy.<name>`)
# and read `${fleet.machineState}/<name>` from now on; one root oneshot moved
# each legacy tree across, once. Every box has migrated.
#
# STEP 1 (this rev): the unit stays defined, but nothing is tied to it any
# more — the `requiredBy`/`before` on every bootstrap, state-paths and
# podman-pg are gone. It cannot simply be deleted in one switch: a removed
# unit is STOPPED with the old dependency graph still loaded, and a stop
# propagates to every unit that `Requires=` it — podman-pg among them, which
# is a fleet event. `restartIfChanged = false` keeps this switch from
# restarting it (same propagation), and `X-StopOnRemoval = false` keeps the
# next one from stopping it.
#
# STEP 2 (the next rev, after step 1 is switched): delete this unit,
# `machineStateLegacy` and the owners' registrations.
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
  };

  config = lib.mkIf (pairs != [ ]) {
    systemd.services.machine-state-migrate = {
      description = "Move machine-generated state out of the configuration checkout";
      wantedBy = [ "multi-user.target" ];
      after = [ "local-fs.target" ];
      # Retirement step 1 (see the header): no unit depends on this one, a
      # switch neither restarts it nor, once it is deleted, stops it.
      restartIfChanged = false;
      unitConfig = {
        RequiresMountsFor = [ cfg.stateRoot ];
        X-StopOnRemoval = false;
      };
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
