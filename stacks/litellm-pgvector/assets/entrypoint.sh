#!/bin/sh
# litellm-pgvector container entrypoint.
#
# The upstream Dockerfile only runs `prisma generate` at build; the
# tables are never created. Apply the Prisma schema here, but ONLY when
# the `embeddings` table is absent (first boot) — `prisma db push`
# against a schema with an Unsupported("vector(...)") column can flag a
# spurious diff and, with --accept-data-loss, would drop the table on a
# restart. Guarding on table existence keeps restarts non-destructive.
#
# `pg` + the vector extension are guaranteed present before we run:
# the app-db bootstrap (extensions = [ "vector" ]) is ordered before
# this container, and psql/prisma here connect via $DATABASE_URL.
set -eu

if psql "$DATABASE_URL" -tAc \
     "SELECT 1 FROM information_schema.tables WHERE table_name = 'embeddings'" \
     | grep -q 1; then
  echo "litellm-pgvector: schema already present, skipping db push"
else
  echo "litellm-pgvector: applying Prisma schema (first boot)"
  prisma db push --skip-generate --accept-data-loss
fi

exec uvicorn main:app --host 0.0.0.0 --port "${PORT:-8000}"
