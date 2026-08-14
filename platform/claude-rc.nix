# Claude Code Remote Control server — always-on remote sessions in /etc/nixos.
#
# Runs `claude remote-control` as a persistent systemd service so the operator
# can connect from claude.ai/code or the Claude mobile app at any time and get
# a session on this box (same-dir spawn, one session pre-created in /etc/nixos,
# default capacity 32). The CLI has no daemon mode; this unit IS the daemon.
#
# What it leans on, all pre-existing:
#   - `claude` is pkgs.claude-code (unstable overlay in configuration.nix) —
#     the store binary can't self-update; the weekly flake-autoupgrade bumps it,
#     which changes ExecStart and restarts this unit on switch. That is the
#     update path. SuccessExitStatus=143 keeps those SIGTERM restarts from
#     firing the OnFailure email.
#   - Credentials: ~santiago/.claude/.credentials.json (subscription login).
#     Expiry runbook: SSH in, run `claude` in /etc/nixos, `/login`, then
#     `systemctl restart claude-remote-control`. Workspace trust for /etc/nixos
#     is already accepted (one-time, persisted).
#   - Permission mode: default — the deny/ask/allow matrix and bash-guard.sh
#     apply; approvals render in the claude.ai/code UI.
#
# Sessions survive a server stop and stay resumable for ~4 hours (claude.ai
# session list, or --session-id). Corollary: a remote session that itself runs
# `sudo nixos-rebuild switch` touching this unit kills its own server —
# reconnect and resume from claude.ai/code.
#
# Status: no health endpoint exists. `systemctl status claude-remote-control`,
# `journalctl -fu claude-remote-control` (--verbose logs connection/session
# events); failures reach mail via monitoredJobs and the global
# systemd_failed_units Grafana alert. Do NOT set DISABLE_TELEMETRY /
# DO_NOT_TRACK / CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC / DISABLE_GROWTHBOOK
# or ANTHROPIC_BASE_URL anywhere claude reads env — each silently disables
# Remote Control.
{ lib, pkgs, ... }:
let
  # The CLI renders a TUI status box that repaints ~1/s even when idle —
  # ~400k journal lines/day measured. Strip ANSI, drop the box frames
  # (spinner line, indented session rows, banner), keep the timestamped
  # events, the once-per-start summary, and anything unexpected (errors,
  # stack traces). `|| true`: grep exiting 1 (everything filtered) must not
  # look like a crash — restart storms still surface via the start limit.
  rcJournal = pkgs.writeShellApplication {
    name = "claude-rc-journal";
    runtimeInputs = [
      pkgs.claude-code
      pkgs.gnused
      pkgs.gnugrep
    ];
    text = ''
      claude remote-control --verbose 2>&1 \
        | sed -u -E 's/\x1b\[[0-9;]*[A-Za-z]//g; s/\x1b\]8;;[^\x07]*\x07//g' \
        | { grep --line-buffered -Ev '^·|^[[:space:]]|^$|Continue coding in the Claude|space to show QR code' || true; }
    '';
  };
in
{
  fleet.monitoredJobs.claude-remote-control = { };

  systemd.services.claude-remote-control = {
    description = "Claude Code Remote Control server (claude.ai/code + mobile)";
    wantedBy = [ "multi-user.target" ];
    # DNS resolves through the local pi-hole; network-online alone is link-up.
    after = [
      "network-online.target"
      "pihole-ready.service"
      "user@1000.service"
    ];
    wants = [
      "network-online.target"
      "pihole-ready.service"
    ];
    path = [ "/run/wrappers" ]; # sudo, for sessions that rebuild
    serviceConfig = {
      Type = "simple";
      User = "santiago";
      Group = "users";
      WorkingDirectory = "/etc/nixos";
      Environment = [
        "HOME=/home/santiago"
        "XDG_RUNTIME_DIR=/run/user/1000"
      ];
      ExecStart = lib.getExe rcJournal;
      Restart = "always";
      RestartSec = "5s";
      SuccessExitStatus = [ 143 ];
    };
    unitConfig = {
      StartLimitBurst = 20;
      StartLimitIntervalSec = 600;
    };
  };
}
