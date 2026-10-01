# platform/lib/fleet-lib — pure helpers shared across the platform layer,
# as a by-path library (`*-lib.nix` files are never listed in a module
# import list; consumers import this by path). Owner of the
# bridge-membership spec syntax, consumed by podman.nix (flag
# injection) and isolation.nix (isolation assertions), and of the
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

  # The [Service] half of every oci-container unit the platform generates
  # (podman.nix, mkContainerOverride), and of the VM test that proves it
  # (nix/tests/oneshot-vm). oci-containers ships Type=notify +
  # NotifyAccess=all + Delegate=true (the last new in 26.05) and
  # `--sdnotify=conmon`; our units are oneshot + RemainAfterExit instead
  # (a green unit means `podman run -d` returned, nothing more).
  #
  # Delegate and NotifyAccess must be forced with Type, or the start job
  # never ends: with Delegate=true rootless podman sees it owns the
  # unit's cgroup and stays in it instead of moving into a
  # podman-<pid>.scope of the user manager, so conmon lives in the system
  # unit; its sd_notify MAINPID=<conmon> is then accepted (NotifyAccess=all
  # admits any process of the cgroup), a oneshot's start job waits for its
  # main process to exit, conmon lives as long as the container, and
  # TimeoutStartSec=0 removes the limit. Every unit ordered After= one
  # waits with it: the first 26.05 boot of the reference host sat with
  # every container unit `activating`. Delegate=false restores the layout
  # every release before 26.05 ran (conmon in a user-manager scope);
  # NotifyAccess=none means systemd passes no NOTIFY_SOCKET at all, so
  # podman behaves as `podman run` in a shell and no MAINPID can be
  # adopted wherever conmon ends up. Either one alone ends the hang
  # (measured, nix/tests/oneshot-vm); both, so neither is load-bearing.
  containerServiceConfig = {
    Type = lib.mkForce "oneshot";
    RemainAfterExit = true;
    Delegate = lib.mkForce false;
    NotifyAccess = lib.mkForce "none";
    Restart = lib.mkForce "on-failure";
    RestartSec = "15s";
  };
}
