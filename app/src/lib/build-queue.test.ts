import { describe, expect, it } from 'vitest'
import { detectionFromStatus } from './build-detect'
import {
  applyStatus,
  type BuildRow,
  CANCELLED_BY_OPERATOR,
  ENGINE_VERDICT_RETRIES,
  type EnqueueRequest,
  enqueue,
  enqueueSkip,
  failedTip,
  INTERRUPTED,
  markDispatched,
  nextToRun,
  reconcile,
  TIMED_OUT,
} from './build-queue'
import type { BuildStatus } from './builds'

const T0 = new Date('2026-09-11T20:00:00Z')
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000)

const SHA_A = 'aaaaaaa000000000000000000000000000000001'
const SHA_B = 'bbbbbbb000000000000000000000000000000002'
const SHA_C = 'ccccccc000000000000000000000000000000003'

let seq = 0
function row(over: Partial<BuildRow> = {}): BuildRow {
  seq += 1
  return {
    id: `0000000${String(seq)}`,
    appId: 'app-iris',
    app: 'iris',
    lane: 'main',
    prNumber: null,
    sha: SHA_A,
    strategy: 'auto',
    resolvedStrategy: null,
    publish: 'live',
    requestedBy: 'webhook',
    actor: null,
    deliveryId: null,
    state: 'queued',
    phase: '',
    error: null,
    detected: null,
    warnings: null,
    facts: null,
    checks: null,
    digest: null,
    imageRef: null,
    sizeBytes: null,
    timings: {},
    checkRunId: null,
    deploymentId: null,
    reported: false,
    createdAt: T0,
    startedAt: null,
    updatedAt: T0,
    ...over,
  }
}

function req(over: Partial<EnqueueRequest> = {}): EnqueueRequest {
  return {
    id: 'ffffffff',
    appId: 'app-iris',
    app: 'iris',
    lane: 'main',
    prNumber: null,
    sha: SHA_B,
    strategy: 'auto',
    publish: 'live',
    requestedBy: 'webhook',
    at: at(60),
    ...over,
  }
}

function status(over: Partial<BuildStatus> = {}): BuildStatus {
  return {
    version: 1,
    id: '00000001',
    app: 'iris',
    sha: SHA_A,
    state: 'building',
    phase: 'building image',
    strategy: 'railpack',
    tip: null,
    digest: null,
    imageRef: null,
    sizeBytes: null,
    pinned: false,
    candidate: false,
    detected: null,
    repo: null,
    image: null,
    build: null,
    checks: null,
    error: null,
    timings: {},
    updatedAt: at(30).toISOString(),
    ...over,
  }
}

