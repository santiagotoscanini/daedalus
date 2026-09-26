import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { decode } from '../../../lib/contract/decode'
import {
  conclusionTone,
  conclusionWord,
  cronWords,
  dayBuckets,
  jobDecoder,
  jobMinutes,
  percentile,
  type Run,
  runDecoder,
  runSeconds,
  runsOnOf,
  scanWorkflow,
} from './parse'

// The engine's own workflow file is the fixture: it has a matrix runs-on,
// three OS images, a dispatch trigger and a permissions block right after
// `on:` that a naive scan would read as a trigger. In the dev container app/
// is mounted alone at /app and the whole engine read-only at /engine, so the
// repository root is looked for there next — a missing file fails, never skips.
function agentYml(): string {
  const candidates = [
    fileURLToPath(new URL('../../../../../.github/workflows/agent.yml', import.meta.url)),
    '/engine/.github/workflows/agent.yml',
  ]
  const found = candidates.find((path) => existsSync(path))
  if (found === undefined) throw new Error(`agent.yml not found at ${candidates.join(' or ')}`)
  return readFileSync(found, 'utf8')
}
const AGENT_YML = agentYml()

const run = (over: Partial<Run> = {}): Run => ({
  id: 1,
  repo: 'o/r',
  workflow: 'CI',
  workflowId: 9,
  branch: 'main',
  event: 'push',
  status: 'completed',
  conclusion: 'success',
  attempt: 1,
  actor: 'me',
  sha: 'abc',
  createdAt: '2026-09-23T10:00:00Z',
  startedAt: '2026-09-23T10:00:10Z',
  updatedAt: '2026-09-23T10:03:10Z',
  url: 'https://github.com/o/r/actions/runs/1',
  ...over,
})

describe('the workflow file', () => {
  it('reads the engine’s agent workflow', () => {
    const w = scanWorkflow(AGENT_YML)
    expect(w.name).toBe('Agent')
    expect(w.triggers).toEqual(['pull_request', 'push', 'workflow_dispatch'])
    expect(w.crons).toEqual([])
    expect(w.jobs).toBeGreaterThanOrEqual(4)
    // The matrix expands; the literal labels stay as written.
    expect(w.runsOn.slice(0, 3)).toEqual(['windows-latest', 'macos-latest', 'ubuntu-latest'])
    expect(w.runsOn).toContain('ubuntu-latest')
    expect([...w.uses].sort()).toEqual([
      'actions/checkout',
      'actions/download-artifact',
      'actions/upload-artifact',
    ])
  })

  it('reads an inline trigger list, a schedule and a self-hosted label list', () => {
    const w = scanWorkflow(`name: Nightly
on: [push, workflow_dispatch]
jobs:
  build:
    runs-on: [self-hosted, linux, x64]
    steps:
      - uses: actions/checkout@v4
  sched:
    runs-on: "ubuntu-24.04"
    steps:
      - run: echo
`)
    expect(w.triggers).toEqual(['push', 'workflow_dispatch'])
    expect(w.runsOn).toEqual(['self-hosted, linux, x64', 'ubuntu-24.04'])
    expect(w.jobs).toBe(2)
  })

  it('finds a cron under the block form', () => {
    const w = scanWorkflow(`on:
  schedule:
    - cron: '0 4 * * 1'
  push:
    branches: [main]
jobs:
  a:
    runs-on: ubuntu-latest
`)
    expect(w.triggers).toEqual(['schedule', 'push'])
    expect(w.crons).toEqual(['0 4 * * 1'])
  })
})

describe('cron in words', () => {
  it('names the common shapes and leaves the rest alone', () => {
    expect(cronWords('0 4 * * *')).toBe('daily at 04:00 UTC')
    expect(cronWords('30 9 * * 1')).toBe('Mon at 09:30 UTC')
    expect(cronWords('0 */6 * * *')).toBe('every 6 hours')
    expect(cronWords('*/15 * * * *')).toBe('every 15 minutes')
    expect(cronWords('0 4 1 * *')).toBe('0 4 1 * *')
  })
})

