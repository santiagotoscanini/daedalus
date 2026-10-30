# Per-app database bootstrap — concatenated into a systemd
# unit script by stacks/app-db/app-db.nix.
#
# Expects env vars (exported by the wrapper):
#   APP_NAME       — postgres role + database name
#   EXTRA_DBS      — space-separated additional databases owned by the
#                    same role (may be empty; e.g. sonarr_log)
#   EXTENSIONS     — space-separated extensions to CREATE in the app db
#                    + extra dbs (may be empty; e.g. vector)
#   COLLATION      — "default", or "C": the databases are created from
#                    template0 with LC_COLLATE/LC_CTYPE C (Synapse)
#   ENV_BASE       — <machineState>/app-db
#   CLUSTER_ENV    — $ENV_BASE/cluster/env  (POSTGRES_PASSWORD line)
#   APP_ENV_FILE   — $ENV_BASE/$APP_NAME/env (per-app env we emit)
#   OPERATOR_USER, OPERATOR_GROUP — owner of the env file we emit
#
# `set -eu` is already on (set by the wrapper). state-paths.service also
# declares the APP_ENV_FILE directory, but there is no ordering edge
# between the oneshots — create it here so a fresh restore can't race.
# This unit runs as the operator, so the dir lands operator-owned.

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

# A database created for COLLATION=C comes from template0 with C collation
# and ctype; the default template is the cluster locale. Quoted for the
# format() string below, hence the doubled quotes.
CREATE_OPTS=
if [ "$COLLATION" = C ]; then
  CREATE_OPTS=" TEMPLATE template0 ENCODING ''UTF8'' LC_COLLATE ''C'' LC_CTYPE ''C''"
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
SELECT format('CREATE DATABASE %I OWNER %I${CREATE_OPTS}', '${APP_NAME}', '${APP_NAME}')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = '${APP_NAME}')
\gexec
REVOKE ALL ON DATABASE ${APP_NAME} FROM PUBLIC;
GRANT  ALL ON DATABASE ${APP_NAME} TO ${APP_NAME};
SQL

# Additional databases owned by the same role (may be empty).
for db in $EXTRA_DBS; do
  PGPASSWORD="$SUPER_PWD" podman exec -i -e PGPASSWORD pg \
    psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres <<SQL
SELECT format('CREATE DATABASE %I OWNER %I${CREATE_OPTS}', '${db}', '${APP_NAME}')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = '${db}')
\gexec
REVOKE ALL ON DATABASE ${db} FROM PUBLIC;
GRANT  ALL ON DATABASE ${db} TO ${APP_NAME};
SQL
done

# CREATE_OPTS only applies to a database this run created; one that existed
# keeps whatever it was made with. Say so rather than hand the app a
# collation it refuses (or, worse, accepts and indexes wrongly).
if [ "$COLLATION" = C ]; then
  for db in "$APP_NAME" $EXTRA_DBS; do
    got=$(PGPASSWORD="$SUPER_PWD" podman exec -i -e PGPASSWORD pg \
      psql -X -tA -v ON_ERROR_STOP=1 -U postgres -d postgres \
      -c "SELECT datcollate || '/' || datctype FROM pg_database WHERE datname = '${db}'")
    [ "$got" = "C/C" ] || {
      echo "database ${db} has collation/ctype ${got}, not C/C: dump it, drop it, and this bootstrap recreates it" >&2
      exit 1
    }
  done
fi

# Extensions requested for this app (may be empty). Created as the
# cluster superuser in the app db + every extra db. The extension's
# .so must be present in the pg image — the cluster image ships
# pgvector (`vector`). Names are eval-validated to a safe identifier
# shape, but quote defensively. Idempotent. The UPDATE moves an existing
# extension to the version the image's .so ships, so a pgvector bump in
# the image reaches every db's catalog (a no-op when already current).
for db in "$APP_NAME" $EXTRA_DBS; do
  for ext in $EXTENSIONS; do
    PGPASSWORD="$SUPER_PWD" podman exec -i -e PGPASSWORD pg \
      psql -X -v ON_ERROR_STOP=1 -U postgres -d "$db" \
      -c "CREATE EXTENSION IF NOT EXISTS \"$ext\"" \
      -c "ALTER EXTENSION \"$ext\" UPDATE"
  done
done

# Write env file last so a partial bootstrap doesn't leave a stale
# env file pointing at a non-existent role. The password (and the
# connection URL) are emitted under every name our images read —
# n8n: DB_POSTGRESDB_PASSWORD, seerr: DB_PASS, grafana:
# GF_DATABASE_PASSWORD, healthchecks: DB_PASSWORD, bazarr:
# POSTGRES_PASSWORD, pocket-id: DB_CONNECTION_STRING — one uniform
# file shape for every tenant.
install -m 0600 -o "$OPERATOR_USER" -g "$OPERATOR_GROUP" /dev/stdin "$APP_ENV_FILE" <<EOF
POSTGRES_USER=${APP_NAME}
POSTGRES_DB=${APP_NAME}
POSTGRES_PASSWORD=$APP_PWD
DB_POSTGRESDB_PASSWORD=$APP_PWD
DB_PASS=$APP_PWD
DB_PASSWORD=$APP_PWD
GF_DATABASE_PASSWORD=$APP_PWD
DATABASE_URL=postgresql://${APP_NAME}:$APP_PWD@${DB_HOST}:${DB_PORT}/${APP_NAME}
DB_CONNECTION_STRING=postgresql://${APP_NAME}:$APP_PWD@${DB_HOST}:${DB_PORT}/${APP_NAME}
EOF
