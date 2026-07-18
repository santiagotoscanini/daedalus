# `app-db` — shared Postgres cluster, one database per app

One container (`pg`) backs every app. Per-app isolation lives at the
**database + role** level: each app gets its own database, owned by
its own login role; no other role can connect.

## Add a Postgres-backed app

One attribute in `stacks/apps/declarations.nix`:

```nix
fleet.apps.foo = {
  postgres.enable = true;

  homepage = {
    description = "Foo — what this app does";
    icon        = "mdi-cube-outline-#94a3b8";
  };
};
```

`apps.nix` forwards that to `fleet.appDatabases.foo = { }`, and this
module owns everything else from there: role, database, env file, LAN
TCP route, pi-hole hosts entry.

Name shape: `[a-z][a-z0-9_]*`. Enforced by an assertion at build time
(used directly as the postgres role/db and the env file dir; `cluster`
and `monitoring` are reserved — they hold infrastructure env files).

Then:

```bash
sudo nixos-rebuild test
sudo nixos-rebuild switch
```

The `app-db-foo-bootstrap.service` oneshot runs once before
`podman-app-foo.service` and materializes everything against the
shared cluster:

```sql
CREATE ROLE foo LOGIN PASSWORD '<random hex32>';
CREATE DATABASE foo OWNER foo;
REVOKE ALL ON DATABASE foo FROM PUBLIC;
GRANT  ALL ON DATABASE foo TO foo;
```

The per-app password is generated and written to
`/etc/nixos/stacks/app-db/secrets/foo/env` (mode `0600 santiago:users`,
gitignored). The env file lands in the app container with:

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
role), and read-only `envFile` (the generated env file's path — reference
it, never hardcode).

## How the app connects

Container env carries `DATABASE_URL`. Most ORMs (Drizzle, Prisma,
postgres-js, sqlx, …) accept it directly. The hostname `pg` resolves
via aardvark-dns on the shared `app-db-net` bridge; no host port is
published.

Migrations run **inside** the already-created database. The bootstrap
guarantees the DB exists before the app container starts.

## LAN access (DBeaver / psql) via traefik

Single shared hostname for every database in the cluster:

```
Host:                postgres.toscanini.me
Port:                5432
Database:            <name>
Username:            <name>
Password:            (from /etc/nixos/stacks/app-db/secrets/<name>/env)
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

The cluster is sized for the current tenant count (see `app-db.nix` for
the tuning constants). Within that envelope, you can throttle a single
greedy app at the role level:

```sql
-- Cap one role to 10 concurrent connections
ALTER ROLE anansi CONNECTION LIMIT 10;

-- Force a 30s upper bound on each statement from one role
ALTER ROLE anansi SET statement_timeout = '30s';

-- Cancel long-blocked transactions
ALTER ROLE anansi SET lock_timeout = '5s';
ALTER ROLE anansi SET idle_in_transaction_session_timeout = '60s';
```

These persist across cluster restarts (stored in `pg_db_role_setting`).
Apply with the cluster superuser via:

```bash
sudo -u santiago HOME=/home/santiago XDG_RUNTIME_DIR=/run/user/1000 \
  PGPASSWORD="$(sudo grep '^POSTGRES_PASSWORD=' /etc/nixos/stacks/app-db/secrets/cluster/env | cut -d= -f2-)" \
  podman exec -e PGPASSWORD \
  pg psql -U postgres -d postgres -c "ALTER ROLE anansi CONNECTION LIMIT 10;"
```

## File storage for apps

Apps store user uploads as a `bytea` column in their own database.
Constraints: ≤ ~10 MB per file, total per-app volume in the low GBs.
Ping santiago if any app grows past that — separate S3 storage can be
wired up.

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
sudo -u santiago HOME=/home/santiago XDG_RUNTIME_DIR=/run/user/1000 \
  podman exec pg pg_dumpall -U postgres \
  > /home/santiago/backups/pg-cluster-$(date +%Y%m%d-%H%M).sql
```

**Per-app dump** (clean isolation, smaller):

```bash
sudo -u santiago HOME=/home/santiago XDG_RUNTIME_DIR=/run/user/1000 \
  podman exec pg pg_dump -U postgres -d anansi -Fc \
  > /home/santiago/backups/anansi-$(date +%Y%m%d-%H%M).dump
```

