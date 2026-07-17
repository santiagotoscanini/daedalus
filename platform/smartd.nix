# platform/smartd.nix — SMART disk-health polling + failure email.
# Every result lands in journald; mail (via platform/mail's msmtp
# relay) fires only on a disk reporting pre-failure/failure.

{ config, ... }:

{
  services.smartd = {
    enable = true;
    autodetect = true; # every disk, no per-drive config
    # Short test Sat 02:00, long test 1st-of-month 03:00.
    defaults.autodetected = "-a -s (S/../../6/02|L/../01/./03)";
    notifications.mail = {
      enable = true;
      inherit (config.myStack.mail) sender;
      recipient = config.myStack.mail.alertTo;
      mailer = "/run/wrappers/bin/sendmail";
    };
  };
}
