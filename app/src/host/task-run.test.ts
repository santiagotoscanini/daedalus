import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readTaskRunStatus, requestTaskRun } from './task-run'

// The file names on both halves of this bridge are a contract with a host unit
// this repository cannot see: stacks/apps watches `task-run-request.json` and
// writes `task-run-status.json`. A rename here does not fail anything — the
// button would simply stop reaching the box, silently, with the request file
// piling up under a name nothing watches. So the names are asserted.
//
// The second thing asserted is that the request names the task: the host
// derives a unit from it, and a request that lost the field would either fail
// or (worse) run a different one.

let dir: string
let previous: string | undefined

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'task-run-'))
  previous = process.env.APPLY_DIR
  process.env.APPLY_DIR = dir
})

afterEach(async () => {
  if (previous === undefined) delete process.env.APPLY_DIR
  else process.env.APPLY_DIR = previous
  await rm(dir, { recursive: true, force: true })
})

describe('requestTaskRun', () => {
  it('writes task-run-request.json carrying the app, the task and the actor', async () => {
    const id = await requestTaskRun({ app: 'hermes', task: 'digest', actor: 'someone' })

    const body = JSON.parse(await readFile(join(dir, 'task-run-request.json'), 'utf8')) as {
      id: string
      app: string
      task: string
      actor: string
      requestedAt: string
    }
    expect(body.id).toBe(id)
    expect(body.app).toBe('hermes')
    expect(body.task).toBe('digest')
    expect(body.actor).toBe('someone')
    expect(Number.isFinite(Date.parse(body.requestedAt))).toBe(true)
  })
})

describe('readTaskRunStatus', () => {
  const IDLE = {
    id: null,
    app: null,
    task: null,
    state: 'idle',
    error: '',
    startedAt: null,
    finishedAt: null,
  }

  it('reads idle before the host has ever answered', async () => {
    expect(await readTaskRunStatus()).toEqual(IDLE)
  })

  it('fills a partial status from the decoder rather than casting it', async () => {
    await writeFile(
      join(dir, 'task-run-status.json'),
      '{"id":"abc","app":"hermes","task":"digest","state":"running"}',
      'utf8',
    )
    expect(await readTaskRunStatus()).toEqual({
      ...IDLE,
      id: 'abc',
      app: 'hermes',
      task: 'digest',
      state: 'running',
    })
  })

  // An unreadable status is a broken host agent, and idle is the only honest
  // reading of it — a `state` nobody defined must never reach the button as a
  // state, because the button disables itself on one of them.
  it('reads idle on a torn file and on a state the verb does not have', async () => {
    await writeFile(join(dir, 'task-run-status.json'), '{"state":"runn', 'utf8')
    expect(await readTaskRunStatus()).toEqual(IDLE)
    await writeFile(join(dir, 'task-run-status.json'), '{"state":"banana"}', 'utf8')
    expect(await readTaskRunStatus()).toEqual(IDLE)
  })
})
