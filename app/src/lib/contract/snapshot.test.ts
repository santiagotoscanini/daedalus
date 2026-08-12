import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { num, obj, str } from './decode'
import { readSnapshot } from './snapshot'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'snap-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const SHAPE = obj({ host: str, port: num })
const FALLBACK = { host: 'unknown', port: 0 }

const read = (name: string, extra?: { acceptVersions?: number[]; maxAgeMs?: number }) =>
  readSnapshot({ path: join(dir, name), decoder: SHAPE, fallback: FALLBACK, ...extra })

const enveloped = (data: unknown, generatedAt: string, schemaVersion = 1) =>
  JSON.stringify({
    daedalusExport: 1,
    domain: 'test',
    schemaVersion,
    source: 'host',
    generatedAt,
    data,
  })

describe('the three failure modes stay distinct', () => {
  it('missing file: unavailable, no error', async () => {
    const r = await read('absent.json')
    expect(r).toEqual({
      data: FALLBACK,
      available: false,
      generatedAt: null,
      ageMs: null,
      stale: false,
      error: null,
    })
  })

  it('unparseable file: unavailable, error surfaced', async () => {
    await writeFile(join(dir, 'torn.json'), '{"host": "x", "por', 'utf8')
    const r = await read('torn.json')
    expect(r.available).toBe(false)
    expect(r.error).toBe('unparseable JSON')
  })

  it('well-formed JSON of the wrong shape: unavailable, path named', async () => {
    await writeFile(join(dir, 'wrong.json'), '{"host": "x", "port": "eighty"}', 'utf8')
    const r = await read('wrong.json')
    expect(r.available).toBe(false)
    expect(r.error).toContain('port')
  })
})

describe('legacy documents', () => {
  it('decode whole and age by mtime', async () => {
    await writeFile(join(dir, 'legacy.json'), '{"host": "pg", "port": 5432}', 'utf8')
    const r = await read('legacy.json')
    expect(r.data).toEqual({ host: 'pg', port: 5432 })
    expect(r.available).toBe(true)
    expect(r.generatedAt).not.toBeNull()
    expect(r.ageMs).not.toBeNull()
    expect((r.ageMs as number) < 5_000).toBe(true)
  })
})

describe('enveloped documents', () => {
  it('decode the data key and age by generatedAt', async () => {
    const born = new Date(Date.now() - 30_000).toISOString()
    await writeFile(join(dir, 'v2.json'), enveloped({ host: 'pg', port: 5432 }, born), 'utf8')
    const r = await read('v2.json')
    expect(r.data).toEqual({ host: 'pg', port: 5432 })
    expect(r.generatedAt).toBe(born)
    expect((r.ageMs as number) >= 29_000).toBe(true)
  })

  it('flag staleness past maxAgeMs', async () => {
    const old = new Date(Date.now() - 3_600_000).toISOString()
    await writeFile(join(dir, 'old.json'), enveloped({ host: 'x', port: 1 }, old), 'utf8')
    const r = await read('old.json', { maxAgeMs: 600_000 })
    expect(r.available).toBe(true)
    expect(r.stale).toBe(true)
  })

  it('refuse a schemaVersion the reader does not accept, and say which', async () => {
    await writeFile(
      join(dir, 'vnext.json'),
      enveloped({ host: 'x', port: 1 }, new Date().toISOString(), 9),
      'utf8',
    )
    const r = await read('vnext.json', { acceptVersions: [1, 2] })
    expect(r.available).toBe(false)
    expect(r.error).toContain('schemaVersion 9')
  })
})
