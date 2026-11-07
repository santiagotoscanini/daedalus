# claude_ro — a read-only login role on the shared pg cluster, for an MCP
# server that reads app databases on the operator's behalf.
#
# A host turns it on with `fleet.modules.app-db.readOnlyRole.enable` and
# runs the server itself (the reference host puts it behind its LLM
# gateway). Pinning that server's connection to a role that CANNOT write
# moves the read-only guarantee from prompt discipline into the database.
#
# The password is machine-generated state: minted by this oneshot the first
# time it runs, into `readOnlyRole.envFile` (`PGUSER` + `PGPASSWORD`, libpq's
# own names), which the consumer composes its connection from. Rotate by
# deleting the file and restarting app-db-claude-ro, then the consumer.
#
# Grants: pg_read_all_data (SELECT on everything, present and future) +
# CONNECT on every existing database (the per-app DBs REVOKE PUBLIC's
# CONNECT, so membership must be granted explicitly). A database created
# AFTER the last run isn't connectable until this unit re-runs (every
# boot and every rebuild that changes it) — restart app-db-claude-ro by
# hand if a brand-new app DB needs reading today.
#
# Except the databases of an app marked `private` (appDatabases.<n>.private):
# there CONNECT is revoked on every run, so a chat archive or a device's keys
# on the cluster stay out of the MCP server's reach however it is asked.
{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.fleet.modules.app-db.readOnlyRole;
  # Every database of an app marked `private` (app-db.nix): the role never
  # connects to them.
  privateDbs = lib.concatLists (
    lib.mapAttrsToList (
      name: db: lib.optionals db.private ([ name ] ++ db.extraDatabases)
    ) config.fleet.appDatabases
  );
  converge = pkgs.writeShellApplication {
    name = "app-db-claude-ro";
    runtimeInputs = [
      pkgs.podman
      pkgs.coreutils
      pkgs.gnugrep
    ];
    text = ''
      ENV_FILE=${lib.escapeShellArg cfg.envFile}
      PRIVATE=${lib.escapeShellArg " ${lib.concatStringsSep " " privateDbs} "}
      ${builtins.readFile ./assets/claude-ro.sh}
    '';
  };
in
{
  options.fleet.modules.app-db.readOnlyRole = {
    enable = lib.mkEnableOption "the read-only `claude_ro` role on the shared cluster, for an MCP server the host runs";
    envFile = lib.mkOption {
      type = lib.types.str;
      readOnly = true;
      default = "${config.fleet.machineState}/app-db/claude_ro/env";
      description = ''
        Read-only: the role's credentials, minted on the box — `PGUSER` and
        `PGPASSWORD`. A consumer reads them from here, ordered after
        `app-db-claude-ro.service`.
      '';
    };
  };

  config = lib.mkIf (config.fleet.modules.app-db.enable && cfg.enable) {
    systemd.services.app-db-claude-ro = {
      description = "Converge the read-only claude_ro role on the shared pg cluster";
      after = [ "podman-pg.service" ];
      wants = [ "podman-pg.service" ];
      wantedBy = [ "multi-user.target" ];
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        User = config.fleet.operator.user;
        Environment = "XDG_RUNTIME_DIR=${config.fleet.operator.runtimeDir}";
        ExecStart = lib.getExe converge;
        Restart = "on-failure";
        RestartSec = "5s";
      };
    };

    # A silent failure here means the MCP server dials a role that doesn't
    # exist (or has a stale password) and every DB read tool errors out.
    fleet.monitoredJobs.app-db-claude-ro = { };
  };
}
