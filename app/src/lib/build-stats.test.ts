import { describe, expect, it } from 'vitest'
import { type BuildStatRow, buildStats, firstLine, median } from './build-stats'

const row = (over: Partial<BuildStatRow> = {}): BuildStatRow => ({
  id: 'b1',
  app: 'alpha',
  sha: 'aaaaaaa000000000000000000000000000000001',
  state: 'succeeded',
  publish: 'live',
  phase: 'done',
  error: null,
  timings: { cloning: 4000, detecting: 1000, checking: 20000, building: 9000, publishing: 500 },
  createdAt: '2026-09-20T10:00:00.000Z',
  startedAt: '2026-09-20T10:00:05.000Z',
  updatedAt: '2026-09-20T10:01:05.000Z',
  ...over,
})

describe('median', () => {
  it('takes the middle value, or the mean of the two middles', () => {
    expect(median([])).toBeNull()
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 3, 2])).toBe(2.5)
  })
})

describe('firstLine', () => {
  it('returns the first non-empty line, trimmed', () => {
    expect(firstLine(null)).toBeNull()
    expect(firstLine('\n  \n  checks failed: exit 1  \nmore')).toBe('checks failed: exit 1')
    expect(firstLine('   ')).toBeNull()
  })
})

describe('buildStats', () => {
  it('counts per app, with a success rate that ignores cancelled and superseded builds', () => {
    const s = buildStats([
      row({ id: '1' }),
      row({ id: '2', state: 'failed', error: 'boom' }),
      row({ id: '3', state: 'cancelled' }),
      row({ id: '4', state: 'superseded', startedAt: null }),
      row({ id: '5', app: 'beta' }),
    ])
    expect(s.total).toBe(5)
    expect(s.succeeded).toBe(2)
    expect(s.failed).toBe(1)
    expect(s.successRate).toBeCloseTo(2 / 3)
    const alpha = s.apps.find((a) => a.app === 'alpha')
    expect(alpha).toMatchObject({ total: 4, succeeded: 1, failed: 1, successRate: 0.5 })
    expect(s.apps[0]?.app).toBe('alpha')
  })

  it('takes the median duration of the succeeded builds only', () => {
    const s = buildStats([
      row({ id: '1', updatedAt: '2026-09-20T10:00:15.000Z' }), // 10 s
      row({ id: '2', updatedAt: '2026-09-20T10:00:35.000Z' }), // 30 s
      row({ id: '3', updatedAt: '2026-09-20T10:01:05.000Z' }), // 60 s
      row({ id: '4', state: 'failed', updatedAt: '2026-09-20T11:00:05.000Z' }),
    ])
    expect(s.apps[0]?.medianMs).toBe(30_000)
    expect(s.medianMs).toBe(30_000)
  })

  it('has no rate and no median for an app with nothing finished', () => {
    const s = buildStats([row({ state: 'cancelled' })])
    expect(s.apps[0]).toMatchObject({ successRate: null, medianMs: null })
    expect(s.successRate).toBeNull()
  })

  it('medians every stage a build finished, failed builds included, in pipeline order', () => {
    const s = buildStats([
      row({ id: '1', timings: { cloning: 2000, detecting: 1000 } }),
      row({ id: '2', timings: { cloning: 4000 }, state: 'failed' }),
      row({ id: '3', timings: { clone: 6000, check: 30000 } }),
    ])
    expect(s.stages.map((x) => x.phase)).toEqual([
      'cloning',
      'detecting',
      'checking',
      'building',
      'publishing',
    ])
    expect(s.stages[0]).toEqual({ phase: 'cloning', medianMs: 4000, count: 3 })
    expect(s.stages[2]).toEqual({ phase: 'checking', medianMs: 30000, count: 1 })
    expect(s.stages[4]).toEqual({ phase: 'publishing', medianMs: null, count: 0 })
  })

  it('lists the newest failures with the stage they died in and the first error line', () => {
    const s = buildStats(
      [
        row({
          id: 'old',
          state: 'failed',
          createdAt: '2026-09-01T00:00:00.000Z',
          timings: { cloning: 1000 },
          error: '\ndetect: no start command\ntrace…',
        }),
        row({
          id: 'new',
          state: 'failed',
          createdAt: '2026-09-02T00:00:00.000Z',
          timings: { cloning: 1000, detecting: 900, checking: 3000 },
          error: 'build: exit 2',
        }),
        row({ id: 'ok' }),
      ],
      1,
    )
    expect(s.failures).toEqual([
      expect.objectContaining({ id: 'new', phase: 'building', error: 'build: exit 2' }),
    ])
    expect(
      buildStats([row({ id: 'old', state: 'failed', timings: { cloning: 1 } })]).failures[0],
    ).toMatchObject({ phase: 'detecting' })
  })

  it('takes the failing stage from the row when it names one, and keeps it out of the medians', () => {
    const s = buildStats([
      row({
        state: 'failed',
        phase: 'checking',
        timings: { cloning: 3000, detecting: 500, checking: 1_800_000 },
        error: 'checks timed out after 30m',
      }),
    ])
    expect(s.failures[0]?.phase).toBe('checking')
    expect(s.stages.find((x) => x.phase === 'checking')).toMatchObject({ count: 0, medianMs: null })
    expect(s.stages.find((x) => x.phase === 'cloning')).toMatchObject({ count: 1 })
  })
})
