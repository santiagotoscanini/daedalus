// The Data module's data half: the shared Postgres cluster and the shared
// object store, one tab each.
//
// Pure prometheus — postgres_exporter and Garage publish what the pages show,
// and the per-bucket figures Garage keeps to its admin API are copied into the
// textfile collector by the host (nix/modules/garage). What neither knows is
// how far behind the running release is: postgresql.org answers for one
// (lib/dashboard/postgres.ts), Garage's own forge for the other.

import { defineLoader, type TabPayload } from '../../../lib/modules/tabs'
import { manifest } from '../manifest'
import { type GarageData, loadGarage } from './garage'
import { loadPostgres, type PostgresData } from './postgres'

export type Tabs = {
  postgres: PostgresData
  garage: GarageData
}
export type DatabaseData = TabPayload<typeof manifest, Tabs>

export const load = defineLoader<typeof manifest, Tabs>(manifest, {
  postgres: loadPostgres,
  garage: loadGarage,
})