describe('enqueue', () => {
  it('queues into an empty lane', () => {
    const { rows, result } = enqueue([], req({ actor: 'santiago', deliveryId: 'd-1' }))
    expect(result).toMatchObject({ kind: 'enqueued', superseded: [] })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: 'ffffffff',
      state: 'queued',
      sha: SHA_B,
      startedAt: null,
      actor: 'santiago',
      deliveryId: 'd-1',
      resolvedStrategy: null,
      warnings: null,
      facts: null,
      checkRunId: null,
      deploymentId: null,
      reported: false,
    })
  })

  it('supersedes a queued row of the same app and lane with the new sha', () => {
    const old = row({ sha: SHA_A })
    const { rows, result } = enqueue([old], req({ sha: SHA_B }))
    expect(result).toMatchObject({ kind: 'enqueued', superseded: [old.id] })
    expect(rows.find((r) => r.id === old.id)).toMatchObject({
      state: 'superseded',
      phase: 'superseded by bbbbbbb',
    })
    expect(rows.filter((r) => r.state === 'queued').map((r) => r.sha)).toEqual([SHA_B])
  })

  it('leaves queued rows of other apps and other lanes alone', () => {
    const otherApp = row({ appId: 'app-hermes', app: 'hermes' })
    const prLane = row({ lane: 'pr', prNumber: 12 })
    const { rows } = enqueue([otherApp, prLane], req())
    expect(rows.filter((r) => r.state === 'queued')).toHaveLength(3)
  })

  it('is a no-op for a sha already queued', () => {
    const queued = row({ sha: SHA_B })
    const before = [queued]
    const { rows, result } = enqueue(before, req({ sha: SHA_B }))
    expect(result).toEqual({ kind: 'skipped', reason: 'already-queued', existingId: queued.id })
    expect(rows).toBe(before)
  })

  it('is a no-op for a sha already running', () => {
    const running = row({ sha: SHA_B, state: 'checking', startedAt: T0 })
    const { rows, result } = enqueue([running], req({ sha: SHA_B }))
    expect(result).toEqual({ kind: 'skipped', reason: 'already-running', existingId: running.id })
    expect(rows).toEqual([running])
  })

  it('never touches a running row, even for a newer sha', () => {
    const running = row({ sha: SHA_A, state: 'building', startedAt: T0 })
    const { rows, result } = enqueue([running], req({ sha: SHA_B }))
    expect(result).toMatchObject({ kind: 'enqueued', superseded: [] })
    expect(rows[0]).toBe(running)
  })

  it('skips a sha whose last successful build is that sha', () => {
    const built = row({ sha: SHA_B, state: 'succeeded' })
    const { result } = enqueue([built], req({ sha: SHA_B }))
    expect(result).toEqual({ kind: 'skipped', reason: 'already-built', existingId: built.id })
  })

  it('builds it again when forced', () => {
    const built = row({ sha: SHA_B, state: 'succeeded' })
    expect(enqueue([built], req({ sha: SHA_B, force: true })).result.kind).toBe('enqueued')
  })

  it('rebuilds a sha whose success was not the last one', () => {
    const olderB = row({ sha: SHA_B, state: 'succeeded', createdAt: at(-600) })
    const newerC = row({ sha: SHA_C, state: 'succeeded', createdAt: at(-300) })
    expect(enqueue([olderB, newerC], req({ sha: SHA_B })).result.kind).toBe('enqueued')
  })

  it('does not count a candidate build as the live build of that sha', () => {
    const candidate = row({ sha: SHA_B, state: 'succeeded', publish: 'candidate' })
    expect(enqueue([candidate], req({ sha: SHA_B, publish: 'live' })).result.kind).toBe('enqueued')
  })

  it('does not count a failed build as built', () => {
    const failed = row({ sha: SHA_B, state: 'failed' })
    expect(enqueue([failed], req({ sha: SHA_B })).result.kind).toBe('enqueued')
  })
})

describe('enqueueSkip', () => {
  it('names why a sha need not be queued, and agrees with enqueue', () => {
    const running = row({ sha: SHA_A, state: 'building', startedAt: T0 })
    const queued = row({ sha: SHA_B })
    const built = row({ sha: SHA_C, state: 'succeeded' })
    const rows = [running, queued, built]

    expect(enqueueSkip(rows, req({ sha: SHA_A }))).toEqual({
      reason: 'already-running',
      existingId: running.id,
    })
    expect(enqueueSkip(rows, req({ sha: SHA_B }))).toEqual({
      reason: 'already-queued',
      existingId: queued.id,
    })
    expect(enqueueSkip(rows, req({ sha: SHA_C }))).toEqual({
      reason: 'already-built',
      existingId: built.id,
    })
    for (const sha of [SHA_A, SHA_B, SHA_C]) {
      expect(enqueue(rows, req({ sha })).result.kind).toBe('skipped')
    }
  })

  it('lets force past only the built rule, and keeps to its app, lane and publish mode', () => {
    const running = row({ sha: SHA_A, state: 'building', startedAt: T0 })
    const built = row({ sha: SHA_C, state: 'succeeded' })
    const rows = [running, built]
    expect(enqueueSkip(rows, req({ sha: SHA_C, force: true }))).toBeNull()
    expect(enqueueSkip(rows, req({ sha: SHA_A, force: true }))?.reason).toBe('already-running')
    expect(enqueueSkip(rows, req({ sha: SHA_C, publish: 'candidate' }))).toBeNull()
    expect(enqueueSkip(rows, req({ sha: SHA_A, appId: 'app-hermes' }))).toBeNull()
    expect(enqueueSkip(rows, req({ sha: SHA_A, lane: 'pr' }))).toBeNull()
  })
})

