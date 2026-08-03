import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { env } from './env'
import * as schema from './schema'

// Postgres on the shared app-db cluster: role + database `daedalus`, reached at
// `pg:5432` over the app-db-net bridge. DATABASE_URL is written by
// app-db-daedalus-bootstrap.service, not by anything in this repo.
//
// The client is memoised on globalThis because `vite dev` re-evaluates modules
// on every HMR update — without this, each save would open a fresh connection
// pool and leak the previous one until the cluster's max_connections (200,
// shared across ~15 tenants) ran out. That failure looks like the whole box's
// databases dying, hours after an innocuous edit.
const globalForDb = globalThis as unknown as {
  daedalusSql?: ReturnType<typeof postgres>
}

const sql =
  globalForDb.daedalusSql ??
  postgres(env.databaseUrl, {
    // Small ceiling on purpose: this is a single-operator control plane sharing
    // a cluster, not something that should be able to starve its neighbours.
    max: 5,
  })

globalForDb.daedalusSql = sql

export const db = drizzle(sql, { schema })
export { sql }
