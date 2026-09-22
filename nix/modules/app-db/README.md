# `app-db` — shared Postgres cluster, one database per app

One container (`pg`) backs every app. Per-app isolation lives at the
**database + role** level: each app gets its own database, owned by
its own login role; no other role can connect.

Paths below are written with the options they come from: `<stateRoot>`
is `fleet.stateRoot`, `<machineState>` is `fleet.machineState`
(`<stateRoot>/daedalus/state`), `<baseDomain>` is `fleet.baseDomain`,
`<operator>` is `fleet.operator.user`. Every `podman` command runs as the
operator, whose rootless store the cluster lives in:

```bash
as_operator() { sudo -u <operator> HOME=~<operator> XDG_RUNTIME_DIR=/run/user/<uid> "$@"; }
```

## Add a Postgres-backed app

An app on the apps platform declares it in its registry entry
(`postgres.enable = true`); the apps stack forwards that to
`fleet.appDatabases.<name> = { }`. A stack of its own writes the entry
directly. This module owns everything from there: role, database, env
file, LAN TCP route, local DNS record.

Name shape: `[a-z][a-z0-9_]*`. Enforced by an assertion at build time
(used directly as the postgres role/db and the env file dir; `cluster`
and `monitoring` are reserved — they hold infrastructure env files).

The `app-db-<name>-bootstrap.service` oneshot runs once before each
declared consumer container and materializes everything against the
shared cluster:

```sql
CREATE ROLE foo LOGIN PASSWORD '<random hex32>';
CREATE DATABASE foo OWNER foo;
REVOKE ALL ON DATABASE foo FROM PUBLIC;
GRANT  ALL ON DATABASE foo TO foo;
```

The per-app password is generated and written to
`<machineState>/app-db/foo/env` (mode `0600`, the operator's — outside
the configuration checkout, inside the snapshotted state tree). The env
file lands in the consumer container with:

```
POSTGRES_USER=foo
POSTGRES_DB=foo
POSTGRES_PASSWORD=<hex32>
DB_POSTGRESDB_PASSWORD=<hex32>   # n8n          (same value under every
DB_PASS=<hex32>                  # seerr         name a stock image might
DB_PASSWORD=<hex32>              # healthchecks  read — add new spellings
GF_DATABASE_PASSWORD=<hex32>     # grafana       in assets/bootstrap.sh)
DATABASE_URL=postgresql://foo:<hex32>@pg:5432/foo
DB_CONNECTION_STRING=postgresql://foo:<hex32>@pg:5432/foo   # pocket-id
```

Beyond `fleet.appDatabases.<name>` itself, the submodule offers:
`consumers` (container names ordered after the bootstrap; default
`[ "app-<name>" ]`), `extraDatabases` (additional DBs owned by the same
role), `extensions` (`CREATE EXTENSION` in the app's databases — the
cluster image ships pgvector), `reach` (`bridge` by container DNS, or
`hostPort` for a tenant inside another container's network namespace)
and read-only `envFile` / `dbHost` / `dbPort` (derived — reference them,
never hardcode).

## How the app connects

Container env carries `DATABASE_URL`. Most ORMs (Drizzle, Prisma,
postgres-js, sqlx, …) accept it directly. The hostname `pg` resolves
via aardvark-dns on the shared `app-db-net` bridge; the only host port
is the plain-TCP `5433` for `reach = "hostPort"` tenants.

Migrations run **inside** the already-created database. The bootstrap
guarantees the DB exists before the app container starts.

## LAN access (DBeaver / psql) via the reverse proxy

Single shared hostname for every database in the cluster:

```
Host:                postgres.<baseDomain>
Port:                5432
Database:            <name>
Username:            <name>
Password:            (from <machineState>/app-db/<name>/env)
SSL Mode:            require
Driver property:     sslnegotiation = direct
```

Traefik routes the TLS handshake by SNI to the shared `pg` backend;
the postgres server then picks the per-app database from the client's
`dbname=` in the StartupMessage. The hostname is decorative — the
`dbname=` + `user=` fields are what determine which app's database
you land in.

Requires libpq 17+ / pgjdbc 42.7+ (for `sslnegotiation=direct`).

## Per-app resource controls

The cluster is sized for a hobby fleet (see `app-db.nix` for the tuning
constants). Within that envelope, you can throttle a single greedy app
at the role level:

```sql
-- Cap one role to 10 concurrent connections
ALTER ROLE foo CONNECTION LIMIT 10;

-- Force a 30s upper bound on each statement from one role
ALTER ROLE foo SET statement_timeout = '30s';

-- Cancel long-blocked transactions
ALTER ROLE foo SET lock_timeout = '5s';
ALTER ROLE foo SET idle_in_transaction_session_timeout = '60s';
```

These persist across cluster restarts (stored in `pg_db_role_setting`).
Apply with the cluster superuser via:

```bash
PGPASSWORD="$(sudo grep '^POSTGRES_PASSWORD=' <machineState>/app-db/cluster/env | cut -d= -f2-)" \
  as_operator podman exec -e PGPASSWORD \
  pg psql -U postgres -d postgres -c "ALTER ROLE foo CONNECTION LIMIT 10;"
```

## File storage for apps

Apps store user uploads as a `bytea` column in their own database.
Constraints: ≤ ~10 MB per file, total per-app volume in the low GBs.
Past that, separate object storage is the answer, not a bigger cluster.

Example schema:

```sql
CREATE TABLE uploads (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid NOT NULL,
  filename    text NOT NULL,
  content_type text NOT NULL,
  bytes       bytea NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
```

## Backups

**One whole-cluster dump** (covers every app):

```bash
as_operator podman exec pg pg_dumpall -U postgres > pg-cluster-$(date +%Y%m%d-%H%M).sql
```

**Per-app dump** (clean isolation, smaller):

```bash
as_operator podman exec pg pg_dump -U postgres -d foo -Fc > foo-$(date +%Y%m%d-%H%M).dump
```

Restore the per-app dump into a fresh role + database (you may need
to recreate them first via the bootstrap):

```bash
as_operator podman exec -i pg pg_restore -U postgres -d foo --clean --if-exists < foo-<stamp>.dump
```

ZFS snapshots of the state dataset also cover the cluster data dir at
`<stateRoot>/app-db/postgres`. Browse via `.zfs/snapshot/…`.

## Remove an app cleanly

1. Delete the app's registry entry (or the stack's
   `fleet.appDatabases` line).