describe('the sweep does not rebuild a failed tip', () => {
  const sweep = (over: Partial<EnqueueRequest> = {}) =>
    req({ sha: SHA_B, requestedBy: 'sweep', ...over })

  it('skips a sha whose newest build failed or was cancelled', () => {
    const failed = row({ sha: SHA_B, state: 'failed', error: 'check failed: lint' })
    expect(enqueueSkip([failed], sweep())).toEqual({
      reason: 'already-failed',
      existingId: failed.id,
    })
    expect(enqueue([failed], sweep()).result.kind).toBe('skipped')
    const cancelled = row({ sha: SHA_B, state: 'cancelled', error: 'box builds off' })
    expect(enqueueSkip([cancelled], sweep())?.reason).toBe('already-failed')
    const refused = row({ sha: SHA_B, state: 'failed', error: 'request refused: too large' })
    expect(enqueueSkip([refused], sweep())?.reason).toBe('already-failed')
  })

  it('still builds it for a push, for Build now, and when forced', () => {
    const failed = row({ sha: SHA_B, state: 'failed', error: 'check failed: lint' })
    expect(enqueueSkip([failed], sweep({ requestedBy: 'webhook' }))).toBeNull()
    expect(enqueueSkip([failed], sweep({ requestedBy: 'operator' }))).toBeNull()
    expect(enqueueSkip([failed], sweep({ force: true }))).toBeNull()
  })

  it('reads only the newest finished build of that sha, app, lane and publish mode', () => {
    const olderFailed = row({ sha: SHA_B, state: 'failed', error: 'x', createdAt: at(-600) })
    const newerSuperseded = row({ sha: SHA_B, state: 'superseded', createdAt: at(-60) })
    expect(enqueueSkip([olderFailed, newerSuperseded], sweep())).toBeNull()
    expect(
      enqueueSkip([row({ sha: SHA_B, state: 'failed', publish: 'candidate' })], sweep()),
    ).toBeNull()
    expect(enqueueSkip([row({ sha: SHA_C, state: 'failed' })], sweep())).toBeNull()
    expect(
      enqueueSkip([row({ sha: SHA_B, state: 'failed', appId: 'app-hermes' })], sweep()),
    ).toBeNull()
    expect(enqueueSkip([row({ sha: SHA_B, state: 'failed', lane: 'pr' })], sweep())).toBeNull()
  })

  it.each([INTERRUPTED, TIMED_OUT])(
    'gives a sha the engine failed as %s one more try, and one only',
    (verdict) => {
      expect(ENGINE_VERDICT_RETRIES).toBe(1)
      const first = row({ sha: SHA_B, state: 'failed', error: verdict, createdAt: at(-3600) })
      expect(failedTip([first], sweep())).toBeNull()
      expect(enqueueSkip([first], sweep())).toBeNull()

      const again = row({ sha: SHA_B, state: 'failed', error: INTERRUPTED, createdAt: at(-60) })
      expect(enqueueSkip([first, again], sweep())).toEqual({
        reason: 'already-failed',
        existingId: again.id,
      })
      const hostWord = row({
        sha: SHA_B,
        state: 'failed',
        error: 'building: OOM',
        createdAt: at(-60),
      })
      expect(enqueueSkip([first, hostWord], sweep())?.reason).toBe('already-failed')
    },
  )
})

describe('nextToRun', () => {
  const manifest = new Set(['iris', 'hermes'])

  it('returns nothing while a build is in flight', () => {
    const next = nextToRun([row()], { inManifest: manifest, inFlight: true })
    expect(next.row).toBeNull()
    expect(next.blockedBy).toBe('in-flight')
  })

  it('returns nothing while any row is running', () => {
    const next = nextToRun([row(), row({ app: 'hermes', appId: 'h', state: 'publishing' })], {
      inManifest: manifest,
      inFlight: false,
    })
    expect(next.row).toBeNull()
    expect(next.blockedBy).toBe('in-flight')
  })

  it('runs the oldest queued row', () => {
    const newer = row({ createdAt: at(10) })
    const older = row({ app: 'hermes', appId: 'h', createdAt: at(5) })
    expect(nextToRun([newer, older], { inManifest: manifest, inFlight: false }).row).toBe(older)
  })

  it('runs the main lane before an older PR lane', () => {
    const pr = row({ lane: 'pr', prNumber: 7, createdAt: at(0) })
    const main = row({ app: 'hermes', appId: 'h', createdAt: at(100) })
    expect(nextToRun([pr, main], { inManifest: manifest, inFlight: false }).row).toBe(main)
  })

  it('holds an app not yet in the manifest, says why, and runs the next one', () => {
    const unapplied = row({ app: 'voyra', appId: 'v', createdAt: at(0) })
    const ready = row({ createdAt: at(50) })
    const next = nextToRun([unapplied, ready], { inManifest: manifest, inFlight: false })
    expect(next.row).toBe(ready)
    expect(next.held).toHaveLength(1)
    expect(next.held[0]?.row).toBe(unapplied)
    expect(next.held[0]?.reason).toMatch(/voyra is not in the applied app manifest/)
  })

  it('returns nothing when every queued row is held', () => {
    const next = nextToRun([row({ app: 'voyra', appId: 'v' })], {
      inManifest: manifest,
      inFlight: false,
    })
    expect(next).toMatchObject({ row: null, blockedBy: null })
    expect(next.held).toHaveLength(1)
  })

  it('ignores finished rows', () => {
    const next = nextToRun([row({ state: 'succeeded' }), row({ state: 'superseded' })], {
      inManifest: manifest,
      inFlight: false,
    })
    expect(next.row).toBeNull()
  })
})

