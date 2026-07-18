# platform/mail — outbound email relay + OS-level alert wiring.
#
# msmtp is the system `sendmail`, relaying through Gmail
# (smtp.gmail.com:587, STARTTLS) as s2.toscanini.me@gmail.com. The app
# password is the single sops secret platform/mail/smtp-app-password.sops, read by
# root (msmtp, invoked by smartd/ZED/systemd) and — bind-mounted — by the
# grafana container (which runs --user=0:0 → santiago). n8n can't read a
# santiago-owned bind mount (it runs as an unprivileged mapped uid), so it
# gets the value via a rendered --env-file (see stacks/n8n). owner=santiago
# 0400 satisfies msmtp (root ignores the mode) and grafana.
#
# What emails you, and why:
#   - smartd            → a failing / pre-failing disk
#   - ZFS ZED           → pool DEGRADED / FAULTED / scrub-with-errors
#   - systemd OnFailure → flake-autoupgrade + the two syncoid backups
#
# Grafana + n8n send their OWN mail (configured in their stack modules
# against the same Gmail account + password secret), not via this sendmail.
#
# Known limitation: the box resolves DNS through the local pi-hole, so if
# pi-hole is down msmtp can't resolve smtp.gmail.com and mail won't send —
# a pi-hole-down alert therefore can't email out (accepted single-node SPOF).

{
  config,
  pkgs,
  lib,
  ...
}:

let
  inherit (config.fleet.mail) sender alertTo;
  pwPath = config.sops.secrets."mail-relay-password".path;

  # Recipients/From come from the message headers (-t).
  msmtpSend = "${pkgs.msmtp}/bin/msmtp --account=default -t";

  notifyEmail = pkgs.writeShellScript "notify-email" ''
    set -eu
    unit="$1"
    {
      echo "From: ${sender}"
      echo "To: ${alertTo}"
      echo "Subject: [s2-server] FAILED: $unit"
      echo
      echo "Unit $unit entered a failed state on s2-server at $(${pkgs.coreutils}/bin/date)."
      echo
      ${pkgs.systemd}/bin/systemctl status --full --no-pager "$unit" 2>&1 | head -n 40 || true
      echo
      echo "--- recent journal ---"
      ${pkgs.systemd}/bin/journalctl -u "$unit" --no-pager -n 40 2>&1 || true
    } | ${msmtpSend}
  '';
in
{
  # Declared here (not in platform/podman.nix) per the owning-module convention:
  # every mail-sending consumer reads these; this module owns the relay.
  options.fleet.mail = {
    sender = lib.mkOption {
      type = lib.types.str;
      description = "From address every mail-sending service uses (the relay account).";
    };
    alertTo = lib.mkOption {
      type = lib.types.str;
      description = "Recipient for all alert/notification mail.";
    };
    smtpHost = lib.mkOption {
      type = lib.types.str;
      description = "SMTP relay host shared by all mail-sending services.";
    };
    smtpPort = lib.mkOption {
      type = lib.types.port;
      default = 587;
      description = "SMTP submission port (STARTTLS).";
    };
  };

  options.fleet.emailOnFailure = lib.mkOption {
    type = lib.types.listOf lib.types.str;
    default = [ ];
    example = [ "flake-autoupgrade" ];
    description = ''
      Systemd unit names (no .service suffix) that email on failure via
      notify-email@. Owning modules self-register here, next to their
      fleet.hcPings entry — the two registries pair up per module.
    '';
  };

  config = {
    sops.secrets."mail-relay-password" = {
      sopsFile = ./smtp-app-password.sops;
      format = "binary";
      owner = "santiago";
      mode = "0400";
    };

    programs.msmtp = {
      enable = true;
      setSendmail = true;
      defaults = {
        tls = true;
        tls_starttls = true;
        tls_trust_file = "/etc/ssl/certs/ca-certificates.crt";
        logfile = "/var/log/msmtp.log";
      };
      accounts.default = {
        host = config.fleet.mail.smtpHost;
        port = config.fleet.mail.smtpPort;
        auth = true;
        from = sender;
        user = sender;
        passwordeval = "${pkgs.coreutils}/bin/cat ${pwPath}";
      };
    };

    # smartd → email on a disk that reports pre-failure/failure.
    services.smartd.notifications.mail = {
      enable = true;
      inherit sender;
      recipient = alertTo;
      mailer = "/run/wrappers/bin/sendmail";
    };

    # ZFS ZED → email on pool faults / errors (verbose off = problems only).
    services.zfs.zed.settings = {
      ZED_EMAIL_ADDR = [ alertTo ];
      ZED_EMAIL_PROG = "${pkgs.msmtp}/bin/msmtp";
      ZED_EMAIL_OPTS = "--account=default @ADDRESS@";
      ZED_NOTIFY_VERBOSE = false;
    };

    # Reusable failure-notifier: OnFailure=notify-email@%N.service on a
    # unit emails its status + recent journal. Units opt in via the
    # emailOnFailure option (self-registered by their owning module,
    # next to its hcPings entry) — mail.nix never reaches into units it
    # doesn't own.
    systemd.services = {
      "notify-email@" = {
        description = "Email ${alertTo} when %i fails";
        serviceConfig = {
          Type = "oneshot";
          ExecStart = "${notifyEmail} %i";
        };
      };
    }
    // lib.genAttrs config.fleet.emailOnFailure (_: {
      onFailure = [ "notify-email@%N.service" ];
    });
  };
}
