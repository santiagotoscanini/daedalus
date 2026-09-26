import { promVector } from '../../host/prom'

// Is anything down, in one answer.
//
// The app never needed this: a page draws the dot for the service it is about,
// and `server/category.ts fetchTabStatus` answers "which of THIS category's
// tabs are green" — so there was nowhere that asked the box-wide question,
// because a person asking it just looks at the dashboard.
//
// An agent cannot look at the dashboard. "What is broken right now" is the
// first thing anything driving this box wants to know and the last thing it
// should have to assemble from eleven category calls, so the MCP `health` tool
// gets the aggregate that the UI's shape never called for.
//
// ONE prometheus query, and deliberately the same one the dots use — gatus
// probes every published webApp's `healthPath` plus a couple of off-box
// services, which is exactly the set "is anything down" means here. Nothing is
// dialled directly: a health check that itself fans out to sixty services is a
// health check that times out.
//
// The window matches fetchTabStatus's: `max_over_time(...[3m])` reports a
// probe as healthy if ANY scrape in the last three minutes succeeded, which is
// what keeps one dropped scrape from being reported as an outage.
const PROBE_WINDOW = '3m'

type ProbeHealth = {
  /** The gatus endpoint name — the webApp's name, not `<group>_<name>`. */
  name: string
  healthy: boolean
}

export type HealthData = {
  /** Every probe, failing ones first, then by name. */
  probes: ProbeHealth[]
  failing: string[]
  /**
   * True when prometheus answered with nothing at all. An empty probe list and
   * "everything is fine" are the same JSON otherwise, and they are opposite
   * facts — this is the field that keeps a broken scrape from reading as green.
   */
  unavailable: boolean
}

export async function loadHealth(): Promise<HealthData> {
  const results = await promVector(`max_over_time(gatus_results_endpoint_success[${PROBE_WINDOW}])`)

  // The `name` label, not `key`: `key` is `<group>_<name>`, so reading it means
  // knowing which list an endpoint was declared in — the same reason
  // fetchTabStatus reads `name`.
  const probes = results
    .map((r) => ({ name: r.metric.name ?? '', healthy: r.value[1] === '1' }))
    .filter((p) => p.name !== '')

  probes.sort((a, b) => Number(a.healthy) - Number(b.healthy) || a.name.localeCompare(b.name))

  return {
    probes,
    failing: probes.filter((p) => !p.healthy).map((p) => p.name),
    unavailable: probes.length === 0,
  }
}