describe('markDispatched', () => {
  it('takes the row out of the queue so the lane can queue again', () => {
    const r = markDispatched(row(), at(5))
    expect(r).toMatchObject({ state: 'cloning', phase: 'requested', startedAt: at(5) })
    expect(enqueue([r], req({ sha: SHA_B })).result).toMatchObject({ superseded: [] })
  })
})

describe('applyStatus', () => {
  const running = () => row({ id: '00000001', state: 'cloning', startedAt: T0 })

  it('ignores a status for another build', () => {
    const r = running()
    expect(applyStatus(r, status({ id: '99999999' }))).toBe(r)
    expect(applyStatus(r, null)).toBe(r)
  })

  it('maps state, digest, checks and timings onto the row', () => {
    const r = applyStatus(
      running(),
      status({
        state: 'succeeded',
        phase: 'done',
        digest: 'sha256:abc',
        imageRef: 'registry.toscanini.me/iris:sha-a',
        sizeBytes: 1234,
        checks: { ran: ['ci'], failed: null },
        timings: { cloning: 900, building: 45_000 },
      }),
    )
    expect(r).toMatchObject({
      state: 'succeeded',
      phase: 'done',
      strategy: 'auto',
      resolvedStrategy: 'railpack',
      digest: 'sha256:abc',
      imageRef: 'registry.toscanini.me/iris:sha-a',
      sizeBytes: 1234,
      checks: { ran: ['ci'], failed: null },
      timings: { cloning: 900, building: 45_000 },
      updatedAt: at(30),
    })
  })

  it('keeps the detection raw, as the host copied it; it decodes on read', () => {
    const detected = {
      info: {
        success: true,
        detectedProviders: ['node'],
        metadata: { providers: 'node', nodeRuntime: 'tanstack-start' },
        resolvedPackages: {
          node: {
            name: 'node',
            requestedVersion: '24.18.1',
            resolvedVersion: '24.18.1',
            source: 'custom config',
          },
        },
      },
      plan: { deploy: { startCommand: 'node start.mjs' } },
    }
    const warnings = [{ code: 'railpack', message: 'cached' }] as const
    const r = applyStatus(
      { ...running(), warnings: [...warnings] },
      status({ state: 'checking', detected }),
    )
    expect(r.detected).toBe(detected)
    expect(detectionFromStatus(r.detected)).toMatchObject({
      provider: 'node',
      framework: 'tanstack-start',
      node: { version: '24.18.1', source: 'custom config' },
      startCommand: 'node start.mjs',
    })
    // The warnings cache is the scheduler's to write; a status never clears it.
    expect(r.warnings).toEqual(warnings)
    // A later status without a detection keeps the one the row has.
    expect(applyStatus(r, status({ state: 'building' })).detected).toBe(detected)
  })

  it('never overwrites the requested strategy; fills resolvedStrategy once the host resolves it', () => {
    const before = applyStatus(running(), status({ strategy: 'auto' }))
    expect(before).toMatchObject({ strategy: 'auto', resolvedStrategy: null })
    const after = applyStatus(before, status({ strategy: 'dockerfile' }))
    expect(after).toMatchObject({ strategy: 'auto', resolvedStrategy: 'dockerfile' })
    expect(applyStatus(after, status({ strategy: 'auto' })).resolvedStrategy).toBe('dockerfile')
    const forced = row({ id: '00000001', state: 'cloning', strategy: 'railpack' })
    expect(applyStatus(forced, status({ strategy: 'railpack' }))).toMatchObject({
      strategy: 'railpack',
      resolvedStrategy: 'railpack',
    })
  })

  it("keeps a dispatched row in flight on the host's queued", () => {
    expect(applyStatus(running(), status({ state: 'queued' })).state).toBe('cloning')
    expect(applyStatus(row({ id: '00000001' }), status({ state: 'queued' })).state).toBe('cloning')
  })
})