describe('where a job runs', () => {
  it('classifies GitHub’s images and self-hosted labels', () => {
    expect(runsOnOf(['ubuntu-latest'])).toEqual({
      os: 'linux',
      hosted: true,
      label: 'ubuntu-latest',
    })
    expect(runsOnOf(['windows-2022'])).toMatchObject({ os: 'windows', hosted: true })
    expect(runsOnOf(['macos-14'])).toMatchObject({ os: 'macos', hosted: true })
    expect(runsOnOf(['self-hosted', 'Linux', 'X64'])).toMatchObject({ os: 'linux', hosted: false })
    expect(runsOnOf(['self-hosted', 'gpu'])).toMatchObject({
      os: 'unknown',
      hosted: false,
      label: 'gpu',
    })
  })

  it('bills minutes the way GitHub does: rounded up per job, times the OS', () => {
    const job = (labels: string[], seconds: number) =>
      decode(jobDecoder, {
        id: 1,
        run_id: 1,
        name: 'j',
        status: 'completed',
        conclusion: 'success',
        started_at: '2026-09-23T10:00:00Z',
        completed_at: new Date(Date.parse('2026-09-23T10:00:00Z') + seconds * 1000).toISOString(),
        labels,
        html_url: null,
      })
    expect(jobMinutes(job(['ubuntu-latest'], 61))).toEqual({ raw: 2, billed: 2 })
    expect(jobMinutes(job(['windows-latest'], 30))).toEqual({ raw: 1, billed: 2 })
    expect(jobMinutes(job(['macos-latest'], 600))).toEqual({ raw: 10, billed: 100 })
    expect(jobMinutes(job(['self-hosted', 'linux'], 600))).toEqual({ raw: 10, billed: 0 })
  })

  it('names the failed step', () => {
    const j = decode(jobDecoder, {
      id: 1,
      run_id: 1,
      name: 'gate',
      status: 'completed',
      conclusion: 'failure',
      html_url: 'u',
      steps: [
        { name: 'Checkout', conclusion: 'success' },
        { name: 'Clippy', conclusion: 'failure' },
        { name: 'Upload', conclusion: 'skipped' },
      ],
    })
    expect(j.failedStep).toBe('Clippy')
  })
})

describe('runs', () => {
  it('decodes what the list endpoint sends', () => {
    const r = decode(runDecoder, {
      id: 5,
      name: 'Agent',
      workflow_id: 9,
      head_branch: 'main',
      event: 'push',
      status: 'completed',
      conclusion: 'success',
      run_attempt: 2,
      head_sha: 'deadbeef',
      created_at: '2026-09-23T10:00:00Z',
      run_started_at: '2026-09-23T10:00:05Z',
      updated_at: '2026-09-23T10:04:05Z',
      html_url: 'https://github.com/o/r/actions/runs/5',
      actor: { login: 'me' },
      repository: { full_name: 'o/r' },
    })
    expect(r.repo).toBe('o/r')
    expect(r.attempt).toBe(2)
    expect(runSeconds(r)).toBe(240)
  })

  it('measures a running one against now', () => {
    const now = Date.parse('2026-09-23T10:05:10Z')
    expect(runSeconds(run({ status: 'in_progress', conclusion: null }), now)).toBe(300)
  })

  it('buckets by day, flagging failures', () => {
    const now = Date.parse('2026-09-23T15:00:00Z')
    const b = dayBuckets(
      [
        run({ createdAt: '2026-09-23T01:00:00Z' }),
        run({ createdAt: '2026-09-23T02:00:00Z', conclusion: 'failure' }),
        run({ createdAt: '2026-09-21T02:00:00Z' }),
        run({ createdAt: '2026-08-01T02:00:00Z' }),
      ],
      3,
      now,
    )
    expect(b.map((x) => [x.label, x.value, x.flag])).toEqual([
      ['9/21', 1, false],
      ['9/22', 0, false],
      ['9/23', 2, true],
    ])
  })

  it('has a tone and a word for every state', () => {
    expect(conclusionTone('completed', 'success')).toBe('ok')
    expect(conclusionTone('completed', 'failure')).toBe('bad')
    expect(conclusionTone('completed', 'cancelled')).toBe('warn')
    expect(conclusionTone('in_progress', null)).toBe('accent')
    expect(conclusionWord('in_progress', null)).toBe('running')
    expect(conclusionWord('completed', 'timed_out')).toBe('timed out')
    expect(percentile([1, 2, 3, 4, 10], 50)).toBe(3)
    expect(percentile([], 50)).toBeNull()
  })
})