Restore the per-app dump into a fresh role + database (you may need
to recreate them first via the bootstrap):

```bash
sudo -u santiago HOME=/home/santiago XDG_RUNTIME_DIR=/run/user/1000 \
  podman exec -i pg pg_restore -U postgres -d anansi --clean --if-exists \
  < /home/santiago/backups/anansi-20260528-1900.dump
```

ZFS snapshots of `rpool/selfhost` also cover the cluster data dir at
`/home/santiago/selfhost/app-db/postgres`. Browse via `.zfs/snapshot/…`.

## Remove an app cleanly

1. Delete the app's entry from `stacks/apps/declarations.nix`.
2. `sudo nixos-rebuild switch`. The app container goes away; the
   `app-db-<name>-bootstrap` unit is no longer generated.
   Also remove the deploy state (`sudo rm -f /var/lib/app-deploy/<name>*`)
   and the app's images from santiago's rootless store
   (`podman rmi ghcr.io/santiagotoscanini/<name>:latest`).
3. **Manual cleanup** of postgres-side state:

   ```bash
   SUPER_PWD=$(sudo grep '^POSTGRES_PASSWORD=' /etc/nixos/stacks/app-db/secrets/cluster/env | cut -d= -f2-)
   sudo -u santiago HOME=/home/santiago XDG_RUNTIME_DIR=/run/user/1000 \
     PGPASSWORD="$SUPER_PWD" podman exec -e PGPASSWORD pg psql -U postgres -d postgres <<SQL
     DROP DATABASE IF EXISTS <name>;
     DROP ROLE     IF EXISTS <name>;
   SQL
   sudo rm -rf /etc/nixos/stacks/app-db/secrets/<name>
   ```

## Smoke test

```bash
# Cluster alive
sudo -u santiago HOME=/home/santiago XDG_RUNTIME_DIR=/run/user/1000 \
  podman exec pg psql -U postgres -d postgres -c '\l'

# Per-app role + db exist
sudo -u santiago HOME=/home/santiago XDG_RUNTIME_DIR=/run/user/1000 \
  podman exec pg psql -U postgres -d postgres \
  -c "SELECT datname FROM pg_database WHERE datname='anansi';" \
  -c "SELECT rolname FROM pg_roles WHERE rolname='anansi';"

# App container has DATABASE_URL
sudo -u santiago HOME=/home/santiago XDG_RUNTIME_DIR=/run/user/1000 \
  podman inspect app-anansi \
  --format '{{range .Config.Env}}{{println .}}{{end}}' \
  | grep '^DATABASE_URL='
```

## Escape hatch: dedicated cluster for one app

If a single app needs its own postgres version, special extensions, or
hard resource isolation, the shared model isn't the right fit. The
clean path is a sibling module (e.g. `dedicated-pg.nix`) materializing
a standalone container + bootstrap for that one app (immich's dedicated
vectorchord postgres is the live example of the shape). Not implemented
here today; document the deviation in the app's declaration when it
happens.

## What lives where

```
/etc/nixos/stacks/app-db/
├── app-db.nix          # shared pg + per-app bootstrap units
├── exporter.nix        # app-db-exporter (postgres_exporter) + dashboard
├── README.md           # this file
├── assets/
│   ├── bootstrap.sh    # per-app role/db SQL, concatenated into the units
│   ├── postgres.json   # `$app`-templated Grafana dashboard (datname-based)
│   └── traefik-tcp.yml # postgres.toscanini.me TCP/SNI route
└── secrets/            # gitignored (machine-generated)
    ├── cluster/env     # POSTGRES_PASSWORD (cluster superuser)
    ├── monitoring/env  # exporter role password (reserved name)
    └── <name>/env      # per-app DATABASE_URL + password under every
                        # key our images read (POSTGRES_PASSWORD,
                        # DB_PASSWORD, DB_PASS, DB_POSTGRESDB_PASSWORD,
                        # GF_DATABASE_PASSWORD, DB_CONNECTION_STRING)

/home/santiago/selfhost/app-db/
└── postgres/           # bind-mounted into pg:/var/lib/postgresql/data
```
