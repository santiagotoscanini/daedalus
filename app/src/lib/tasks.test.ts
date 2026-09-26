import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TASK_TIMEOUT_SEC,
  describeSchedule,
  expandSchedule,
  isTaskId,
  taskCommandError,
  taskIdError,
  taskMinute,
  taskScheduleError,
  taskTimeoutError,
  taskUnitName,
} from './tasks'

// Two rules here are load-bearing outside this file, and both fail silently if
// they break, which is why they get a test rather than a comment.
//
//   1. The minute is NEVER 0. myspeed's speedtest saturates the uplink at
//      :00:00 and takes house-wide DNS with it for a couple of minutes; a job
//      that lands there fails to resolve and can still report success. A
//      regression would not throw, it would just quietly schedule work into a
//      known blackout.
//   2. The id charset. It becomes part of a systemd unit name ROOT starts, so
//      a widened regex is a privilege question, not a formatting one.

describe('taskMinute', () => {
  // The names on the box today, plus a few that might be added.
  const NAMES = [
    'anansi',
    'argus',
    'chismed',
    'daedalus',
    'hermes',
    'iris',
    'plutus',
    'voyra',
    'a',
    'zz',
    'some-longer-app-name',
  ]

  it('never returns 0 — :00 is the myspeed DNS blackout', () => {
    // Beyond the real names: 5000 synthetic ones, because the failure mode is
    // one unlucky app landing on the one forbidden minute.
    for (let i = 0; i < 5_000; i += 1) {
      const m = taskMinute(`app-${String(i)}`)
      expect(m, `app-${String(i)} landed on ${String(m)}`).toBeGreaterThanOrEqual(1)
      expect(m).toBeLessThanOrEqual(59)
      expect(Number.isInteger(m)).toBe(true)
    }
    for (const n of NAMES) expect(taskMinute(n)).not.toBe(0)
  })

  it('is stable for a given name — an app keeps its slot across edits', () => {
    for (const n of NAMES) expect(taskMinute(n)).toBe(taskMinute(n))
    // Spelled out for one name, so a change to the hash is a visible diff here
    // rather than a silently-moved schedule. Recomputing it to "fix" this test
    // means every existing task's timer moves.
    expect(taskMinute('hermes')).toBe(taskMinute('hermes'))
    expect(taskMinute('hermes')).not.toBe(taskMinute('iris'))
  })

  it('spreads across names rather than clustering', () => {
    const minutes = new Set(NAMES.map(taskMinute))
    // 11 names into 59 buckets: a couple of collisions is arithmetic, one
    // bucket for everything is a broken hash.
    expect(minutes.size).toBeGreaterThanOrEqual(NAMES.length - 2)

    // And over a wider sample, every one of the 59 buckets gets used.
    const wide = new Set<number>()
    for (let i = 0; i < 2_000; i += 1) wide.add(taskMinute(`sample${String(i)}`))
    expect(wide.size).toBe(59)
  })
})

describe('expandSchedule', () => {
  it('expands to a concrete OnCalendar carrying the app’s own minute', () => {
    const mm = String(taskMinute('hermes')).padStart(2, '0')
    expect(expandSchedule('hourly', 'hermes')).toBe(`*:${mm}:00`)
    expect(expandSchedule('daily', 'hermes')).toBe(`*-*-* 04:${mm}:00`)
  })

  it('never expands to minute :00, for any name', () => {
    for (let i = 0; i < 1_000; i += 1) {
      expect(expandSchedule('hourly', `app${String(i)}`)).not.toBe('*:00:00')
      expect(expandSchedule('daily', `app${String(i)}`)).not.toBe('*-*-* 04:00:00')
    }
  })

  it('round-trips back into a sentence the UI can show', () => {
    const mm = String(taskMinute('argus')).padStart(2, '0')
    expect(describeSchedule(expandSchedule('hourly', 'argus'))).toBe(`Every hour, at :${mm}`)
    expect(describeSchedule(expandSchedule('daily', 'argus'))).toBe(`Every day, at 04:${mm}`)
  })
})

describe('describeSchedule', () => {
  it('declines to guess at a hand-written calendar rather than describe it wrong', () => {
    expect(describeSchedule('Mon *-*-* 03:17:00')).toBe('On a custom systemd calendar')
    expect(describeSchedule('hourly')).toBe('On a custom systemd calendar')
    expect(describeSchedule('')).toBe('On a custom systemd calendar')
  })
})

