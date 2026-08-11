import { describe, expect, it } from 'vitest'
import {
  bytes,
  compact,
  DASH,
  duration,
  flag,
  ms,
  num,
  pct,
  rate,
  since,
  text,
  until,
} from './format'

// The one property every formatter must hold: null/undefined/NaN renders the
// em dash — "could not read this" must never look like a zero.
describe('null in, dash out', () => {
  it('holds for every formatter', () => {
    for (const f of [num, compact, bytes, rate, pct, since, ms, duration, until]) {
      expect(f(null)).toBe(DASH)
      expect(f(undefined)).toBe(DASH)
    }
    expect(num(Number.NaN)).toBe(DASH)
    expect(bytes(Number.POSITIVE_INFINITY)).toBe(DASH)
    expect(text(null)).toBe(DASH)
    expect(text('')).toBe(DASH)
    expect(flag(null)).toBe(DASH)
    expect(flag('')).toBe(DASH)
  })
})

describe('num', () => {
  it('groups thousands and rounds to the asked digits', () => {
    expect(num(976228)).toBe('976,228')
    expect(num(1234.56, 1)).toBe('1,234.6')
    expect(num(0)).toBe('0')
  })
})

describe('compact', () => {
  it('shortens by magnitude', () => {
    expect(compact(999)).toBe('999')
    expect(compact(1000)).toBe('1k')
    expect(compact(976228)).toBe('976k')
    expect(compact(1_500_000)).toBe('1.5M')
    expect(compact(15_000_000)).toBe('15M')
    expect(compact(1_200_000_000)).toBe('1.2B')
    expect(compact(20_000_000_000)).toBe('20B')
  })
})

describe('bytes', () => {
  it('picks the unit and the precision', () => {
    expect(bytes(0)).toBe('0 B')
    expect(bytes(1023)).toBe('1023 B')
    expect(bytes(1024)).toBe('1.0 KB')
    expect(bytes(10 * 1024)).toBe('10 KB')
    expect(bytes(1024 ** 3 * 1.5)).toBe('1.5 GB')
    expect(bytes(1024 ** 5)).toBe('1.0 PB')
  })

  it('clamps at PB rather than inventing a unit', () => {
    expect(bytes(1024 ** 6)).toBe('1024 PB')
  })
})

describe('rate', () => {
  it('is bytes with a denominator', () => {
    expect(rate(1024)).toBe('1.0 KB/s')
  })
})

describe('pct', () => {
  it('formats with the asked digits', () => {
    expect(pct(12.34, 1)).toBe('12.3%')
    expect(pct(0)).toBe('0%')
  })
})

describe('since', () => {
  it('one unit, and "just now" under the minute', () => {
    expect(since(30)).toBe('just now')
    expect(since(45)).toBe('1 min ago')
    expect(since(5399)).toBe('90 min ago')
    expect(since(2 * 3600)).toBe('2h ago')
    expect(since(3 * 86400)).toBe('3d ago')
    expect(since(2 * 31536000)).toBe('2y ago')
  })
})

describe('ms', () => {
  it('spans the five orders of magnitude readably', () => {
    expect(ms(999)).toBe('999 ms')
    expect(ms(1000)).toBe('1.0 s')
    expect(ms(59_400)).toBe('59.4 s')
    expect(ms(145_000)).toBe('2m 25s')
  })
})

describe('duration and until', () => {
  it('measures a span rather than a distance from now', () => {
    expect(duration(59)).toBe('59s')
    expect(duration(60)).toBe('1 min')
    expect(duration(2 * 3600)).toBe('2h')
  })

  it('counts down and bottoms out at now', () => {
    expect(until(0)).toBe('now')
    expect(until(-5)).toBe('now')
    expect(until(89)).toBe('89s')
    expect(until(120)).toBe('2 min')
  })
})

describe('flag', () => {
  it('knows the fleet countries and degrades to the globe', () => {
    expect(flag('Germany')).toBe('🇩🇪 Germany')
    expect(flag('Utopia')).toBe('🌐 Utopia')
  })
})