describe('the terminal rule: the host is the source of truth', () => {
  const verdict = (error: string) =>
    row({ id: '00000001', state: 'failed', error, reported: true, startedAt: T0 })

  it.each([INTERRUPTED, TIMED_OUT])(
    "lets the host's final word replace an engine verdict (%s), and re-reports it",
    (error) => {
      const r = applyStatus(verdict(error), status({ state: 'succeeded', digest: 'sha256:abc' }))
      expect(r).toMatchObject({
        state: 'succeeded',
        error: null,
        digest: 'sha256:abc',
        reported: false,
      })
    },
  )

  it('lets the host fail an engine-failed build with its own reason', () => {
    const r = applyStatus(
      verdict(INTERRUPTED),
      status({ state: 'failed', error: 'checks failed: lint' }),
    )
    expect(r).toMatchObject({ state: 'failed', error: 'checks failed: lint', reported: false })
  })

  it('does not re-report when the host says what the engine already said', () => {
    const r = verdict(INTERRUPTED)
    expect(applyStatus(r, status({ state: 'failed', error: INTERRUPTED }))).toBe(r)
  })

  it('overrides once, however many ticks re-read the same status', () => {
    const s = status({ state: 'succeeded' })
    const reportedAgain = { ...applyStatus(verdict(TIMED_OUT), s), reported: true }
    expect(applyStatus(reportedAgain, s)).toBe(reportedAgain)
  })

  it('never reopens an engine verdict on a non-terminal status', () => {
    const r = verdict(INTERRUPTED)
    expect(applyStatus(r, status({ state: 'publishing' }))).toBe(r)
  })

  it('ignores a terminal status for another build', () => {
    const r = verdict(INTERRUPTED)
    expect(applyStatus(r, status({ id: '99999999', state: 'succeeded' }))).toBe(r)
  })

  it.each([
    ['failed by the host', { state: 'failed', error: 'checks failed: lint' }],
    ['succeeded', { state: 'succeeded', error: null }],
    ['cancelled', { state: 'cancelled', error: null }],
    ['superseded', { state: 'superseded', error: null }],
  ] as const)('keeps a row %s final', (_, over) => {
    const r = row({ id: '00000001', startedAt: T0, ...over })
    expect(applyStatus(r, status({ state: 'failed', error: 'late' }))).toBe(r)
    expect(applyStatus(r, status({ state: 'succeeded' }))).toBe(r)
    expect(applyStatus(r, status({ state: 'building' }))).toBe(r)
  })

  it('keeps a cancel the operator asked for, whatever the reaper says next', () => {
    // `systemctl stop` reaches the host's reaper as `interrupted` — the same
    // word a crash and an OOM kill produce. The row is marked `cancelled` when
    // the stop is asked for, and that word has to survive the reaper's.
    const cancelled = row({
      id: '00000001',
      state: 'cancelled',
      phase: 'cancelled',
      error: CANCELLED_BY_OPERATOR,
      startedAt: T0,
    })
    const late = status({ state: 'failed', error: INTERRUPTED })
    expect(applyStatus(cancelled, late)).toBe(cancelled)

    // No tick reopens it, and the sha is not retried behind the operator's back.
    const { rows, changed } = reconcile([cancelled], late, at(600))
    expect(rows[0]).toBe(cancelled)
    expect(changed).toEqual([])
    expect(
      failedTip([cancelled], { appId: 'app-iris', lane: 'main', sha: SHA_A, publish: 'live' }),
    ).toBe(cancelled)
  })
})

