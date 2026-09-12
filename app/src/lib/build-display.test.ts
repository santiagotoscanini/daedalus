import { describe, expect, it } from 'vitest'
import type { Detection } from './build-detect'
import {
  type BuildSummary,
  buildDurationMs,
  buildTags,
  buildTimeline,
  deployOutcome,
  detectionParts,
  pushedTags,
  reportFailureText,
  sameDigest,
} from './build-display'

const SHA = 'aaaaaaa000000000000000000000000000000001'

const summary = (over: Partial<BuildSummary> = {}): BuildSummary => ({
  id: 'b1',
  sha: SHA,
  state: 'succeeded',
  phase: '',
  requestedBy: 'webhook',
  actor: null,
  strategy: 'auto',
  resolvedStrategy: 'railpack',
  publish: 'live',
  error: null,
  createdAt: '2026-09-12T10:00:00Z',
  startedAt: '2026-09-12T10:00:05Z',
  updatedAt: '2026-09-12T10:03:05Z',
  ...over,
})

describe('buildDurationMs', () => {
  it('measures a finished build from hand-off to its last word', () => {
    expect(buildDurationMs(summary())).toBe(180_000)
  })
  it('measures a running build to now, and a queued one not at all', () => {
    const now = Date.parse('2026-09-12T10:01:05Z')
    expect(buildDurationMs(summary({ state: 'building' }), now)).toBe(60_000)
    expect(buildDurationMs(summary({ state: 'queued', startedAt: null }), now)).toBeNull()
  })
})

describe('buildTimeline', () => {
  it('marks the running phase and leaves later ones pending', () => {
    const t = buildTimeline('checking', { clone: 1200, detect: 800 })
    expect(t.map((s) => [s.phase, s.status, s.ms])).toEqual([
      ['cloning', 'done', 1200],
      ['detecting', 'done', 800],
      ['checking', 'running', null],
      ['building', 'pending', null],
      ['publishing', 'pending', null],
    ])
  })
  it('puts a failure on the first phase without a timing', () => {
    const t = buildTimeline('failed', { cloning: 1, detecting: 2, checking: 3 })
    expect(t.find((s) => s.status === 'failed')?.phase).toBe('building')
  })
  it('keeps timings under names it does not know, after the known phases', () => {
    const t = buildTimeline('succeeded', { build: 10, smoke: 4 })
    expect(t.at(-1)).toEqual({ phase: 'smoke', ms: 4, status: 'done' })
    expect(t.every((s) => s.status === 'done')).toBe(true)
  })
})

describe('buildTags', () => {
  it('follows the publish mode', () => {
    expect(buildTags('live', SHA)).toEqual([`sha-${SHA}`, 'latest'])
    expect(buildTags('candidate', SHA)).toEqual([`candidate-${SHA}`])
  })
})

describe('pushedTags', () => {
  it('shows what was pushed when the agent read it back', () => {
    expect(pushedTags('live', SHA, ['sha-abc', 'latest', 'v2'])).toEqual({
      tags: ['sha-abc', 'latest', 'v2'],
      actual: true,
    })
  })

  it('falls back to the derivation, and says it is one', () => {
    for (const actual of [null, undefined, []]) {
      expect(pushedTags('live', SHA, actual)).toEqual({
        tags: [`sha-${SHA}`, 'latest'],
        actual: false,
      })
    }
    expect(pushedTags('candidate', SHA, null)).toEqual({
      tags: [`candidate-${SHA}`],
      actual: false,
    })
  })
})

const detection: Detection = {
  provider: 'node',
  providers: ['node'],
  framework: 'tanstack-start',
  node: { version: '24.18.1', requested: '24.18.1', source: '.tool-versions' },
  pnpm: { version: '11.18.0', requested: '11.18.0', source: 'packageManager' },
  packages: [],
  startCommand: 'node start.mjs',
  aptPackages: [],
  secrets: [],
  spa: false,
  railpackVersion: '0.39.0',
  success: true,
  logs: [],
}

describe('detectionParts', () => {
  it('reads as the overview line', () => {
    expect(detectionParts('railpack', detection)).toEqual([
      { text: 'Built with Railpack' },
      { text: 'Node 24.18.1 (.tool-versions)' },
      { text: 'pnpm 11.18.0' },
      { text: 'TanStack Start' },
      { text: 'node start.mjs', code: true },
    ])
  })
  it('says Dockerfile when that is what built it', () => {
    expect(detectionParts('dockerfile', null)).toEqual([{ text: 'Built from the Dockerfile' }])
  })
})

describe('deployOutcome', () => {
  const base = {
    state: 'succeeded' as const,
    publish: 'live' as const,
    digest: 'sha256:abc',
    deployEnable: true,
    imageOverride: null,
    deployment: null,
  }
  it('is nothing for an unfinished or failed build', () => {
    expect(deployOutcome({ ...base, state: 'failed' })).toEqual({ kind: 'none' })
  })
  it('never deploys a candidate', () => {
    expect(deployOutcome({ ...base, publish: 'candidate' })).toEqual({ kind: 'candidate' })
  })
  it('reads a recorded deploy first, then a freeze or an override, then waiting', () => {
    const deployment = { result: 'ok', startedAt: '2026-09-12T10:04:00Z', httpCode: '200' }
    expect(deployOutcome({ ...base, deployEnable: false, deployment }).kind).toBe('deployed')
    expect(deployOutcome({ ...base, deployEnable: false })).toEqual({
      kind: 'pinned',
      why: 'frozen',
    })
    expect(deployOutcome({ ...base, imageOverride: 'registry/x@sha256:1' })).toEqual({
      kind: 'pinned',
      why: 'image-override',
    })
    expect(deployOutcome(base)).toEqual({ kind: 'waiting' })
  })
})

describe('reportFailureText', () => {
  it('says what GitHub refused, how often, and whether retries remain', () => {
    const f = {
      step: 'check-run',
      kind: 'server',
      status: 502,
      attempts: 4,
      at: '2026-09-12T12:00:00Z',
      gaveUp: true,
    }
    expect(reportFailureText(f)).toBe(
      'Posting the check run to GitHub failed (server, HTTP 502), 4 times. The automatic retries are spent.',
    )
    expect(
      reportFailureText({
        ...f,
        step: 'deployment',
        kind: 'unreachable',
        status: null,
        attempts: 1,
        gaveUp: false,
      }),
    ).toBe(
      'Posting the Deployment to GitHub failed (unreachable), once. It is retried on its own as well.',
    )
  })
})

describe('sameDigest', () => {
  it('ignores the sha256: prefix', () => {
    expect(sameDigest('sha256:abc', 'abc')).toBe(true)
    expect(sameDigest('abc', null)).toBe(false)
  })
})
