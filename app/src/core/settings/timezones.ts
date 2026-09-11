import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseZoneTab } from '../../lib/timezones'

// The zones the timezone picker offers, and the save refuses anything else.
//
// /export/zone.tab is the host's own tzdata (platform/export.nix), which is
// what `time.timeZone` is resolved against. Until a rebuild has published it,
// the container's Debian tzdata stands in: the zone names are the same for
// every practical purpose, and a picker that lists nothing is worse.

export async function readTimezones(): Promise<string[]> {
  const sources = [
    join(process.env.EXPORT_DIR ?? '/export', 'zone.tab'),
    '/usr/share/zoneinfo/zone.tab',
  ]
  for (const path of sources) {
    try {
      return parseZoneTab(await readFile(path, 'utf8'))
    } catch {
      // the next source
    }
  }
  return []
}
