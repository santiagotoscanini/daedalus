import { describe, expect, it } from 'vitest'
import {
  ACTIVE_BUILD_STATES,
  BUILD_STATES,
  type BuildState,
  isActiveBuildState,
  isTerminalBuildState,
  TERMINAL_BUILD_STATES,
} from './builds'

// The partition nothing else checks.
//
// `BUILD_STATES` is split three ways — queued, active, terminal — by two
// separate arrays in builds.ts and the word `queued` written by hand in the
// queries that need it. Nothing in the language ties the three to the union
// they are supposed to cover, so an eleventh state added to `BUILD_STATES`
// typechecks everywhere while `isActiveBuildState` and `isTerminalBuildState`
// both answer false for it. That row is then neither running nor finished: the
// reaper's `notInArray(state, TERMINAL_BUILD_STATES)` sees it as open forever,
// the staleness sweep's `inArray(state, ACTIVE_BUILD_STATES)` never looks at
// it, and the build sits in the list until someone deletes it by hand.
//
// The check is deliberately in a file of its own rather than in builds.test.ts:
// it is about the vocabulary as a whole, and it is the kind of test whose
// failure message should name the state nobody classified.

/** The three buckets, one entry per state. */
type Bucket = 'queued' | 'active' | 'terminal'

/**
 * Every state, said once, by hand.
 *
 * This is the type-level half: `Record<BuildState, Bucket>` will not compile
 * with a state missing, and `noUncheckedIndexedAccess` plus the exact key set
 * means it will not compile with an invented one either. So a new member of
 * `BUILD_STATES` is a compile error HERE — at the one place that says which
 * side of the partition it belongs on — before it is ever a runtime question.
 * The assertions below then prove builds.ts agrees with this table.
 */
const BUCKET: Record<BuildState, Bucket> = {
  queued: 'queued',
  cloning: 'active',
  detecting: 'active',
  checking: 'active',
  building: 'active',
  publishing: 'active',
  succeeded: 'terminal',
  failed: 'terminal',
  cancelled: 'terminal',
  superseded: 'terminal',
}

const bucketed = (b: Bucket): BuildState[] => BUILD_STATES.filter((s) => BUCKET[s] === b)

describe('the build state partition', () => {
  it('classifies every state exactly once', () => {
    const unclassified = BUILD_STATES.filter(
      (s) =>
        !ACTIVE_BUILD_STATES.includes(s) && !TERMINAL_BUILD_STATES.includes(s) && s !== 'queued',
    )
    expect(unclassified, `neither active, terminal nor queued: ${unclassified.join(', ')}`).toEqual(
      [],
    )

    const both = BUILD_STATES.filter(
      (s) => ACTIVE_BUILD_STATES.includes(s) && TERMINAL_BUILD_STATES.includes(s),
    )
    expect(both, `both active and terminal: ${both.join(', ')}`).toEqual([])

    // The counts, stated separately: a partition that covers the union and
    // never overlaps still has to be the whole union and nothing more.
    expect(ACTIVE_BUILD_STATES.length + TERMINAL_BUILD_STATES.length + 1).toBe(BUILD_STATES.length)
  })

  it('puts each state on the side the vocabulary says it is on', () => {
    expect([...ACTIVE_BUILD_STATES]).toEqual(bucketed('active'))
    expect([...TERMINAL_BUILD_STATES]).toEqual(bucketed('terminal'))
    expect(bucketed('queued')).toEqual(['queued'])
  })

  it('answers the two predicates consistently for every state', () => {
    for (const s of BUILD_STATES) {
      expect(isActiveBuildState(s), s).toBe(BUCKET[s] === 'active')
      expect(isTerminalBuildState(s), s).toBe(BUCKET[s] === 'terminal')
      // `queued` is the one state both predicates deny, and the scheduler
      // depends on that: it is what "handed to nobody yet" looks like.
      expect(isActiveBuildState(s) || isTerminalBuildState(s), s).toBe(s !== 'queued')
    }
  })
})
