import { describe, expect, it } from 'vitest'
import { groupZones, parseZoneTab } from './timezones'

const tab = [
  '# tzdb timezone descriptions',
  '#country-code\tcoordinates\tTZ\tcomments',
  'AR\t-3436-05827\tAmerica/Argentina/Buenos_Aires\tBuenos Aires (BA, CF)',
  'NO\t+5955+01045\tEurope/Oslo',
  'DE\t+5230+01322\tEurope/Berlin\tmost of Germany',
  'DE\t+5230+01322\tEurope/Berlin\ta duplicate line',
  '',
].join('\n')

describe('parseZoneTab', () => {
  it('reads the TZ column, skips comments, adds UTC, sorts and dedupes', () => {
    expect(parseZoneTab(tab)).toEqual([
      'America/Argentina/Buenos_Aires',
      'Europe/Berlin',
      'Europe/Oslo',
      'UTC',
    ])
  })
})

describe('groupZones', () => {
  it('groups by region with the region-less names first', () => {
    expect(groupZones(parseZoneTab(tab))).toEqual([
      { region: 'Universal', zones: ['UTC'] },
      { region: 'America', zones: ['America/Argentina/Buenos_Aires'] },
      { region: 'Europe', zones: ['Europe/Berlin', 'Europe/Oslo'] },
    ])
  })
})
