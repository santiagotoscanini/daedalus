# REPLACE THIS FILE with the output of `nixos-generate-config` on the machine.
# What is here is the least a NixOS evaluation needs — a root filesystem and a
# boot loader — so the template evaluates as written (the engine's CI does
# exactly that). The engine enables ZFS, hence the hostId: eight hex digits,
# unique per machine (`head -c4 /dev/urandom | od -A none -t x4`).
{
  fileSystems."/" = {
    device = "tank/root";
    fsType = "zfs";
  };
  boot.loader.systemd-boot.enable = true;
  networking.hostId = "8425e349";
}
