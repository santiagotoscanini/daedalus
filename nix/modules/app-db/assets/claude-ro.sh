# shellcheck shell=bash
# Converges the read-only claude_ro role: mints its password into ENV_FILE
# the first time, then sets it, grants pg_read_all_data, and CONNECT on every
# database except those named in PRIVATE (space-padded), from which it is
# revoked. Parameters: ENV_FILE, PRIVATE.

umask 077
if [ ! -s "$ENV_FILE" ]; then
  install -d -m 0700 "$(dirname "$ENV_FILE")"
  pass=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')
  printf 'PGUSER=claude_ro\nPGPASSWORD=%s\n' "$pass" >"$ENV_FILE.tmp"
  mv -f "$ENV_FILE.tmp" "$ENV_FILE"
  echo "claude-ro: minted a password into $ENV_FILE"
fi

PASS=$(grep -m1 '^PGPASSWORD=' "$ENV_FILE" | cut -d= -f2-)
# Minted as hex; refuse anything else rather than risk quoting it into SQL.
if ! printf '%s' "$PASS" | grep -qE '^[A-Za-z0-9]+$'; then
  echo "claude-ro: the password in $ENV_FILE has unexpected characters; refusing" >&2
  exit 1
fi

psql_pg() { podman exec -i pg psql -U postgres -tA -v ON_ERROR_STOP=1; }

if [ "$(echo "SELECT 1 FROM pg_roles WHERE rolname='claude_ro'" | psql_pg)" != 1 ]; then
  echo "CREATE ROLE claude_ro LOGIN" | psql_pg
fi
# Over stdin, so the password is never on a command line.
echo "ALTER ROLE claude_ro LOGIN PASSWORD '$PASS' NOSUPERUSER NOCREATEDB NOCREATEROLE" | psql_pg
echo "GRANT pg_read_all_data TO claude_ro" | psql_pg

for db in $(echo "SELECT datname FROM pg_database WHERE NOT datistemplate" | psql_pg); do
  case "$PRIVATE" in
    *" $db "*) echo "REVOKE CONNECT ON DATABASE \"$db\" FROM claude_ro" | psql_pg ;;
    *) echo "GRANT CONNECT ON DATABASE \"$db\" TO claude_ro" | psql_pg ;;
  esac
done
echo "claude-ro: converged"