2. Rebuild. The consumer container goes away; the
   `app-db-<name>-bootstrap` unit is no longer generated. For a
   platform app also remove the deploy state
   (`/var/lib/app-deploy/<name>*`) and its images from the operator's
   rootless store.
3. **Manual cleanup** of postgres-side state:

   ```bash
   SUPER_PWD=$(sudo grep '^POSTGRES_PASSWORD=' <machineState>/app-db/cluster/env | cut -d= -f2-)
   PGPASSWORD="$SUPER_PWD" as_operator podman exec -e PGPASSWORD pg psql -U postgres -d postgres <<SQL
     DROP DATABASE IF EXISTS <name>;
     DROP ROLE     IF EXISTS <name>;
   SQL
   sudo rm -rf <machineState>/app-db/<name>
   ```

## Smoke test

```bash
# Cluster alive
as_operator podman exec pg psql -U postgres -d postgres -c '\l'

# Per-app role + db exist
as_operator podman exec pg psql -U postgres -d postgres \
  -c "SELECT datname FROM pg_database WHERE datname='foo';" \
  -c "SELECT rolname FROM pg_roles WHERE rolname='foo';"

# Consumer container has DATABASE_URL
as_operator podman inspect app-foo \
  --format '{{range .Config.Env}}{{println .}}{{end}}' \
  | grep '^DATABASE_URL='
```

## Escape hatch: dedicated cluster for one app

If a single app needs its own postgres version, special extensions, or
hard resource isolation, the shared model isn't the right fit. The
clean path is a sibling module materializing a standalone container +
bootstrap for that one app. Not implemented here today; document the
deviation in the app's declaration when it happens.

## What lives where

```
nix/modules/app-db/         (the engine)
├── app-db.nix          # shared pg + registry + per-app bootstrap units
├── exporter.nix        # app-db-exporter (postgres_exporter) + dashboard
├── claude-ro.nix       # read-only role for the operator's MCP client
├── README.md           # this file
└── assets/
    ├── bootstrap.sh    # per-app role/db SQL, concatenated into the units
    ├── pg-image/       # the cluster image: postgres + pgvector
    ├── postgres.json   # `$app`-templated Grafana dashboard (datname-based)
    └── traefik-tcp.yml # postgres.<baseDomain> TCP/SNI route

<machineState>/app-db/  # machine-generated, born on the box
├── cluster/env     # POSTGRES_PASSWORD (cluster superuser)
├── monitoring/env  # exporter role password (reserved name)
└── <name>/env      # per-app DATABASE_URL + password under every
                    # key the stock images read

<stateRoot>/app-db/
└── postgres/           # bind-mounted into pg:/var/lib/postgresql/data
```
