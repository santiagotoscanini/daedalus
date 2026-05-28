# intel-gpu-exporter — Prometheus exporter for the Alder Lake iGPU.
#
# Wraps `intel_gpu_top` (i915 PMU sampling) → `gpumon_*` metrics on
# :9100 inside monitoring-net. Lets us answer "is the iGPU being used
# by Immich/Jellyfin transcoding?" persistently + alertably (otherwise
# only `sudo intel_gpu_top` interactively).
#
# Three host-level requirements declared HERE (not configuration.nix)
# so removing this module cleanly removes the host changes too:
#   - kernel.perf_event_paranoid=0: required for intel_gpu_top PMU
#     access. mkDefault so a future configuration.nix setting wins.
#   - /dev/dri bind: full dir so renderD128 + card0 are both available.
#   - --privileged: the i915 PMU privilege check happens in the host's
#     init userns, so rootless can't pass it via --cap-add. In rootless
#     mode --privileged does NOT grant host root — the container still
#     runs as santiago (1000), it just unmasks /proc/sys/dev paths +
#     grants the full bounding set within santiago's userns. Same
#     trick cadvisor uses.

{ lib, mkRootlessContainer, ... }:

{
  myStack.containerNetworks.intel-gpu-exporter = "monitoring";

  boot.kernel.sysctl."kernel.perf_event_paranoid" = lib.mkDefault 0;

  myStack.prometheusScrapes = [{
    job_name = "intel-gpu";
    static_configs = [{
      targets = [ "intel-gpu-exporter:9100" ];
      labels = { node = "s2-server"; };
    }];
  }];

  myStack.grafanaDashboards.intel-gpu = builtins.readFile ./assets/dashboard.json;

  virtualisation.oci-containers.containers.intel-gpu-exporter = mkRootlessContainer {
    image = "ghcr.io/clambin/intel-gpu-exporter:0.7.0";

    cmd = [
      "--interval=5s"
      "--device=drm:/dev/dri/card0"
    ];

    extraOptions = [
      "--network=monitoring-net"
      "--device=/dev/dri:/dev/dri"
      "--privileged"
      "--pid=host"
    ];
  };
}
