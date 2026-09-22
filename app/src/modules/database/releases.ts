import type { ReleaseSource } from '../../lib/dashboard/image-repos'

// Where the Database containers' release notes live. The page fronts the
// cluster's exporter and nothing else: `pg` itself is the stock postgres
// image, curated nowhere, and answers through its label like every other
// container nobody claimed — its release gap comes from postgresql.org
// instead (lib/dashboard/postgres.ts).
export const releases: Record<string, ReleaseSource> = {
  'app-db-exporter': { repo: 'prometheus-community/postgres_exporter' },
}
