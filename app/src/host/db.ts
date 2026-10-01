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
  postgres(env.get('DATABASE_URL'), {
    // Small ceiling on purpose: this is a single-operator control plane sharing
    // a cluster, not something that should be able to starve its neighbours.
    max: 5,
    // Same reason, in time: a wedged query or a transaction left open must
    // not hold one of the five, or the cluster's locks, indefinitely. Nothing
    // here legitimately runs long — every query is a page read or a small
    // write — and the migrations, the one slow thing, run on their own client
    // before this pool opens (server.mjs).
    connection: {
      application_name: 'daedalus',
      statement_timeout: 15_000,
      idle_in_transaction_session_timeout: 30_000,
    },
  })

globalForDb.daedalusSql = sql

export const db = drizzle(sql, { schema })
export { sql }

/** End the pool at shutdown: queries in flight get five seconds, then their connections close. */
export function closeDb(): Promise<void> {
  return sql.end({ timeout: 5 })
}

/** The handle `db.transaction` passes its callback. */
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/** The pool or a transaction — for repository functions a caller may need to join to its own. */
export type Executor = typeof db | Tx
