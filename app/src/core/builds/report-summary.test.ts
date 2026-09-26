import { describe, expect, it, vi } from 'vitest'
import type { BuildRow } from '../../lib/build-queue'

// The check run's words, byte for byte. Snapshotted against representative
// rows so that a restructure of the renderer shows up as a diff here, not as a
// quietly different check run on GitHub.

vi.mock('../github-app', () => ({ ghApp: async () => null, repoById: async () => null }))

const { titleOf } = await import('./report')
const { summaryOf } = await import('../../lib/build-report-text')

const SHA = `abcdef0${'1'.repeat(33)}`
const DIGEST = `sha256:${'a'.repeat(64)}`
const T0 = Date.parse('2026-09-12T12:00:00Z')
const SITE = { app: null, box: 's2-server', controlPlane: null }

function row(over: Partial<BuildRow> = {}): BuildRow {
  return {
    id: '11111111-2222-4333-8444-555555555555',
    appId: 'app-1',
    app: 'iris',
    lane: 'main',
    prNumber: null,
    sha: SHA,
    strategy: 'auto',
    resolvedStrategy: 'railpack',
    publish: 'live',
    requestedBy: 'webhook',
    actor: null,
    deliveryId: null,
    state: 'building',
    phase: 'building',
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
    createdAt: new Date(T0 - 5 * 60_000),
    startedAt: new Date(T0 - 4 * 60_000),
    updatedAt: new Date(T0),
    ...over,
  }
}

const DETECTED = {
  info: {
    success: true,
    railpackVersion: '0.39.0',
    detectedProviders: ['node'],
    metadata: { nodeRuntime: 'tanstack-start' },
    resolvedPackages: {
      node: { requestedVersion: '24', resolvedVersion: '24.18.1', source: '.tool-versions' },
      pnpm: { resolvedVersion: '11.1.0', source: 'packageManager' },
      python: { requestedVersion: '3|x', resolvedVersion: '3.12\n.1', source: 'mise | default' },
    },
    logs: [
      { level: 'warn', msg: 'No lockfile found', docsPath: '/docs/node' },
      { Level: 'info', Msg: 'Using pnpm' },
    ],
  },
  plan: {
    deploy: { startCommand: 'node `start`.mjs' },
    steps: [
      {
        name: 'packages:apt:runtime',
        commands: [{ customName: 'install apt packages: libvips ffmpeg' }],
      },
    ],
  },
}

const cases: [string, BuildRow, Parameters<typeof summaryOf>[1]][] = [
  ['building, nothing known yet', row(), null],
  ['auto with no resolved strategy', row({ resolvedStrategy: null, phase: '' }), null],
  [
    'succeeded and deploying, every fact',
    row({
      state: 'succeeded',
      phase: 'published',
      detected: DETECTED,
      checks: { ran: ['format:check', 'lint'], failed: null },
      timings: { cloning: 1_200, building: 65_000, pushing: 800 },
      digest: DIGEST,
      imageRef: `registry.example.test/iris@${DIGEST}`,
      sizeBytes: 300 * 1024 * 1024,
      facts: {
        image: {
          tags: ['main', 'sha-abcdef0'],
          layers: 3,
          layerSizes: [],
          configSize: null,
          mediaType: null,
        },
        run: {
          runner: 'buildkit',
          secretsHash: null,
          cacheImported: true,
          cacheExported: true,
          stepsCached: 7,
          stepsTotal: 9,
        },
      },
      warnings: [{ code: 'railpack', message: 'Railpack says pin Node' }],
    }),
    'deploy',
  ],
  [
    'succeeded, pinned, digest not in the ref, expected tags',
    row({
      state: 'succeeded',
      phase: 'published',
      strategy: 'dockerfile',
      resolvedStrategy: 'dockerfile',
      digest: DIGEST,
      imageRef: 'registry.example.test/iris:main',
      facts: {
        image: null,
        run: {
          runner: null,
          secretsHash: null,
          cacheImported: false,
          cacheExported: null,
          stepsCached: null,
          stepsTotal: 4,
        },
      },
    }),
    'pinned',
  ],
  [
    'succeeded candidate',
    row({ state: 'succeeded', phase: 'published', publish: 'candidate', digest: DIGEST }),
    'candidate',
  ],
  [
    'failed in checks',
    row({
      state: 'failed',
      phase: 'checking',
      error: 'checking',
      checks: { ran: [], failed: 'li`nt' },
      timings: { cloning: 1_200, checking: 5_000 },
      detected: DETECTED.info,
      warnings: [],
    }),
    null,
  ],
  ['failed without an error', row({ state: 'failed', phase: 'building' }), null],
  [
    'cancelled by the operator',
    row({ state: 'cancelled', phase: 'cancelled', error: 'cancelled by the operator' }),
    null,
  ],
  ['superseded', row({ state: 'superseded', phase: 'superseded by 1234567' }), null],
  ['superseded, no phase', row({ state: 'superseded', phase: '' }), null],
]

describe('the check run text', () => {
  it.each(cases)('%s', (_name, r, delivery) => {
    expect({ title: titleOf(r, SITE, delivery), summary: summaryOf(r, delivery) }).toMatchSnapshot()
  })

  it('clamps a long title', () => {
    const t = titleOf(row({ state: 'failed', error: 'x'.repeat(400) }), SITE, null)
    expect(t.length).toBe(200)
    expect(t.endsWith('…')).toBe(true)
  })
})
