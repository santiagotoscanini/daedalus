# platform/sensors.nix — fan tachometers and board voltages.
#
# The MSI PRO B760M-P DDR4 carries a Nuvoton NCT6687D super-I/O, and nothing
# in the mainline tree binds to it here: without this module the box has three
# hwmon chips (the NVMe, the ACPI thermal zone and coretemp) and not one of
# them counts revolutions. Every case and CPU fan in the machine spins
# unobserved, which on a NAS that lives in a cupboard is the one class of
# failure that is silent until it is thermal.
#
# `nct6687d` rather than the in-tree `nct6683`: mainline refuses this chip
# unless loaded with `force=1`, and forcing it on MSI boards — whose EC runs
# customised firmware with a different register layout — reports plausible
# numbers that are wrong, which is worse than reporting none. This is the
# out-of-tree driver written for that layout.
#
# It is an out-of-tree module, so it is rebuilt against every kernel this
# flake moves to. If a `nix flake update` ever fails to build it, the honest
# fix is to drop this file rather than pin the kernel: fan RPM is a nice
# reading, and the temperatures that actually gate the hardware come from
# coretemp and SMART, which are both in-tree.
{ config, ... }:

{
  boot.extraModulePackages = [ config.boot.kernelPackages.nct6687d ];
  boot.kernelModules = [ "nct6687" ];
}
