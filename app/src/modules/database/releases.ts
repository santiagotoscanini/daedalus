import type { ReleaseSource } from '../../lib/dashboard/image-repos'

// Where the Data containers' release notes live. `pg` itself is the stock
// postgres image, curated nowhere, and answers through its label like every
// other container nobody claimed — its release gap comes from postgresql.org
// instead (lib/dashboard/postgres.ts). Garage publishes its releases on its
// own Forgejo, not GitHub, which mirrors only the tags.
export const releases: Record<string, ReleaseSource> = {
  'app-db-exporter': { repo: 'prometheus-community/postgres_exporter' },
  garage: { repo: 'git.deuxfleurs.fr/Deuxfleurs/garage' },
  'garage-ui': { repo: 'Noooste/garage-ui' },
}
