# Claude's output on the box, on its way to Loki: Claude remote control's
# log and every resumed session's, which the controller's transient user
# units write under its data directory (agent/README.md "Claude outside the
# agent"). nix/README.md "The controller" says what the stages drop and why.
# Part of the daedalus stack (daedalus.nix holds the switch); never imports
# its siblings.
{
  config,
  lib,
  pkgs,
  ...
}:

let
  inherit (import ./daedalus-lib.nix { inherit config lib pkgs; })
    controllerLogDir
    claudeUnit
    ;
  logDir = controllerLogDir;

  # What both sources below do on the way to Loki (nix/README.md "The
  # controller" says what each stage drops and why). A file source skips the journal
  # pipeline, so its "credentials in URLs" redaction (modules/logging) is
  # repeated here, verbatim: a session's output can carry an OAuth callback
  # or a manifest code as well as any journal line can.
  claudeStages = ''
    stage.replace {
      expression = "(\\x1b\\[[0-9;?]*[A-Za-z]|\\x1b\\]8;;[^\\x07]*\\x07)"
      replace    = ""
    }

    stage.replace {
      expression = "(?i)(?:[?&#]|\\\\u0026|&amp;|query=\"|%3F|%26)(?:code|state|id_token_hint|id_token|access_token|refresh_token|token|apikey|api_key|client_secret|password|passwd|secret)(?:=|%3D)((?:[^&\"\\s\\\\]|\\\\[^\"u\\s&]|\\\\u(?:[1-9a-f][0-9a-f]{3}|0[1-9a-f][0-9a-f]{2}|00[013-9a-f][0-9a-f]|002[0-57-9a-f]))*)"
      replace    = "REDACTED"
    }

    stage.replace {
      expression = "/app-manifests/([^/?&\"\\s\\\\]+)"
      replace    = "REDACTED"
    }

    stage.drop {
      expression          = "^·|^[[:space:]]|^$|Continue coding in the Claude|space to show QR code"
      drop_counter_reason = "claude_rc_status_box"
    }

    stage.drop {
      expression          = "tool_result"
      drop_counter_reason = "claude_rc_tool_output"
    }
  '';
in
{
  config = lib.mkIf config.fleet.modules.daedalus.enable {
    # Made by the agent too, but the log shipper bind-mounts it, so it must
    # exist before the shipper's container starts.
    fleet.statePaths.${logDir}.mode = "0755";

    # Claude remote control's output, filtered on the way to Loki.
    fleet.logFiles.claude_rc = {
      path = "${logDir}/claude-rc.log";
      mountDir = logDir;
      # `system`: the stack every host unit without a rule of its own gets.
      labels = {
        unit = "${claudeUnit}.service";
        stack = "system";
        host = config.networking.hostName;
        job = claudeUnit;
        service_name = claudeUnit;
      };
      stages = claudeStages;
    };

    # The resumed sessions' output: one
    # source for the family. The pattern ends in `.log`, so a session's
    # rotated `.log.1` is not matched; alloy adds a `filename` label per file.
    fleet.logFiles.claude_session = {
      path = "${logDir}/claude-session-*.log";
      mountDir = logDir;
      labels = {
        unit = "claude-session";
        stack = "system";
        host = config.networking.hostName;
        job = "claude-session";
        service_name = "claude-session";
      };
      stages = claudeStages;
    };
  };
}
