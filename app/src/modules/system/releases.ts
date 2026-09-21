import type { ReleaseSource } from '../../lib/dashboard/image-repos'

// Where the System containers' release notes live. Only the Database tab
// fronts a container at all — the rest of the row is the machine — and what
// it fronts is the cluster's exporter: `pg` itself is the stock postgres
// image, curated nowhere, and answers through its label like every other
// container nobody claimed.
export const releases: Record<string, ReleaseSource> = {
  'app-db-exporter': { repo: 'prometheus-community/postgres_exporter' },
}
