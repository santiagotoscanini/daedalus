# intel-gpu-exporter — Prometheus exporter for an Intel iGPU.
#
# Wraps `intel_gpu_top` (i915 PMU sampling) → `gpumon_*` metrics on
# :9100 inside monitoring-net. Lets us answer "is the iGPU being used
# by transcoding?" persistently + alertably (otherwise
# only `sudo intel_gpu_top` interactively).
#
# Host-level requirements declared HERE (not configuration.nix)
# so removing this module cleanly removes the host changes too:
#   - kernel.perf_event_paranoid=0: required for intel_gpu_top PMU
#     access. mkDefault so a future configuration.nix setting wins.
#   - --privileged: the i915 PMU privilege check happens in the host's
#     init userns, so rootless can't pass it via --cap-add. In rootless
#     mode --privileged does NOT grant host root — the container still
#     runs as the operator, it just unmasks /proc/sys/dev paths +
#     grants the full bounding set within their userns (also
#     covers /dev/dri access — no explicit bind needed).
#
# For a host with an Intel GPU (Quick Sync transcoding, hardware
# thumbnails); nothing else on the box assumes one.
#
# The host brings:
#   fleet.modules.intel-gpu-exporter.enable  the switch (default off, as every catalog module)
#   fleet.images.intel-gpu-exporter          the digest-pinned image

{
  config,
  lib,
  mkRootlessContainer,
  pinnedImage,
  ...
}:

{
  options.fleet.modules.intel-gpu-exporter.enable = lib.mkOption {
    type = lib.types.bool;
    default = false;
    description = "Prometheus exporter for the Intel iGPU.";
  };

  config = lib.mkIf config.fleet.modules.intel-gpu-exporter.enable {
    fleet.bridgeMemberships.intel-gpu-exporter = [ "monitoring" ];

    boot.kernel.sysctl."kernel.perf_event_paranoid" = lib.mkDefault 0;

    fleet.prometheusScrapes = [
      {
        job_name = "intel-gpu";
        static_configs = [
          {
            targets = [ "intel-gpu-exporter:9100" ];
            labels = {
              node = config.networking.hostName;
            };
          }
        ];
      }
    ];

    fleet.grafanaDashboardsByFolder."System".gpu = builtins.readFile ./assets/dashboard.json;

    virtualisation.oci-containers.containers.intel-gpu-exporter = mkRootlessContainer {
      image = pinnedImage "intel-gpu-exporter" "ghcr.io/clambin/intel-gpu-exporter";

      cmd = [
        "--interval=5s"
        "--device=drm:/dev/dri/card0"
      ];

      extraOptions = [
        # --privileged already exposes host devices (/dev/dri included) —
        # no separate --device needed.
        "--privileged"
        # Host PID namespace: intel_gpu_top resolves per-client process
        # names from /proc, which only works when it sees host pids.
        "--pid=host"
      ];
    };
  };
}
