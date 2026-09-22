# claude_ro — a read-only login role on the shared pg cluster, for the
# operator's MCP client.
#
# The platform materializes the operator's Claude Code MCP configuration
# from a host-handed ciphertext (`fleet.claude.mcpSopsFile`,
# platform/claude.nix). When that configuration declares an `app-db-ro`
# server, this oneshot converges the role it dials: a Claude session then
# reads app databases in a structured way, and pinning that connection to a
# role that CANNOT write moves the read-only guarantee from prompt
# discipline into the database.
#
# Single source of truth for the password: the decrypted MCP configuration
# itself. This unit greps the DATABASE_URI out of it (the same
# grep-the-owning-secret idiom the control plane uses for the identity
# provider's API key) and converges the role — so nothing in the secret
# tree exists twice.
#
# Grants: pg_read_all_data (SELECT on everything, present and future) +
# CONNECT on every existing database (the per-app DBs REVOKE PUBLIC's
# CONNECT, so membership must be granted explicitly). A database created
# AFTER the last run isn't connectable until this unit re-runs (every
# boot and every rebuild that changes it) — restart app-db-claude-ro by
# hand if a brand-new app DB needs reading today.
#
# Rotation: change the password inside the host's encrypted MCP file
# (`sops <file>`, mind --input-type binary), rebuild, then
# `systemctl restart app-db-claude-ro` — the unit text doesn't change on
# ciphertext-only edits, the usual rotation gotcha.
#
# Absent — no unit at all — on a host that hands the platform no MCP file:
# there is no client to converge a role for.

{
  config,
  lib,
  pkgs,
  ...
}:

{
  config = lib.mkIf (config.fleet.modules.app-db.enable && config.fleet.claude.mcpSopsFile != null) {
    systemd.services.app-db-claude-ro = {
      description = "Converge the read-only claude_ro role on the shared pg cluster";
      after = [ "podman-pg.service" ];
      wants = [ "podman-pg.service" ];
      wantedBy = [ "multi-user.target" ];
      path = [
        pkgs.podman
        pkgs.jq
        pkgs.gnused
        pkgs.gnugrep
        pkgs.coreutils
      ];
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        User = config.fleet.operator.user;
        Environment = "XDG_RUNTIME_DIR=${config.fleet.operator.runtimeDir}";
        Restart = "on-failure";
        RestartSec = "5s";
      };
      script = ''
        set -eu
        SECRET=/run/secrets/claude-mcp-json
        if [ ! -r "$SECRET" ]; then
          echo "claude-ro: $SECRET missing/unreadable — skipping" >&2
          exit 0
        fi
        URI=$(jq -r '.mcpServers["app-db-ro"].env.DATABASE_URI // empty' "$SECRET")
        if [ -z "$URI" ]; then
          echo "claude-ro: no app-db-ro server declared — skipping" >&2
          exit 0
        fi
        PASS=$(printf '%s' "$URI" | sed -E 's|^postgresql://[^:]+:([^@]+)@.*$|\1|')
        # The password is machine-generated hex; refuse anything else
        # rather than risk quoting it into SQL.
        if ! printf '%s' "$PASS" | grep -qE '^[A-Za-z0-9]+$'; then
          echo "claude-ro: password has unexpected characters — refusing" >&2
          exit 1
        fi

        psql_pg() { podman exec pg psql -U postgres -tA -c "$1"; }

        if [ "$(psql_pg "SELECT 1 FROM pg_roles WHERE rolname='claude_ro'")" != 1 ]; then
          psql_pg "CREATE ROLE claude_ro LOGIN"
        fi
        psql_pg "ALTER ROLE claude_ro LOGIN PASSWORD '$PASS' NOSUPERUSER NOCREATEDB NOCREATEROLE"
        psql_pg "GRANT pg_read_all_data TO claude_ro"

        # CONNECT on every current database (PUBLIC's CONNECT is revoked
        # on the per-app DBs).
        for db in $(psql_pg "SELECT datname FROM pg_database WHERE NOT datistemplate"); do
          psql_pg "GRANT CONNECT ON DATABASE \"$db\" TO claude_ro"
        done
        echo "claude-ro: converged"
      '';
    };

    # A silent failure here means the MCP server dials a role that doesn't
    # exist (or has a stale password) and every DB read tool errors out.
    fleet.monitoredJobs.app-db-claude-ro = { };
  };
}
