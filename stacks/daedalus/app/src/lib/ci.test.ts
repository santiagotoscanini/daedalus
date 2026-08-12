import { describe, expect, it } from 'vitest'
import { type ActivityRow, rollUp, shortenDigests } from './ci'

// A full 64-hex-character digest whose first twelve characters are the short
// form the rest of the page shows.
const HEX52 = 'ab'.repeat(26)
const FULL = `sha256:c20afeca1270${HEX52}`

describe('shortenDigests', () => {
  it('cuts a full digest down to the twelve characters the page shows', () => {
    expect(shortenDigests(`pulled ${FULL}`)).toBe('pulled c20afeca1270')
  })

  it('shortens every digest on the line, not just the first', () => {
    expect(shortenDigests(`${FULL} -> ${FULL}`)).toBe('c20afeca1270 -> c20afeca1270')
  })

  it('leaves anything that is not a full sha256 digest alone', () => {
    // Already short, wrong length, missing prefix — none of these are the
    // 71-character form the regex targets.
    expect(shortenDigests('digest moved to c20afeca1270')).toBe('digest moved to c20afeca1270')
    expect(shortenDigests('sha256:c20afeca1270')).toBe('sha256:c20afeca1270')
    expect(shortenDigests(`c20afeca1270${HEX52}`)).toBe(`c20afeca1270${HEX52}`)
  })
})

const row = (ts: string, line: string, source: ActivityRow['source'] = 'deploy'): ActivityRow => ({
  ts,
  line,
  source,
})

describe('rollUp', () => {
  it('returns nothing for nothing', () => {
    expect(rollUp([])).toEqual([])
  })

  it('folds a run of identical lines into one row with a count', () => {
    const rolled = rollUp([
      row('2026-08-12T04:00:00Z', 'no change'),
      row('2026-08-12T04:02:00Z', 'no change'),
      row('2026-08-12T04:04:00Z', 'no change'),
    ])
    expect(rolled).toEqual([
      {
        key: '2026-08-12T04:00:00Z-0',
        ts: '2026-08-12T04:00:00Z',
        lastTs: '2026-08-12T04:04:00Z',
        line: 'no change',
        source: 'deploy',
        count: 3,
      },
    ])
  })

  it('folds runs only — a real event between two runs keeps them apart', () => {
    const rolled = rollUp([
      row('t1', 'no change'),
      row('t2', 'no change'),
      row('t3', 'digest moved'),
      row('t4', 'no change'),
    ])
    expect(rolled.map((l) => [l.line, l.count])).toEqual([
      ['no change', 2],
      ['digest moved', 1],
      ['no change', 1],
    ])
  })

  it('never merges across sources, even for an identical line', () => {
    const rolled = rollUp([row('t1', 'job done', 'build'), row('t2', 'job done', 'deploy')])
    expect(rolled.map((l) => l.source)).toEqual(['build', 'deploy'])
    expect(rolled.map((l) => l.count)).toEqual([1, 1])
  })

  it('compares lines after digest shortening, so a repeated digest line folds', () => {
    const rolled = rollUp([row('t1', `pulled ${FULL}`), row('t2', `pulled ${FULL}`)])
    expect(rolled).toHaveLength(1)
    expect(rolled[0]?.line).toBe('pulled c20afeca1270')
    expect(rolled[0]?.count).toBe(2)
  })

  it('keys each row by its first timestamp and position', () => {
    const rolled = rollUp([row('t1', 'a'), row('t2', 'b')])
    expect(rolled.map((l) => l.key)).toEqual(['t1-0', 't2-1'])
  })
})
