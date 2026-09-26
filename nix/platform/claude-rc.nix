# Claude Code Remote Control server — always-on remote sessions in the
# configuration checkout (`fleet.config.repo`).
#
# Runs `claude remote-control` as a persistent systemd service so the operator
# can connect from claude.ai/code or the Claude mobile app at any time and get
# a session on this box (same-dir spawn, one session pre-created in the
# checkout, default capacity 32). The CLI has no daemon mode; this unit IS the
# daemon.
#
# What it leans on:
#   - `claude` is pkgs.claude-code (the unstable overlay in
#     platform/claude-code) — the store binary can't self-update; a flake bump
#     moves it, which changes ExecStart. **Updates land on reboot or a manual
#     restart, never on switch**: `restartIfChanged = false`, for the same
#     reason the daedalus host agents carry it (stacks/daedalus). Without it, the
#     first rebuild run FROM a remote session after a claude-code bump is a
#     murder-suicide: the session's `sudo nixos-rebuild` lives inside this
#     unit's cgroup (sudo doesn't migrate cgroups), activation stops the unit
#     to restart it, the SIGTERM kills the in-flight activation itself, and
#     the unit is left STOPPED — every remote session hangs and the box sits
#     half-activated until someone reboots (2026-08-26, recovered via
#     daedalus's restart button). The weekly autoupgrade already stages with
#     `nixos-rebuild boot`, so reboot-gated updates were the design anyway.
#     SuccessExitStatus=143 keeps SIGTERM stops from firing the OnFailure
#     email.
#   - The ExecStartPre gcroot pins the RUNNING version against the host's
#     nix-gc: after later switches move
#     current-system past it, an unrestarted server could outlive every
#     generation referencing its binary — new sessions would then spawn from
#     a deleted store path. The root tracks whatever version each start uses.
#   - Credentials: ~operator/.claude/.credentials.json (subscription login).
#     Expiry runbook: SSH in, run `claude` in the checkout, `/login`, then
#     `systemctl restart claude-remote-control`. Workspace trust for the
#     checkout is a one-time acceptance, persisted.
#   - Permission mode: default — the checkout's own `.claude/settings.json`
#     (and any hooks it wires) apply; approvals render in the claude.ai/code UI.
#
# A server stop ENDS every session under it, and claude.ai cannot pick one
# back up: the server bridges NEW sessions, it does not re-adopt old ones.
# What survives is the transcript, here on this box, and `claude --resume
# <uuid>` is the way back in — which is the whole reason the `claude-session@`
# bridge exists (stacks/daedalus, claudeSessionRunner), and why daedalus's
# Claude page offers Resume per row. Sessions are NOT resumable from
# claude.ai after a stop — don't plan a feature around that.
#
# With restartIfChanged=false a rebuild never touches the running server;
# the one way to kill it from inside a remote session is an explicit
# `systemctl restart claude-remote-control` — which also kills the session
# that typed it.
#
# Status: no health endpoint exists. `systemctl status claude-remote-control`,
# `journalctl -fu claude-remote-control` (--verbose logs connection/session
# events); failures reach mail via monitoredJobs and the global
# systemd_failed_units Grafana alert. Do NOT set DISABLE_TELEMETRY /
# DO_NOT_TRACK / CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC / DISABLE_GROWTHBOOK
# or ANTHROPIC_BASE_URL anywhere claude reads env — each silently disables
# Remote Control.
{
  config,
  lib,
  pkgs,
  ...
}:
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

  # `--verbose` prints each session's transcript messages to stdout as one
  # JSON object per line, and the journal ships them to Loki like any unit's
  # output. The ones carrying `tool_result` hold what a tool RETURNED: file
  # contents, command output, including whatever secret a session just read.
  # ~1,600 such lines a day. Dropped; the stream's other lines (connection
  # events, session status, the assistant's own messages) still arrive. The
  # full transcripts live in the operator's ~/.claude/projects on their own,
  # so Loki loses nothing it should keep.
  fleet.logDrops.claude-rc-tool-output = {
    selector = "{unit=\"claude-remote-control.service\"}";
    expression = "tool_result";
    reason = "claude_rc_tool_output";
  };

  systemd.services.claude-remote-control = {
    description = "Claude Code Remote Control server (claude.ai/code + mobile)";
    wantedBy = [ "multi-user.target" ];
    # DNS resolves through the local pi-hole; network-online alone is link-up.
    after = [
      "network-online.target"
      "pihole-ready.service"
      config.fleet.operator.userService
    ];
    wants = [
      "network-online.target"
      "pihole-ready.service"
    ];
    path = [ "/run/wrappers" ]; # sudo, for sessions that rebuild
    serviceConfig = {
      Type = "simple";
      User = config.fleet.operator.user;
      Group = config.fleet.operator.group;
      WorkingDirectory = config.fleet.config.repo;
      Environment = [
        "HOME=${config.fleet.operator.home}"
        "XDG_RUNTIME_DIR=${config.fleet.operator.runtimeDir}"
      ];
      # "+": root, to write the gcroot; the service itself stays the operator's.
      ExecStartPre = "+${pkgs.coreutils}/bin/ln -sfn ${rcJournal} /nix/var/nix/gcroots/claude-remote-control";
      ExecStart = lib.getExe rcJournal;
      Restart = "always";
      RestartSec = "5s";
      SuccessExitStatus = [ 143 ];
    };
    # See the header: a switch must never restart this unit — it kills every
    # remote session AND (when the rebuild runs inside one) the activation
    # that ordered the restart. Updates ride the next reboot/manual restart.
    restartIfChanged = false;
    unitConfig = {
      StartLimitBurst = 20;
      StartLimitIntervalSec = 600;
    };
  };
}
