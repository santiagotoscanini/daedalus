import type { ReleaseSource } from '../../lib/dashboard/image-repos'
import { TWO_OR_THREE } from '../../lib/release-tags'

// Where the Monitoring containers' release notes live — the same repos and
// options each tab passes to versionGap, so the Updates row and the service
// page cannot disagree about what "3 behind" means. The exporters that feed
// prometheus (node-exporter, app-db-exporter, intel-gpu-exporter) are no
// tab's subject and stay in image-repos.
export const releases: Record<string, ReleaseSource> = {
  grafana: { repo: 'grafana/grafana', opts: { sameMajor: true } },
  prometheus: { repo: 'prometheus/prometheus' },
  loki: { repo: 'grafana/loki' },
  alloy: { repo: 'grafana/alloy' },
  gatus: { repo: 'TwiN/gatus' },
  healthchecks: { repo: 'healthchecks/healthchecks', opts: { tag: TWO_OR_THREE } },
}
