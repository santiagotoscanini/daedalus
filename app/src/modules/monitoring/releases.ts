import type { ReleaseSource } from '../../lib/dashboard/image-repos'
import { TWO_OR_THREE } from '../../lib/release-tags'

// Where the Monitoring containers' release notes live, for the Updates row.
// Each entry must repeat the repo and options its tab's loader passes to
// versionGap (data/*.ts) — the loaders spell them out rather than read this
// table, so nothing but review keeps the two answers about "3 behind" equal.
// The exporters are no tab's subject: node-exporter and intel-gpu-exporter
// stay in image-repos, app-db-exporter is the Database module's.
export const releases: Record<string, ReleaseSource> = {
  grafana: { repo: 'grafana/grafana', opts: { sameMajor: true } },
  prometheus: { repo: 'prometheus/prometheus' },
  loki: { repo: 'grafana/loki' },
  alloy: { repo: 'grafana/alloy' },
  gatus: { repo: 'TwiN/gatus' },
  healthchecks: { repo: 'healthchecks/healthchecks', opts: { tag: TWO_OR_THREE } },
}
