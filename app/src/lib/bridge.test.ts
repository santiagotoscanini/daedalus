import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defineBridge } from './bridge'

type Status = { id: string | null; state: string; phase: string }

const IDLE: Status = { id: null, state: 'idle', phase: '' }

let dir: string
let previousApplyDir: string | undefined

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bridge-'))
  previousApplyDir = process.env.APPLY_DIR
  process.env.APPLY_DIR = dir
})

afterEach(async () => {
  if (previousApplyDir === undefined) delete process.env.APPLY_DIR
  else process.env.APPLY_DIR = previousApplyDir
  await rm(dir, { recursive: true, force: true })
})

const bridge = () =>
  defineBridge<Status>({ requestFile: 'request.json', statusFile: 'status.json', idle: IDLE })

describe('readStatus', () => {
  it('reports idle when nothing was ever requested', async () => {
    expect(await bridge().readStatus()).toEqual(IDLE)
  })

  it('reports idle on a torn or corrupt status file', async () => {
    await writeFile(join(dir, 'status.json'), '{"id":"abc","sta', 'utf8')
    expect(await bridge().readStatus()).toEqual(IDLE)
  })

  it('spreads a partial status over the idle shape', async () => {
    await writeFile(join(dir, 'status.json'), '{"state":"running"}', 'utf8')
    expect(await bridge().readStatus()).toEqual({ ...IDLE, state: 'running' })
  })
})

describe('request', () => {
  it('writes the payload under the request id and then the trigger, and returns the id', async () => {
    const id = await bridge().request({ actor: 'test' }, '{"apps":{}}\n')
    expect(await readFile(join(dir, `payload-${id}.json`), 'utf8')).toBe('{"apps":{}}\n')
    const request = JSON.parse(await readFile(join(dir, 'request.json'), 'utf8')) as {
      id: string
      actor: string
      requestedAt: string
    }
    expect(request.id).toBe(id)
    expect(request.actor).toBe('test')
    expect(request.requestedAt).toBeTruthy()
  })

  it('leaves no temp files behind', async () => {
    await bridge().request({ actor: 'test' })
    const { readdir } = await import('node:fs/promises')
    expect((await readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('mints a fresh id per request', async () => {
    const b = bridge()
    expect(await b.request({})).not.toBe(await b.request({}))
  })
})
