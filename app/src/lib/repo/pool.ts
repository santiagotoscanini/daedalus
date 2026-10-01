import { closeDb, db, sql, type Tx } from '../../host/db'

// The pool itself, for the three callers that need it rather than a table:
// the health probe, a transaction that spans two repositories, and shutdown.

/** One round trip. Throws when Postgres cannot be reached. */
export async function ping(): Promise<void> {
  await sql`SELECT 1`
}

/** Run `fn` in one transaction, for writes that span repositories (each takes the `tx`). */
export function transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(fn)
}

export { closeDb }
