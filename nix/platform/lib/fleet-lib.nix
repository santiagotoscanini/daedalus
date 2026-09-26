# platform/lib/fleet-lib — pure helpers shared across the platform layer,
# as a by-path library (`*-lib.nix` files are never listed in a module
# import list; consumers import this by path). Owner of the
# bridge-membership spec syntax, consumed by podman.nix (flag
# injection) and publishing.nix (isolation assertions), and of the
# image-pin parse (podman.nix, export.nix).

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

  # A `repo:tag@sha256:…` image pin as its parts, or null for any other
  # shape. The one parse every reader of a pin shares — the container pins
  # (platform/export.nix `fleet.imagePins`), the hand-moved ones
  # (`fleet.manualPins`) and mkLocalImage's default tag — so the freshness
  # probe, the dashboard and the update agent cannot disagree about what a
  # pin is. `image` is the tag ref without the digest: what a registry is
  # asked about.
  parsePin =
    ref:
    let
      m = builtins.match "(.*):([^@:]+)@(sha256:[0-9a-f]+)" ref;
    in
    if m == null then
      null
    else
      {
        image = "${builtins.elemAt m 0}:${builtins.elemAt m 1}";
        repo = builtins.elemAt m 0;
        tag = builtins.elemAt m 1;
        digest = builtins.elemAt m 2;
      };
}
