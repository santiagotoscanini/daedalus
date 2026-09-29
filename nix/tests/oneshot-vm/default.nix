# A VM test of the container unit shape (fleet-lib's containerServiceConfig)
# under the host's own nixpkgs: rootless podman as a lingering user, one
# oci-container per variant, and a oneshot ordered After= each.
#
#   engine  — containerServiceConfig as podman.nix applies it: the unit must
#             reach `active` and its dependant must start.
#   before  — the override as it was before 26.05 (Type forced, Delegate and
#             NotifyAccess left to upstream): the test asserts it HANGS —
#             `activating`, conmon adopted as the main PID, the dependant
#             still waiting. If a nixpkgs bump makes it stop hanging, this
#             assertion says so and the comment in fleet-lib can be revisited.
#
# Not a flake check (the operator's rule: no VM builds in CI). Run it by hand
# after a nixpkgs bump: `nix build .#vmtest-oneshot -L`.
{ pkgs }:
let
  inherit (pkgs) lib;
  inherit (import ../../platform/lib/fleet-lib.nix { inherit lib; }) containerServiceConfig;
  image = pkgs.dockerTools.buildImage {
    name = "sleeper";
    tag = "latest";
    copyToRoot = [ pkgs.busybox ];
    config.Cmd = [
      "sleep"
      "infinity"
    ];
  };
  variants = {
    engine = containerServiceConfig;
    before = {
      Type = lib.mkForce "oneshot";
      RemainAfterExit = true;
      Restart = lib.mkForce "on-failure";
      RestartSec = "15s";
    };
  };
in
pkgs.testers.runNixOSTest {
  name = "oneshot-container-units";
  nodes.machine = {
    virtualisation.memorySize = 2048;
    virtualisation.podman.enable = true;
    users.users.alice = {
      isNormalUser = true;
      uid = 1000;
      linger = true;
      autoSubUidGidRange = true;
    };
    virtualisation.oci-containers = {
      backend = "podman";
      containers = lib.mapAttrs (_: _: {
        image = "sleeper:latest";
        imageFile = image;
        podman.user = "alice";
      }) variants;
    };
    systemd.services = lib.mkMerge [
      (lib.mapAttrs' (
        n: serviceConfig:
        lib.nameValuePair "podman-${n}" {
          inherit serviceConfig;
          after = [ "user@1000.service" ];
          wants = [ "user@1000.service" ];
        }
      ) variants)
      (lib.mapAttrs' (
        n: _:
        lib.nameValuePair "after-${n}" {
          wantedBy = [ "multi-user.target" ];
          after = [ "podman-${n}.service" ];
          wants = [ "podman-${n}.service" ];
          serviceConfig = {
            Type = "oneshot";
            RemainAfterExit = true;
            ExecStart = "${pkgs.coreutils}/bin/true";
          };
        }
      ) variants)
    ];
  };
  testScript = ''
    import time

    def show(unit):
        out = machine.succeed(f"systemctl show {unit} -p ActiveState,MainPID,Delegate,NotifyAccess")
        print(unit, out.replace("\n", " "))
        return dict(l.split("=", 1) for l in out.splitlines())

    machine.wait_for_unit("user@1000.service")
    machine.wait_for_unit("podman-engine.service", timeout=240)
    machine.wait_for_unit("after-engine.service", timeout=60)
    s = show("podman-engine")
    assert s["MainPID"] == "0", s
    machine.succeed("su - alice -c 'podman ps --filter name=^engine$ -q' | grep -q .")

    machine.wait_until_succeeds("su - alice -c 'podman ps --filter name=^before$ -q' | grep -q .", timeout=240)
    time.sleep(30)
    s = show("podman-before")
    assert s["ActiveState"] == "activating", s
    comm = machine.succeed(f"cat /proc/{s['MainPID']}/comm").strip()
    assert comm == "conmon", comm
    assert show("after-before")["ActiveState"] == "inactive"
    print(machine.succeed("systemctl list-jobs --no-legend --plain"))
    print(machine.succeed("for p in $(pgrep -x conmon); do cut -d: -f3 /proc/$p/cgroup; done"))
  '';
}
