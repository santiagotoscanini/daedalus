import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SnapshotResult } from './contract/snapshot'
import {
  type GithubInstallation,
  NO_INSTALLATION,
  publicInstallation,
  readGithubInstallation,
  readOtherInstallations,
  tokenUsable,
  usableToken,
} from './github-token'

let dir: string
let path: string
let errors: string[]

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'github-token-'))
  path = join(dir, 'installation.json')
  errors = []
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(' '))
  })
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
})

const env = (name: string) => (name === 'GITHUB_TOKEN_PATH' ? path : undefined)
const TOKEN = `ghs${'_'}${'Q9w8E7r6'.repeat(5)}`
const NOW = Date.parse('2026-09-11T20:00:00Z')

const OK = {
  version: 1,
  state: 'ok',
  installationId: 81_234_567,
  account: { login: 'santiagotoscanini', id: 12_345_678 },
  repositorySelection: 'selected',
  token: TOKEN,
  expiresAt: '2026-09-11T20:45:00Z',
  mintedAt: '2026-09-11T19:45:00Z',
}

const write = (body: unknown) => writeFile(path, JSON.stringify(body), 'utf8')

const snap = (
  data: Partial<GithubInstallation>,
  available = true,
): SnapshotResult<GithubInstallation> => ({
  data: { ...NO_INSTALLATION, ...data },
  available,
  generatedAt: null,
  ageMs: null,
  stale: false,
  error: null,
})

describe('readGithubInstallation', () => {
  it('decodes a minted installation', async () => {
    await write(OK)
    const r = await readGithubInstallation(env)
    expect(r.available).toBe(true)
    expect(r.stale).toBe(false)
    expect(r.data).toEqual({ ...OK, reason: null, missingPermissions: [] })
  })

  it('carries the permissions the installation was not granted', async () => {
    await write({ ...OK, missingPermissions: ['pages'] })
    expect((await readGithubInstallation(env)).data.missingPermissions).toEqual(['pages'])
  })

  it('decodes an App that is not installed', async () => {
    await write({
      version: 1,
      state: 'not-installed',
      reason: 'no installation for account 12345678',
      mintedAt: '2026-09-11T19:45:00Z',
    })
    const r = await readGithubInstallation(env)
    expect(r.data).toMatchObject({ state: 'not-installed', token: null, account: null })
    expect(tokenUsable(r, NOW)).toBe(false)
  })

  it('falls back when the minter has never run', async () => {
    const r = await readGithubInstallation(env)
    expect(r.available).toBe(false)
    expect(r.data).toBe(NO_INSTALLATION)
    expect(tokenUsable(r, NOW)).toBe(false)
  })

  it('flags a file older than 70 minutes as stale', async () => {
    await write(OK)
    const old = new Date(Date.now() - 71 * 60_000)
    await utimes(path, old, old)
    expect((await readGithubInstallation(env)).stale).toBe(true)
  })

  it('refuses another version', async () => {
    await write({ ...OK, version: 2 })
    const r = await readGithubInstallation(env)
    expect(r.available).toBe(false)
    expect(r.error).toMatch(/version/)
    expect(r.error).not.toContain(TOKEN)
  })

  it('refuses a malformed file without the token reaching the error or the log', async () => {
    // A producer bug that put the token where the state belongs: `literal`
    // would quote it in the decode error.
    await write({ ...OK, state: TOKEN })
    const r = await readGithubInstallation(env)
    expect(r.available).toBe(false)
    expect(r.error).toMatch(/state/)
    expect(r.error).not.toContain(TOKEN)
    expect(errors.length).toBeGreaterThan(0)
    for (const line of errors) expect(line).not.toContain(TOKEN)
  })

  it('refuses a mistyped token field without echoing it', async () => {
    await write({ ...OK, token: { value: TOKEN } })
    const r = await readGithubInstallation(env)
    expect(r.available).toBe(false)
    expect(r.error).not.toContain(TOKEN)
  })

  it('redacts a token the minter put in its reason', async () => {
    await write({
      ...OK,
      state: 'error',
      reason: `POST failed with Authorization: Bearer ${TOKEN}`,
    })
    const r = await readGithubInstallation(env)
    expect(r.data.reason).not.toContain(TOKEN)
  })
})

