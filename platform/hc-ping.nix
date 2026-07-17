# platform/hc-ping — report scheduled-job start/success/fail to the local
# healthchecks instance (stacks/healthchecks). Complements OnFailure email:
# email fires when a job RUNS and fails; healthchecks also catches a job that
# stops running entirely — its check goes red when no ping arrives within the
# expected window.
#
# Units self-register via `myStack.hcPings` (unit -> slug) from the
# module that owns them. Pings are best-effort: the
# curl runs with the systemd "-+" prefix (root + no sandbox, matching the
# unit's existing zfs-allow hooks) so it can read the 0400 ping-key secret
# and reach the network even from the sandboxed syncoid user, and it always
# exits 0 so a healthchecks outage never fails the underlying job. Checks
# self-provision on first ping (?create=1); set each check's period + grace
# in the healthchecks UI.

{
  config,
  lib,
  pkgs,
  ...
}:

let
  baseUrl = "https://hc.toscanini.me/ping";
  keyPath = config.sops.secrets."hc-ping-key".path;

  # hc-ping <slug> [start|fail]. Always exits 0.
  hcPing = pkgs.writeShellScript "hc-ping" ''
    set -u
    slug="$1"
    suffix="''${2:-}"
    key="$(${pkgs.coreutils}/bin/cat ${keyPath} 2>/dev/null)" || exit 0
    [ -n "$key" ] || exit 0
    url="${baseUrl}/$key/$slug''${suffix:+/$suffix}?create=1"
    ${pkgs.curl}/bin/curl -fsS -m 10 --retry 2 -o /dev/null "$url" || true
    exit 0
  '';

  # ExecStopPost: map systemd $SERVICE_RESULT to a success/fail ping.
  hcPingResult = pkgs.writeShellScript "hc-ping-result" ''
    set -u
    if [ "''${SERVICE_RESULT:-}" = "success" ]; then
      ${hcPing} "$1"
    else
      ${hcPing} "$1" fail
    fi
    exit 0
  '';
in
{
  options.myStack.hcPings = lib.mkOption {
    type = lib.types.attrsOf lib.types.str;
    default = { };
    description = ''
      systemd unit name -> healthchecks slug. Each entry appends
      best-effort start/result pings to that unit. Modules register
      their own scheduled units; set the check's period + grace in
      the healthchecks UI (checks self-provision on first ping).
    '';
    example = {
      "flake-autoupgrade" = "flake-autoupgrade";
    };
  };

  config = {
    sops.secrets."hc-ping-key" = {
      sopsFile = ./hc-ping/ping-key.sops;
      format = "binary";
      key = "";
      # Root-only: the "-+" prefixed pings run as root. Low-sensitivity token.
      mode = "0400";
    };

    # Append start/result pings to each registered unit. mkAfter keeps them
    # after the units' own Exec hooks (e.g. syncoid's zfs-allow / zfs-unallow).
    systemd.services = lib.mapAttrs (_unit: slug: {
      serviceConfig = {
        ExecStartPre = lib.mkAfter [ "-+${hcPing} ${slug} start" ];
        ExecStopPost = lib.mkAfter [ "-+${hcPingResult} ${slug}" ];
      };
    }) config.myStack.hcPings;
  };
}