describe('reconcile', () => {
  const dispatched = (secondsAgo: number, now: number) =>
    markDispatched(row({ id: '00000001' }), at(now - secondsAgo))

  it('fails a running row the host never picked up after 90 s', () => {
    const { rows, changed } = reconcile([dispatched(120, 1000)], null, at(1000))
    expect(rows[0]).toMatchObject({ state: 'failed', error: 'interrupted' })
    expect(changed).toEqual(['00000001'])
  })

  it('gives a just-dispatched row time to be picked up', () => {
    const r = dispatched(30, 1000)
    const { rows, changed } = reconcile([r], status({ id: 'other' }), at(1000))
    expect(rows[0]).toBe(r)
    expect(changed).toEqual([])
  })

  it('keeps a running row whose status is fresh', () => {
    const s = status({ state: 'checking', updatedAt: at(980).toISOString() })
    const { rows } = reconcile([dispatched(600, 1000)], s, at(1000))
    expect(rows[0]).toMatchObject({ state: 'checking', error: null })
  })

  it('fails a running row whose status stopped 91 s ago', () => {
    const s = status({ state: 'building', updatedAt: at(909).toISOString() })
    const { rows } = reconcile([dispatched(600, 1000)], s, at(1000))
    expect(rows[0]).toMatchObject({
      state: 'failed',
      error: 'interrupted',
      phase: 'building image',
    })
  })

  it('fails anything past the 100-minute hard cap, however fresh its status', () => {
    const now = 101 * 60
    const s = status({ state: 'building', updatedAt: at(now - 5).toISOString() })
    const { rows } = reconcile([dispatched(101 * 60, now)], s, at(now))
    expect(rows[0]).toMatchObject({ state: 'failed', error: 'timed out' })
  })

  it("takes the host's late final word over its own interrupted verdict on a later tick", () => {
    const failed = reconcile([dispatched(120, 1000)], null, at(1000)).rows
    const late = status({ state: 'succeeded', updatedAt: at(1010).toISOString() })
    const { rows, changed } = reconcile(failed, late, at(1020))
    expect(rows[0]).toMatchObject({ state: 'succeeded', error: null, reported: false })
    expect(changed).toEqual(['00000001'])
  })

  it('leaves queued and finished rows alone however old', () => {
    const queued = row({ createdAt: at(-99_999), updatedAt: at(-99_999) })
    const done = row({ state: 'succeeded', updatedAt: at(-99_999) })
    const { rows, changed } = reconcile([queued, done], null, at(0))
    expect(rows).toEqual([queued, done])
    expect(changed).toEqual([])
  })

  it('yields an intent to build the tip when the host supersedes a build', () => {
    const r = dispatched(20, 100)
    const s = status({ state: 'superseded', tip: SHA_C, updatedAt: at(99).toISOString() })
    const { rows, intents } = reconcile([r], s, at(100))
    expect(rows[0]?.state).toBe('superseded')
    expect(intents).toEqual([
      {
        appId: 'app-iris',
        app: 'iris',
        lane: 'main',
        prNumber: null,
        sha: SHA_C,
        strategy: 'auto',
        publish: 'live',
        requestedBy: 'webhook',
      },
    ])
  })

  it('yields the intent once, not on every tick', () => {
    const s = status({ state: 'superseded', tip: SHA_C, updatedAt: at(99).toISOString() })
    const first = reconcile([dispatched(20, 100)], s, at(100))
    expect(reconcile(first.rows, s, at(110)).intents).toEqual([])
  })

  it('yields no intent for a finished row the superseded status cannot move', () => {
    const s = status({ state: 'superseded', tip: SHA_C, updatedAt: at(99).toISOString() })
    for (const over of [
      { state: 'failed', error: 'checks failed: lint' },
      { state: 'succeeded', error: null },
      { state: 'cancelled', error: null },
    ] as const) {
      const finished = row({ id: '00000001', startedAt: T0, ...over })
      const { rows, intents } = reconcile([finished], s, at(100))
      expect(rows[0]).toBe(finished)
      expect(intents).toEqual([])
    }
  })

  it("yields the intent when the host's superseded replaces an engine verdict", () => {
    const verdict = row({ id: '00000001', state: 'failed', error: INTERRUPTED, startedAt: T0 })
    const s = status({ state: 'superseded', tip: SHA_C, updatedAt: at(99).toISOString() })
    const { rows, intents } = reconcile([verdict], s, at(100))
    expect(rows[0]?.state).toBe('superseded')
    expect(intents.map((i) => i.sha)).toEqual([SHA_C])
  })

  it('yields no intent without a tip, or when the tip is the same sha', () => {
    const noTip = status({ state: 'superseded', tip: null })
    const sameTip = status({ state: 'superseded', tip: SHA_A })
    expect(reconcile([dispatched(20, 100)], noTip, at(100)).intents).toEqual([])
    expect(reconcile([dispatched(20, 100)], sameTip, at(100)).intents).toEqual([])
  })
})
