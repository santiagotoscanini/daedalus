// The schema, brought up to date before the app starts — the one migration
// path for both ways the image runs: server.mjs imports `runMigrations`, and
// docker-entrypoint.sh's dev branch runs this file before `pnpm dev`.
//
// drizzle's migrator and `drizzle-kit migrate` keep the same ledger
// (`drizzle.__drizzle_migrations`), so a database migrated by hand
// (`pnpm db:migrate`) is picked up where it stands. Its own one-connection
// client, with none of the app pool's statement timeout, closed before the
// app opens its pool. A failure exits non-zero on purpose: serving on a schema
// the code does not match is how data gets damaged.

import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

const MIGRATIONS_DIR = fileURLToPath(new URL('./drizzle', import.meta.url))

export async function runMigrations() {
  const url = process.env.DATABASE_URL
  if (url === undefined || url === '') throw new Error('DATABASE_URL is not set')
  const sql = postgres(url, { max: 1, onnotice: () => {} })
  try {
    await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS_DIR })
  } finally {
    await sql.end({ timeout: 5 })
  }
}

// `node migrate.mjs`: the dev branch's call. A rejection here is node's
// unhandled top-level one, which exits 1.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const started = performance.now()
  await runMigrations()
  console.log(`[daedalus] migrations ${Math.round(performance.now() - started)}ms`)
}
