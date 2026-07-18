# platform/fleet-lib — pure helpers shared across the platform layer,
# as a by-path library (`*-lib.nix` files are excluded from the
# auto-import; consumers import this by path). Owner of the
# bridge-membership spec syntax, consumed by podman.nix (flag
# injection) and publishing.nix (isolation assertions).

{ lib }:

rec {
  # A bridgeMemberships element is "<bridge>" or "<bridge>:<suffix>"
  # ("nextcloud:alias=redis"); the part before the first ":" names the
  # bridge, anything after it passes through to podman's --network
  # option syntax.
  bridgeOf = spec: lib.head (lib.splitString ":" spec);
  networkFlag =
    spec:
    let
      bridge = bridgeOf spec;
      suffix = lib.removePrefix bridge spec;
    in
    "--network=${bridge}-net${suffix}";
}
