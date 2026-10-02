import { describe, expect, it } from 'vitest'
import { type LemonadeFacts, lemonadeDot } from './lemonade-status'

const report = (r: Partial<NonNullable<LemonadeFacts['report']>> = {}) => ({
  running: true,
  managed: true,
  noUserSession: false,
  manualOff: false,
  wanted: null,
  ...r,
})

const pc = (f: Partial<LemonadeFacts> = {}): LemonadeFacts => ({
  name: 'pc',
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
      [{ report: report({ managed: false }) }, 'an install the agent cannot manage'],
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
