import { mkdtemp, readdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readBuildLogTail, readBuildStatus, requestBuild } from './build-bridge'
import type { BuildRequest } from './builds'

let dir: string
let env: (name: string) => string | undefined

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'build-bridge-'))
  env = (name) => (name === 'APPLY_DIR' || name === 'BUILD_LOGS_PATH' ? dir : undefined)
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const SHA = '159be4d0c2a1f3e4b5d6c7a8e9f0a1b2c3d4e5f6'
const ID = '0b6f3c1e-8a2d-4e5f-9c7b-1d2e3f4a5b6c'
const GHS = `ghs${'_'}${'A1b2C3d4'.repeat(5)}`

const REQUEST: BuildRequest = {
  version: 1,
  id: ID,
  app: 'iris',
  sha: SHA,
  repoId: 1_029_384_756,
  strategy: 'dockerfile',
  publish: 'live',
  requestedBy: 'operator',
  at: '2026-09-11T20:00:00.000Z',
}

const writeStatus = (body: unknown) =>
  writeFile(join(dir, 'build-status.json'), JSON.stringify(body), 'utf8')

describe('requestBuild', () => {
  it('writes the request file and nothing else', async () => {
    await requestBuild(REQUEST, env)
    expect(await readdir(dir)).toEqual(['build-request.json'])
    expect(JSON.parse(await readFile(join(dir, 'build-request.json'), 'utf8'))).toEqual(REQUEST)
  })

  it('writes the build env with the request', async () => {
    const withEnv: BuildRequest = {
      ...REQUEST,
      buildEnv: { placeholders: { AUTH_SECRET: 'placeholder' }, railpack: {} },
    }
    await requestBuild(withEnv, env)
    expect(JSON.parse(await readFile(join(dir, 'build-request.json'), 'utf8'))).toEqual(withEnv)
  })

  it('refuses a bad build env name before writing', async () => {
    await expect(
      requestBuild(
        { ...REQUEST, buildEnv: { placeholders: {}, railpack: { NODE_ENV: 'x' } } },
        env,
      ),
    ).rejects.toThrow(/buildEnv\.railpack/)
    expect(await readdir(dir)).toEqual([])
  })

  it('refuses an invalid request before writing', async () => {
    await expect(requestBuild({ ...REQUEST, id: '../x' }, env)).rejects.toThrow(/id/)
    expect(await readdir(dir)).toEqual([])
  })
})

describe('readBuildStatus', () => {
  const fresh = {
    version: 1,
    id: ID,
    app: 'iris',
    sha: SHA,
    state: 'checking',
    phase: 'pnpm ci',
    strategy: 'railpack',
    timings: {},
    updatedAt: new Date().toISOString(),
  }

  it('reports no build when the host never wrote a status', async () => {
    const r = await readBuildStatus(env)
    expect(r.available).toBe(false)
    expect(r.data).toBeNull()
    expect(r.error).toBeNull()
  })

  it('decodes a fresh status', async () => {
    await writeStatus(fresh)
    const r = await readBuildStatus(env)
    expect(r.available).toBe(true)
    expect(r.stale).toBe(false)
    expect(r.data?.state).toBe('checking')
  })

  it('flags a status unwritten for more than 90 s as stale', async () => {
    await writeStatus(fresh)
    const old = new Date(Date.now() - 120_000)
    await utimes(join(dir, 'build-status.json'), old, old)
    const r = await readBuildStatus(env)
    expect(r.available).toBe(true)
    expect(r.stale).toBe(true)
  })

  it('surfaces a status of the wrong version as an error', async () => {
    await writeStatus({ ...fresh, version: 2 })
    const r = await readBuildStatus(env)
    expect(r.available).toBe(false)
    expect(r.error).toMatch(/version/)
  })

  it('surfaces a torn status file as an error', async () => {
    await writeFile(join(dir, 'build-status.json'), '{"version": 1, "id', 'utf8')
    const r = await readBuildStatus(env)
    expect(r.available).toBe(false)
    expect(r.error).toBe('unparseable JSON')
  })
})

describe('readBuildLogTail', () => {
  const log = (content: string) => writeFile(join(dir, `${ID}.log`), content, 'utf8')

  it('reads a short log whole', async () => {
    await log('#1 cloning\n#2 detecting\n')
    const t = await readBuildLogTail(ID, { env })
    expect(t).toEqual({
      available: true,
      text: '#1 cloning\n#2 detecting\n',
      truncated: false,
      sizeBytes: 24,
    })
  })

  it('reads only the last bytes, from a line boundary', async () => {
    const lines = Array.from({ length: 200 }, (_, i) => `#${String(i)} step output line`).join('\n')
    await log(`${lines}\n`)
    const t = await readBuildLogTail(ID, { env, maxBytes: 100 })
    expect(t.truncated).toBe(true)
    expect(t.text.length).toBeLessThanOrEqual(100)
    expect(t.text.startsWith('#')).toBe(true)
    expect(t.text.endsWith('#199 step output line\n')).toBe(true)
  })

  it('never returns a secret cut in half by the read', async () => {
    // The read boundary lands inside the token: its prefix is gone, so only
    // dropping the partial line keeps the rest of it out.
    const content = `x-token ${GHS}\n#2 next\n`
    await log(content)
    const t = await readBuildLogTail(ID, { env, maxBytes: content.length - 12 })
    expect(t.text).toBe('#2 next\n')
    expect(t.text).not.toContain(GHS.slice(12))
  })

  it('redacts what it returns', async () => {
    await log(`#3 Authorization: Bearer ${GHS}\n`)
    const t = await readBuildLogTail(ID, { env })
    expect(t.text).toBe('#3 Authorization: Bearer [redacted]\n')
  })

  it('refuses a path-shaped id without touching the filesystem', async () => {
    await writeFile(join(dir, 'secret'), 'nope', 'utf8')
    expect((await readBuildLogTail('../secret', { env })).available).toBe(false)
  })

  it('is unavailable for a build with no log', async () => {
    expect(await readBuildLogTail(ID, { env })).toEqual({
      available: false,
      text: '',
      truncated: false,
      sizeBytes: null,
    })
  })

  it('does not follow a symlinked log', async () => {
    await writeFile(join(dir, 'elsewhere'), 'private\n', 'utf8')
    await symlink(join(dir, 'elsewhere'), join(dir, `${ID}.log`))
    expect((await readBuildLogTail(ID, { env })).available).toBe(false)
  })
})
