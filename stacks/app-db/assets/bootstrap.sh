# Per-app database bootstrap — concatenated into a systemd
# unit script by stacks/app-db/app-db.nix.
#
# Expects env vars (exported by the wrapper):
#   APP_NAME       — postgres role + database name
#   EXTRA_DBS      — space-separated additional databases owned by the
#                    same role (may be empty; e.g. sonarr_log)
#   ENV_BASE       — /etc/nixos/stacks/app-db/secrets
#   CLUSTER_ENV    — $ENV_BASE/cluster/env  (POSTGRES_PASSWORD line)
#   APP_ENV_FILE   — $ENV_BASE/$APP_NAME/env (per-app env we emit)
#
# `set -eu` is already on (set by the wrapper). state-paths.service also
# declares the APP_ENV_FILE directory, but there is no ordering edge
# between the oneshots — create it here so a fresh restore can't race.
# This unit runs as santiago, so the dir lands santiago-owned.

install -d -m 0700 "$(dirname "$APP_ENV_FILE")"

# No pg wait loop here: this unit orders after podman-pg.service,
# whose ExecStartPost gate holds until pg_isready answers — by the
# time we run, the server accepts connections.

# Read or generate the per-app password. The guards catch a
# corrupt/truncated env file — without them an empty password would
# reach ALTER ROLE and silently lock the app out.
if [ -e "$APP_ENV_FILE" ]; then
  APP_PWD=$(grep '^POSTGRES_PASSWORD=' "$APP_ENV_FILE" | head -1 | cut -d= -f2-)
  [ -n "$APP_PWD" ] || { echo "empty POSTGRES_PASSWORD in $APP_ENV_FILE" >&2; exit 1; }
else
  APP_PWD=$(openssl rand -hex 32)
fi

# Read the cluster superuser password.
SUPER_PWD=$(grep '^POSTGRES_PASSWORD=' "$CLUSTER_ENV" | head -1 | cut -d= -f2-)
[ -n "$SUPER_PWD" ] || { echo "empty POSTGRES_PASSWORD in $CLUSTER_ENV" >&2; exit 1; }

# Idempotent role + db materialization. -i pipes stdin to psql.
# BOTH passwords ride value-less `-e` passthroughs so neither secret
# ever sits in podman argv (/proc/<pid>/cmdline); \getenv binds the
# psql variable, substituted as :'qpwd' (SQL-escaped string literal)
# below.
#
# Note: psql client-side substitution (:'qpwd') does NOT work inside
# a DO $$ ... $$ block — the block body is sent verbatim to the
# server. So we use `\gexec` for the role check too: compute the SQL
# client-side, then execute the resulting row.
#
# Heredoc is unquoted (<<SQL not <<'SQL') so ${APP_NAME} expands; psql's
# :'qpwd' has no $ so bash leaves it alone.
PGPASSWORD="$SUPER_PWD" APP_PWD="$APP_PWD" podman exec -i -e PGPASSWORD -e APP_PWD pg \
  psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres <<SQL
\getenv qpwd APP_PWD
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', '${APP_NAME}', :'qpwd')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_NAME}')
\gexec
ALTER ROLE ${APP_NAME} PASSWORD :'qpwd';
SELECT format('CREATE DATABASE %I OWNER %I', '${APP_NAME}', '${APP_NAME}')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = '${APP_NAME}')
\gexec
REVOKE ALL ON DATABASE ${APP_NAME} FROM PUBLIC;
GRANT  ALL ON DATABASE ${APP_NAME} TO ${APP_NAME};
SQL

# Additional databases owned by the same role (may be empty).
for db in $EXTRA_DBS; do
  PGPASSWORD="$SUPER_PWD" podman exec -i -e PGPASSWORD pg \
    psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres <<SQL
SELECT format('CREATE DATABASE %I OWNER %I', '${db}', '${APP_NAME}')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = '${db}')
\gexec
REVOKE ALL ON DATABASE ${db} FROM PUBLIC;
GRANT  ALL ON DATABASE ${db} TO ${APP_NAME};
SQL
done

# Write env file last so a partial bootstrap doesn't leave a stale
# env file pointing at a non-existent role. The password (and the
# connection URL) are emitted under every name our images read —
# n8n: DB_POSTGRESDB_PASSWORD, seerr: DB_PASS, grafana:
# GF_DATABASE_PASSWORD, healthchecks: DB_PASSWORD, bazarr:
# POSTGRES_PASSWORD, pocket-id: DB_CONNECTION_STRING — one uniform
# file shape for every tenant.
install -m 0600 -o santiago -g users /dev/stdin "$APP_ENV_FILE" <<EOF
POSTGRES_USER=${APP_NAME}
POSTGRES_DB=${APP_NAME}
POSTGRES_PASSWORD=$APP_PWD
DB_POSTGRESDB_PASSWORD=$APP_PWD
DB_PASS=$APP_PWD
DB_PASSWORD=$APP_PWD
GF_DATABASE_PASSWORD=$APP_PWD
DATABASE_URL=postgresql://${APP_NAME}:$APP_PWD@pg:5432/${APP_NAME}
DB_CONNECTION_STRING=postgresql://${APP_NAME}:$APP_PWD@pg:5432/${APP_NAME}
EOF