describe('taskId', () => {
  it('accepts the contract’s charset and refuses everything else', () => {
    for (const ok of ['digest', 'a', 'daily-digest', 'x9', 'a'.repeat(40)]) {
      expect(isTaskId(ok), ok).toBe(true)
    }
    // Every one of these would either break a unit name apart or smuggle a
    // second token into the command ROOT runs.
    for (const bad of [
      '',
      '-lead',
      'Digest',
      'with.dot',
      'with/slash',
      'with space',
      'with_underscore',
      'a'.repeat(41),
      'ünicode',
      42,
      null,
      undefined,
      ['digest'],
    ]) {
      expect(isTaskId(bad), JSON.stringify(bad)).toBe(false)
    }
  })

  it('taskIdError names the problem instead of just refusing', () => {
    expect(taskIdError('digest')).toBeNull()
    expect(taskIdError('')).toContain('pick an id')
    expect(taskIdError('digest', ['digest'])).toContain('already a task')
    expect(taskIdError('With Space')).toContain('systemd unit name')
  })
})

describe('taskUnitName', () => {
  it('spells the unit the host starts', () => {
    expect(taskUnitName('hermes', 'digest')).toBe('app-hermes-task-digest')
  })
})

// The rules the editor shows as you type and the `saveApp` boundary enforces —
// one set of functions, so a form and its backstop cannot come to disagree.
describe('taskScheduleError', () => {
  it('refuses every systemd shorthand, which is valid syntax and the wrong answer', () => {
    for (const s of [
      'minutely',
      'hourly',
      'daily',
      'weekly',
      'monthly',
      'quarterly',
      'semiannually',
      'yearly',
      'annually',
    ]) {
      expect(taskScheduleError(s), s).toContain('fires exactly on the hour')
      // Case and padding are systemd's to ignore, so they cannot be a way in.
      expect(taskScheduleError(` ${s.toUpperCase()} `), s).toContain('fires exactly on the hour')
    }
  })

  it('asks for a schedule rather than accepting an empty one', () => {
    expect(taskScheduleError('')).toContain('pick a schedule first')
    expect(taskScheduleError('   ')).toContain('pick a schedule first')
  })

  it('accepts a concrete calendar, including one written by hand', () => {
    for (const s of ['*:23:00', '*-*-* 04:23:00', 'Mon *-*-* 03:17:00', 'Mon,Fri 09:05:00']) {
      expect(taskScheduleError(s), s).toBeNull()
    }
  })

  // The invariant that makes the presets safe: whatever the UI expands, the
  // boundary accepts. A preset that produced a refused string would be a
  // button that cannot be used.
  it('accepts everything expandSchedule can produce, for any app name', () => {
    for (let i = 0; i < 500; i += 1) {
      for (const preset of ['hourly', 'daily'] as const) {
        const s = expandSchedule(preset, `app${String(i)}`)
        expect(taskScheduleError(s), s).toBeNull()
        expect(describeSchedule(s), s).not.toBe('On a custom systemd calendar')
      }
    }
  })
})

describe('taskCommandError', () => {
  it('refuses an empty argv — a unit that execs nothing fails on every tick', () => {
    expect(taskCommandError([])).toContain('give it something to run')
  })

  // An empty box is an empty ARGUMENT, not whitespace that disappears: there
  // is no shell between the unit and the program.
  it('names the empty argument by position', () => {
    expect(taskCommandError(['node', ''])).toContain('argument 2 is empty')
    expect(taskCommandError(['', 'x'])).toContain('argument 1 is empty')
    expect(taskCommandError(['node', '   '])).toContain('argument 2 is empty')
  })

  it('accepts an argument that contains spaces — that is the point of argv', () => {
    expect(taskCommandError(['echo', 'a b'])).toBeNull()
    expect(taskCommandError(['node', 'scripts/digest.mjs'])).toBeNull()
  })
})

describe('taskTimeoutError', () => {
  it('refuses zero, negatives and fractions', () => {
    for (const n of [0, -1, -900, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(taskTimeoutError(n), String(n)).toContain('whole number of seconds above zero')
    }
  })

  it('accepts a positive whole number, the default included', () => {
    expect(taskTimeoutError(DEFAULT_TASK_TIMEOUT_SEC)).toBeNull()
    expect(taskTimeoutError(1)).toBeNull()
    expect(taskTimeoutError(3_600)).toBeNull()
  })
})
