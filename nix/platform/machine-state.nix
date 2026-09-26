# Machine-generated state — the passwords and keys this box mints for itself
# (the pg cluster and per-app roles, each app's AUTH_SECRET, the builder's
# registry credential) — and where it lives.
#
# Never INSIDE the configuration checkout: plaintext credentials do not belong
# in a directory whose whole point is to be cloned and pushed; the checkout is
# not a snapshotted dataset, so the one copy of every database password would
# be in no backup; and an importable engine has no checkout of its own to keep
# them in. `fleet.stateRoot` answers all three — it is the snapshotted,
# mirrored tree every other piece of container state already lives in.
#
# Every bootstrap that writes here GENERATES a fresh secret when it finds
# none, so restoring a box means restoring this tree BEFORE its first rebuild.
{ config, lib, ... }:

let
  cfg = config.fleet;
in
{
  options.fleet.machineState = lib.mkOption {
    type = lib.types.str;
    default = "${cfg.stateRoot}/daedalus/state";
    defaultText = lib.literalExpression ''"''${config.fleet.stateRoot}/daedalus/state"'';
    description = ''
      Root of the state this box generates for itself — credentials minted
      by bootstrap oneshots, rotated by deleting the file. One directory per
      owner underneath. Never inside the configuration checkout.
    '';
  };

  # The root and its parent, owned by the operator (container uid 0).
  config.fleet.statePaths = {
    "${dirOf cfg.machineState}" = { };
    "${cfg.machineState}" = { };
  };
}