describe('tokenUsable', () => {
  const ok = (expiresAt: string, token: string | null = TOKEN) =>
    snap({ state: 'ok', token, expiresAt })

  it.each([
    ['45 minutes left', ok('2026-09-11T20:45:00Z'), true],
    ['6 minutes left', ok('2026-09-11T20:06:00Z'), true],
    ['4 minutes left', ok('2026-09-11T20:04:00Z'), false],
    ['expired', ok('2026-09-11T19:59:00Z'), false],
    ['no expiry', ok(''), false],
    ['an unparseable expiry', ok('soon'), false],
    ['no token', ok('2026-09-11T20:45:00Z', null), false],
    ['an empty token', ok('2026-09-11T20:45:00Z', ''), false],
    [
      'state error, token kept',
      snap({ state: 'error', token: TOKEN, expiresAt: '2026-09-11T20:45:00Z' }),
      false,
    ],
    [
      'an unavailable snapshot',
      snap({ state: 'ok', token: TOKEN, expiresAt: '2026-09-11T20:45:00Z' }, false),
      false,
    ],
  ])('%s → %s', (_label, s, expected) => {
    expect(tokenUsable(s, NOW)).toBe(expected)
    expect(usableToken(s, new Date(NOW))).toBe(expected ? TOKEN : null)
  })

  it('still uses a stale file whose token has not expired', () => {
    expect(tokenUsable({ ...ok('2026-09-11T20:45:00Z'), stale: true }, NOW)).toBe(true)
  })
})

describe('publicInstallation', () => {
  it('drops the token and says whether there was one', () => {
    const p = publicInstallation({ ...NO_INSTALLATION, state: 'ok', token: TOKEN })
    expect(JSON.stringify(p)).not.toContain(TOKEN)
    expect(p.hasToken).toBe(true)
    expect(publicInstallation(NO_INSTALLATION).hasToken).toBe(false)
  })
})

describe('readOtherInstallations', () => {
  const othersPath = () => join(dir, 'installations.json')
  const othersEnv = (name: string) =>
    name === 'GITHUB_INSTALLATIONS_PATH' ? othersPath() : undefined
  const ENTRY = {
    installationId: 91_000_001,
    account: { login: 'santree-ai', id: 55_555_555 },
    repositorySelection: 'all',
    state: 'ok',
    reason: null,
    token: TOKEN,
    expiresAt: '2026-09-11T20:45:00Z',
    missingPermissions: [],
    mintedAt: '2026-09-11T19:45:00Z',
  }

  it('decodes each installation into the owner file’s shape', async () => {
    await writeFile(othersPath(), JSON.stringify({ version: 1, installations: [ENTRY] }), 'utf8')
    const r = await readOtherInstallations(othersEnv)
    expect(r.available).toBe(true)
    expect(r.data).toEqual([{ version: 1, ...ENTRY }])
    expect(usableToken({ ...r, data: r.data[0] ?? NO_INSTALLATION }, NOW)).toBe(TOKEN)
  })

  it('is empty when the minter has published nothing', async () => {
    const r = await readOtherInstallations(othersEnv)
    expect(r.available).toBe(false)
    expect(r.data).toEqual([])
  })

  it('never quotes a token from a malformed file', async () => {
    await writeFile(
      othersPath(),
      JSON.stringify({ version: 1, installations: [{ ...ENTRY, state: TOKEN }] }),
      'utf8',
    )
    const r = await readOtherInstallations(othersEnv)
    expect(r.data).toEqual([])
    expect(JSON.stringify(r)).not.toContain(TOKEN)
    expect(errors.join('\n')).not.toContain(TOKEN)
  })
})
