// The Database module's data half: the shared Postgres cluster, one tab.
//
// Pure prometheus — postgres_exporter publishes everything the page shows
// and is scraped every 60s, so there is nothing for the host to publish. The
// one thing it does not know is how far behind the running major is, and
// that comes from postgresql.org rather than GitHub (see ./postgres.ts).

import { defineLoader, type TabPayload } from '../../../lib/modules/tabs'
import { manifest } from '../manifest'
import { loadPostgres, type PostgresData } from './postgres'

export type Tabs = {
  postgres: PostgresData
}
export type DatabaseData = TabPayload<typeof manifest, Tabs>

export const load = defineLoader<typeof manifest, Tabs>(manifest, {
  postgres: loadPostgres,
})
