import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defineBridge } from './bridge'
import { type Decoder, literal, nullable, obj, optional, str } from './contract/decode'

type Status = { id: string | null; state: 'idle' | 'running'; phase: string }

const STATUS: Decoder<Status> = obj({
  id: optional(nullable(str), null),
  state: optional(literal('idle', 'running'), 'idle'),
  phase: optional(str, ''),
})

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
  defineBridge<Status>({ requestFile: 'request.json', statusFile: 'status.json', status: STATUS })

describe('readStatus', () => {
  it('derives the idle status from the decoder', () => {
    expect(bridge().idle).toEqual(IDLE)
  })

  it('reports idle when nothing was ever requested', async () => {
    expect(await bridge().readStatus()).toEqual(IDLE)
  })

  it('reports idle on a torn or corrupt status file', async () => {
    await writeFile(join(dir, 'status.json'), '{"id":"abc","sta', 'utf8')
    expect(await bridge().readStatus()).toEqual(IDLE)
  })

  it('fills a partial status from the decoder instead of casting it', async () => {
    await writeFile(join(dir, 'status.json'), '{"state":"running"}', 'utf8')
    expect(await bridge().readStatus()).toEqual({ ...IDLE, state: 'running' })
  })

  // The cast this replaced took whatever JSON.parse produced, so a field of
  // the wrong type reached the page as itself and a `state` nobody defined
  // reached it as a state. Both are the host agent being broken, and idle is
  // the only honest reading of a status that cannot be read.
  it('reports idle on a well-formed file of the wrong shape', async () => {
    await writeFile(join(dir, 'status.json'), '{"state":"running","phase":7}', 'utf8')
    expect(await bridge().readStatus()).toEqual(IDLE)
  })

  it('reports idle on a state the verb does not have', async () => {
    await writeFile(join(dir, 'status.json'), '{"state":"banana"}', 'utf8')
    expect(await bridge().readStatus()).toEqual(IDLE)
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
