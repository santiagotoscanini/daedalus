import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readSecretSetStatus, requestSecretRemove, requestSecretSet } from './secret-set-request'

// The file names on both halves of this bridge are a contract with a host unit
// this repository cannot see: stacks/daedalus watches `secret-set-request.json`
// and writes `secret-set-status.json`. A rename here fails nothing — the
// button would simply stop reaching the box, silently, with requests piling up
// under a name nothing watches. So the names are asserted, exactly as
// task-run.test.ts asserts its own.
//
// The second thing asserted is that the request carries the SEALED value and
// only the sealed value. $APPLY_DIR is a bind mount on a snapshotted dataset,
// so a plaintext written there does not go away when the file does.

let dir: string
let previous: string | undefined

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'secret-set-'))
  previous = process.env.APPLY_DIR
  process.env.APPLY_DIR = dir
})

afterEach(async () => {
  if (previous === undefined) delete process.env.APPLY_DIR
  else process.env.APPLY_DIR = previous
  await rm(dir, { recursive: true, force: true })
})

describe('requestSecretSet', () => {
  it('writes secret-set-request.json carrying app, key, ciphertext and actor', async () => {
    const id = await requestSecretSet({
      actor: 'someone@example.com',
      app: 'hermes',
      key: 'INVITE_CODE',
      ciphertext: '{"data":"ENC[AES256_GCM,data:abc]","sops":{}}',
    })

    const body = JSON.parse(await readFile(join(dir, 'secret-set-request.json'), 'utf8')) as {
      id: string
      action: string
      app: string
      key: string
      ciphertext: string
      actor: string
      requestedAt: string
    }
    expect(body.id).toBe(id)
    expect(body.action).toBe('set')
    expect(body.app).toBe('hermes')
    expect(body.key).toBe('INVITE_CODE')
    expect(body.ciphertext).toContain('ENC[')
    expect(body.actor).toBe('someone@example.com')
    expect(Number.isFinite(Date.parse(body.requestedAt))).toBe(true)
  })

  it('writes one file and no payload sidecar', async () => {
    // The sealed value is small and rides in the request itself; a
    // payload-<id>.json here would be a second file on the snapshotted mount
    // holding the same bytes, which nothing would clean up.
    await requestSecretSet({ actor: 'a', app: 'hermes', key: 'K', ciphertext: '{"data":"ENC[x]"}' })
    expect(await readdir(dir)).toEqual(['secret-set-request.json'])
  })
})

describe('requestSecretRemove', () => {
  it('writes the same file with action remove and no ciphertext field', async () => {
    await requestSecretRemove({ actor: 'op', app: 'hermes', key: 'INVITE_CODE' })
    const body = JSON.parse(await readFile(join(dir, 'secret-set-request.json'), 'utf8')) as Record<
      string,
      unknown
    >
    expect(body.action).toBe('remove')
    expect('ciphertext' in body).toBe(false)
  })
})

describe('readSecretSetStatus', () => {
  const IDLE = {
    id: null,
    app: null,
    key: null,
    action: null,
    state: 'idle',
    detail: '',
    error: '',
    commit: '',
    startedAt: null,
    finishedAt: null,
  }

  it('is idle when the host has never answered', async () => {
    expect(await readSecretSetStatus()).toEqual(IDLE)
  })

  it('decodes a status from an older agent by falling back field by field', async () => {
    // The agent and this reader ship one release at a time. A status missing
    // `commit` — written by an agent from before it existed — must still read
    // as the run it describes, not as idle.
    await writeFile(
      join(dir, 'secret-set-status.json'),
      JSON.stringify({ id: 'x', app: 'hermes', key: 'K', action: 'set', state: 'done' }),
    )
    expect(await readSecretSetStatus()).toEqual({
      ...IDLE,
      ...{ id: 'x', state: 'done' },
      app: 'hermes',
      key: 'K',
      action: 'set',
    })
  })

  it('reads an unparseable status as idle rather than throwing into the page', async () => {
    await writeFile(join(dir, 'secret-set-status.json'), 'not json')
    expect(await readSecretSetStatus()).toEqual(IDLE)
  })
})
