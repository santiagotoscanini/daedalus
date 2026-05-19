# intel-gpu-exporter — Prometheus exporter for the Alder Lake iGPU.
#
# Wraps `intel_gpu_top` (i915 PMU sampling) and exposes `gpumon_*`
# metrics on :9100 inside the monitoring-net bridge. Prometheus scrapes
# it as `intel-gpu-exporter:9100` — same pattern as cadvisor.
#
# Why it exists: Immich and Jellyfin both rely on QSV transcoding via
# /dev/dri/renderD128. Without a metric, "is the iGPU actually being
# used?" is something you can only answer by running
# `sudo intel_gpu_top` interactively. This makes it persistent and
# alertable.
#
# Three host-level requirements, declared HERE (not in configuration.nix)
# so removing this module cleanly removes the host changes too:
#
#   - `kernel.perf_event_paranoid = 0`. Necessary but not sufficient
#     for intel_gpu_top PMU access. Negligible risk on a single-user
#     box. Using `lib.mkDefault` so any future configuration.nix
#     setting wins.
#
#   - /dev/dri bind-mounted. The exporter passes `drm:/dev/dri/card0`
#     to intel_gpu_top; the full dir is mounted to cover renderD128.
#
#   - `--privileged`. The i915 PMU privilege check happens against
#     the host's init user namespace; rootless containers can't pass
#     it via `--cap-add` because their caps are namespace-scoped.
#     In rootless mode, `--privileged` does NOT grant host root —
#     the container still runs as santiago (UID 1000); it just
#     unmasks /proc/sys/dev paths and grants the full bounding set
#     within santiago's user namespace. Same trick cadvisor uses.

{ lib, mkRootlessContainer, ... }:

{
  myStack.containerNetworks.intel-gpu-exporter = "monitoring";

  boot.kernel.sysctl."kernel.perf_event_paranoid" = lib.mkDefault 0;

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
