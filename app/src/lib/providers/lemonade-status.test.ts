import { describe, expect, it } from 'vitest'
import { installKnown, type LemonadeFacts, lemonadeDot } from './lemonade-status'

const report = (r: Partial<NonNullable<LemonadeFacts['report']>> = {}) => ({
  running: true,
  install: 'found' as const,
  noUserSession: false,
  manualOff: false,
  wanted: null,
  ...r,
})

const pc = (f: Partial<LemonadeFacts> = {}): LemonadeFacts => ({
  name: 'pc',
  offered: true,
  current: true,
  report: report(),
  wanted: null,
  pinned: false,
  updateAvailable: false,
  ...f,
})

describe('the AI row’s dot', () => {
  it('is absent when no machine has Lemonade or is asked to run it', () => {
    expect(lemonadeDot([])).toBeNull()
    expect(lemonadeDot([pc({ report: null })])).toBeNull()
  })

  it('is green when every server that should run runs, current and managed', () => {
    expect(lemonadeDot([pc({ wanted: 'start' }), pc({ name: 'mac' })])).toEqual({
      tone: 'ok',
      reasons: [],
    })
  })

  it('is amber for an update, an unmanaged install, a stale report, nobody logged on, a user quit', () => {
    for (const [f, why] of [
      [{ updateAvailable: true }, 'an update is available'],
      [{ report: report({ install: 'none' }) }, 'an install the agent cannot manage'],
      [
        { report: report({ install: 'unreported' }) },
        'its agent is too old to report the install; update the agent',
      ],
      [{ current: false }, 'no current report'],
      [
        { report: report({ noUserSession: true, running: false }), wanted: 'start' },
        'nobody is logged on',
      ],
      [
        { report: report({ manualOff: true, running: false }), wanted: 'start' },
        'quit by its user',
      ],
      [{ report: null, pinned: true }, 'pinned, not installed'],
    ] as const) {
      expect(lemonadeDot([pc(f as Partial<LemonadeFacts>)])).toEqual({
        tone: 'warn',
        reasons: [`pc: ${why}`],
      })
    }
  })

  it('is red when a server that should run does not, whichever side said so', () => {
    expect(lemonadeDot([pc({ wanted: 'start', report: report({ running: false }) })])?.tone).toBe(
      'bad',
    )
    // The agent's word (the operator's last verb) outranks the policy's.
    expect(
      lemonadeDot([pc({ wanted: 'stop', report: report({ running: false, wanted: 'start' }) })])
        ?.tone,
    ).toBe('bad')
    expect(lemonadeDot([pc({ wanted: 'start', report: null })])).toEqual({
      tone: 'bad',
      reasons: ['pc: wanted, not installed'],
    })
  })

  it('is not red for a server stopped on purpose', () => {
    expect(lemonadeDot([pc({ wanted: 'stop', report: report({ running: false }) })])?.tone).toBe(
      'ok',
    )
  })

  it('takes the worst machine and names every one that wants a look', () => {
    expect(
      lemonadeDot([
        pc({ name: 'mac', updateAvailable: true }),
        pc({ name: 'pc', wanted: 'start', report: report({ running: false }) }),
        pc({ name: 'nuc' }),
      ]),
    ).toEqual({ tone: 'bad', reasons: ['mac: an update is available', 'pc: wanted, not running'] })
  })
})

describe('which machines the dot counts', () => {
  // The MacBook on 2026-10-02: Lemonade 10.9.0 installed for its own use,
  // running, an update out — and offered to nobody.
  const mac = pc({ name: 'mac', offered: false, updateAvailable: true })

  it('leaves out a machine that offers nothing and is asked nothing, whatever it runs', () => {
    expect(lemonadeDot([mac])).toBeNull()
    expect(lemonadeDot([mac, pc()])).toEqual({ tone: 'ok', reasons: [] })
  })

  it('counts an unoffered machine once the box asks it to run or pins a release', () => {
    expect(lemonadeDot([{ ...mac, wanted: 'start' }])?.reasons).toEqual([
      'mac: an update is available',
    ])
    expect(lemonadeDot([{ ...mac, pinned: true }])?.tone).toBe('warn')
    expect(lemonadeDot([{ ...mac, report: report({ wanted: 'stop' }) }])?.tone).toBe('warn')
  })
})

describe('what the agent can say of the install', () => {
  const msi = { method: 'msi' }
  it('is unreported when the agent predates install and power, whatever the report holds', () => {
    expect(installKnown(false, null)).toBe('unreported')
    expect(installKnown(false, undefined)).toBe('unreported')
    expect(installKnown(null, msi)).toBe('unreported')
  })
  it('is none only from an agent that speaks it and found no record', () => {
    expect(installKnown(true, null)).toBe('none')
    expect(installKnown(true, msi)).toBe('found')
  })
})
