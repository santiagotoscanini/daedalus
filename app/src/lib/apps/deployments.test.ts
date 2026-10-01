import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The deploy journal's fold into the table. A digest is stored in one
// spelling whatever the journal wrote (so a build's digest finds its deploy by
// one equality), and only the rows inside the journal's own window are read
// to tell which lines are new.

const h = vi.hoisted(() => ({
  known: new Set<string>(),
  since: [] as Date[],
  inserted: [] as Record<string, unknown>[],
  infos: [] as string[],
}))

vi.mock('../repo/deployments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../repo/deployments')>()),
  deploymentKeysSince: async (_appId: string, since: Date) => {
    h.since.push(since)
    return h.known
  },
  insertDeployments: async (rows: Record<string, unknown>[]) => {
    h.inserted.push(...rows)
  },
}))
vi.mock('../../host/db', () => ({ db: {} }))
vi.mock('../../host/registry', () => ({
  imageInfo: async (_app: string, digest: string) => {
    h.infos.push(digest)
    return { revision: null, sourceUrl: null, createdAt: null }
  },
}))

const { ingestDeployments } = await import('./deployments')

const HEX = 'a'.repeat(64)
const line = (startedAt: string, digest: string) =>
  JSON.stringify({
    startedAt,
    finishedAt: startedAt,
    app: 'iris',
    digest,
    previousDigest: '',
    result: 'ok',
    durationMs: 1000,
    http: '200',
  })

async function journal(...lines: string[]) {
  const dir = await mkdtemp(join(tmpdir(), 'deploy-state-'))
  await writeFile(join(dir, 'iris.log'), `${lines.join('\n')}\n`)
  return { env: (name: string) => (name === 'DEPLOY_STATE_DIR' ? dir : undefined) } as never
}

beforeEach(() => {
  h.known = new Set()
  h.since = []
  h.inserted = []
  h.infos = []
})

describe('folding the deploy journal in', () => {
  it('stores a bare digest as sha256:<hex>, and asks the registry with that spelling', async () => {
    const ctx = await journal(line('2026-09-30T10:00:00Z', HEX))
    await ingestDeployments(ctx, 'app-1', 'iris')
    expect(h.inserted.map((r) => r.digest)).toEqual([`sha256:${HEX}`])
    expect(h.infos).toEqual([`sha256:${HEX}`])
  })

  it('reads the known rows from the journal’s earliest line on, and skips what they hold', async () => {
    const ctx = await journal(
      line('2026-09-30T12:00:00Z', `sha256:${'b'.repeat(64)}`),
      line('2026-09-30T10:00:00Z', HEX),
    )
    h.known = new Set([`sha256:${HEX}@2026-09-30T10:00:00.000Z`])
    await ingestDeployments(ctx, 'app-1', 'iris')
    expect(h.since).toEqual([new Date('2026-09-30T10:00:00Z')])
    expect(h.inserted.map((r) => r.digest)).toEqual([`sha256:${'b'.repeat(64)}`])
  })
})
