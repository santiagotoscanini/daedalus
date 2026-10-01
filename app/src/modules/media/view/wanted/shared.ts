import type { LogNeighbour } from '../../../../components/logs'
import type { MediaData } from '../../data'

// What the Wanted pages share: their slice of the payload and the log beside them.

/**
 * scraparr is what turns the *arrs into prometheus series, and it has no page
 * anywhere: it serves only /metrics. It belongs under the *arrs because a
 * gap in the *arr graphs on the Monitoring page is nearly always this
 * container having stopped, not the *arr.
 */
export const WANTED_NEIGHBOURS: readonly LogNeighbour[] = [
  {
    source: { container: 'scraparr' },
    label: 'Scraparr',
    role: 'the exporter behind the *arr graphs',
    note: 'Polls Sonarr, Radarr, Prowlarr and Bazarr on a timer and republishes what they say as prometheus metrics. Nothing on this tab reads it; every number here comes from the *arrs directly. The dashboards on the Monitoring page do, so a flat line there starts here. Expect periodic “scrape failed” and “No data found” errors: those four are dialled at a rootless-published host port, where a new connection occasionally hangs ~10.5s, and scraparr gives up at a hardcoded 10 with no retry. The scrape after it succeeds and the previous value is kept, so the metrics stay correct, but scraparr_services_up dips while it happens.',
  },
]

export type Wanted = Extract<MediaData, { tab: 'wanted' }>
