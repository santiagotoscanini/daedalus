import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Ctx } from '../core/ctx'
import { type Decoder, literal, nullable, obj, optional, str } from '../lib/contract/decode'
import { defineRootVerb } from './root-verb'

// How a root verb's status file reads: through its decoder, never a cast, and
// idle whenever it cannot be read. Whether a `running` one is still true is
// image-update.test.ts's (the controller's run, then the helper's status).

type Status = { id: string | null; state: 'idle' | 'running'; phase: string; error: string }

const STATUS: Decoder<Status> = obj({
  id: optional(nullable(str), null),
  state: optional(literal('idle', 'running'), 'idle'),
  phase: optional(str, ''),
  error: optional(str, ''),
})

const IDLE: Status = { id: null, state: 'idle', phase: '', error: '' }

/** A run the controller says goes on: a `running` file is believed as it is. */
const ctx = {
  controller: { rootFollow: async () => ({ run: { outcome: null, detail: '' } }) },
} as unknown as Pick<Ctx, 'controller'>

let dir: string
let previous: string | undefined

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'root-verb-'))
  previous = process.env.VERBS_DIR
  process.env.VERBS_DIR = dir
})

afterEach(async () => {
  if (previous === undefined) delete process.env.VERBS_DIR
  else process.env.VERBS_DIR = previous
  await rm(dir, { recursive: true, force: true })
})

const verb = () => defineRootVerb<Status>({ verb: 'demo', status: STATUS, ended: () => 'ended' })
const file = (body: string) => writeFile(join(dir, 'demo-status.json'), body, 'utf8')

describe('readStatus', () => {
  it('derives the idle status from the decoder', () => {
    expect(verb().idle).toEqual(IDLE)
  })

  it('reports idle when the verb never ran', async () => {
    expect(await verb().readStatus(ctx)).toEqual(IDLE)
  })

  it('reports idle on a torn or corrupt status file', async () => {
    await file('{"id":"abc","sta')
    expect(await verb().readStatus(ctx)).toEqual(IDLE)
  })

  it('fills a partial status from the decoder instead of casting it', async () => {
    await file('{"id":"r1","state":"running"}')
    expect(await verb().readStatus(ctx)).toEqual({ ...IDLE, id: 'r1', state: 'running' })
  })

  // A cast would take whatever JSON.parse produced, so a field of the wrong
  // type would reach the page as itself and a `state` nobody defined would
  // reach it as a state. Both are the host agent being broken, and idle is the
  // only honest reading of a status that cannot be read.
  it('reports idle on a well-formed file of the wrong shape, or a state the verb does not have', async () => {
    await file('{"state":"running","phase":7}')
    expect(await verb().readStatus(ctx)).toEqual(IDLE)
    await file('{"state":"banana"}')
    expect(await verb().readStatus(ctx)).toEqual(IDLE)
  })
})
