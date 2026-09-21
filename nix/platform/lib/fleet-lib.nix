# platform/fleet-lib — pure helpers shared across the platform layer,
# as a by-path library (`*-lib.nix` files are never listed in
# configuration.nix's imports; consumers import this by path). Owner of the
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

  # The version a digest-pinned image string carries, or "" when the tag
  # does not read as one: `docker.io/n8nio/n8n:2.33.2@sha256:d31c…` →
  # `2.33.2`, `…/mcp-grocy:v2.7.0@sha256:…` → `2.7.0`, and a plain
  # `:latest@sha256:…` → "". Stacks use it to contribute their own pinned
  # version to `fleet.dashboard` (platform/export.nix) rather than restate
  # the number beside the pin, where a second copy goes stale on the next
  # bump. Empty rather than absent so a consumer renders "unknown" instead
  # of a wrong number.
  versionOfImage =
    image:
    let
      m = builtins.match ".*:v?([0-9][^@:]*)@sha256:.*" image;
    in
    if m == null then "" else builtins.head m;
}
