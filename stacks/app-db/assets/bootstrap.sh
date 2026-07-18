# Per-app database bootstrap — concatenated into a systemd
# unit script by stacks/app-db/app-db.nix.
#
# Expects env vars (exported by the wrapper):
#   APP_NAME       — postgres role + database name
#   ENV_BASE       — /etc/nixos/stacks/app-db/secrets
#   CLUSTER_ENV    — $ENV_BASE/cluster/env  (POSTGRES_PASSWORD line)
#   APP_ENV_FILE   — $ENV_BASE/$APP_NAME/env (per-app env we emit)
#
# `set -eu` is already on (set by the wrapper). The target directory
# for APP_ENV_FILE is pre-created by tmpfiles.rules (0700 santiago:users),
# so we can write into it without needing sudo here.

# Wait for postgres to be ready (up to 60s).
for i in $(seq 1 60); do
  if podman exec pg pg_isready -U postgres -d postgres >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

# Read or generate the per-app password.
if [ -e "$APP_ENV_FILE" ]; then
  APP_PWD=$(grep '^POSTGRES_PASSWORD=' "$APP_ENV_FILE" | head -1 | cut -d= -f2-)
else
  APP_PWD=$(openssl rand -hex 32)
fi

# Read the cluster superuser password.
SUPER_PWD=$(grep '^POSTGRES_PASSWORD=' "$CLUSTER_ENV" | head -1 | cut -d= -f2-)

# Idempotent role + db materialization. -i pipes stdin to psql.
# -v qpwd=... binds the psql variable, substituted as :'qpwd'
# (SQL-escaped string literal) below.
#
# Note: psql client-side substitution (:'qpwd') does NOT work inside
# a DO $$ ... $$ block — the block body is sent verbatim to the
# server. So we use `\gexec` for the role check too: compute the SQL
# client-side, then execute the resulting row.
#
# Heredoc is unquoted (<<SQL not <<'SQL') so ${APP_NAME} expands; psql's
# :'qpwd' has no $ so bash leaves it alone.
podman exec -i -e PGPASSWORD="$SUPER_PWD" pg \
  psql -X -v ON_ERROR_STOP=1 -v qpwd="$APP_PWD" -U postgres -d postgres <<SQL
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

# Write env file last so a partial bootstrap doesn't leave a stale
# env file pointing at a non-existent role. DB_POSTGRESDB_PASSWORD
# duplicates the password under the name n8n-style images read —
# always emitted so every tenant gets the same env file shape.
install -m 0600 -o santiago -g users /dev/stdin "$APP_ENV_FILE" <<EOF
POSTGRES_USER=${APP_NAME}
POSTGRES_DB=${APP_NAME}
POSTGRES_PASSWORD=$APP_PWD
DB_POSTGRESDB_PASSWORD=$APP_PWD
DATABASE_URL=postgresql://${APP_NAME}:$APP_PWD@pg:5432/${APP_NAME}
EOF
