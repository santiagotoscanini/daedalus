# platform/smartd.nix — SMART disk-health polling. Every result lands
# in journald; the failure EMAIL wiring lives in platform/mail (the
# single owner of "what emails you"), not here.

_:

{
  services.smartd = {
    enable = true;
    autodetect = true; # every disk, no per-drive config
    # Short test Sat 02:00, long test 1st-of-month 03:00.
    defaults.autodetected = "-a -s (S/../../6/02|L/../01/./03)";
  };
}
