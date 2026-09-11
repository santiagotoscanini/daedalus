// The timezone picker's list: tzdata's zone.tab, from the tzdata this system
// is built with (platform/export.nix copies it to /export/zone.tab). Pure, so
// it is testable and the client can group what the server sends; the file
// read is core/settings/timezones.ts's.
//
// zone.tab and not zone1970.tab: the second merges zones that have agreed on
// the clock since 1970, so Europe/Oslo is not in it and someone in Oslo would
// have to know to pick Europe/Berlin. And not Node's Intl list, which still
// prints the legacy America/Buenos_Aires for what tzdata and NixOS call
// America/Argentina/Buenos_Aires.

export type TimezoneGroup = { region: string; zones: string[] }

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** The zone names in a zone.tab body, plus UTC. Sorted, unique. */
export function parseZoneTab(body: string): string[] {
  const names = new Set<string>(['UTC'])
  for (const line of body.split('\n')) {
    if (line.startsWith('#')) continue
    const name = line.split('\t')[2]?.trim() ?? ''
    if (name !== '') names.add(name)
  }
  return [...names].sort(byCodeUnit)
}

/**
 * Grouped by the name's first segment, for the picker's headings. A name with
 * no region (UTC) is its own group, first, because it is the one people pick
 * without living anywhere in particular.
 */
export function groupZones(zones: readonly string[]): TimezoneGroup[] {
  const groups = new Map<string, string[]>()
  for (const zone of zones) {
    const slash = zone.indexOf('/')
    const region = slash === -1 ? '' : zone.slice(0, slash)
    const list = groups.get(region) ?? []
    list.push(zone)
    groups.set(region, list)
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : byCodeUnit(a, b)))
    .map(([region, list]) => ({ region: region === '' ? 'Universal' : region, zones: list }))
}
