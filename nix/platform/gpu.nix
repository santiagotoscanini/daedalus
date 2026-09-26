# platform/gpu.nix — Intel Alder Lake iGPU (UHD 770), shared by the
# reference host's jellyfin (QSV transcoding) and immich (OpenVINO ML)
# and the catalog's intel-gpu-exporter — host-level because the render
# node crosses stack boundaries.

{ pkgs, ... }:

{
  # Force i915 on the UHD 770 (PCI ID 4680). Drop if hardware
  # transcoding ever stops being used.
  boot.kernelParams = [ "i915.force_probe=4680" ];

  # OpenGL/Vulkan/VAAPI userspace + intel-media-driver — the runtime
  # libs QSV transcoding needs.
  hardware.graphics = {
    enable = true;
    extraPackages = with pkgs; [ intel-media-driver ];
  };
}
