import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readWorkspaces, workspaceFor } from './workspaces'

// The decode side of the workspaces contract. The producing half is
// stacks/daedalus/host/workspace-lib.sh's publish_workspaces; the envelope
// and field shapes here mirror what its jq emits.

let dir: string
let previousPath: string | undefined

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'workspaces-'))
  previousPath = process.env.WORKSPACES_PATH
  process.env.WORKSPACES_PATH = join(dir, 'workspaces.json')
})

afterEach(async () => {
  if (previousPath === undefined) delete process.env.WORKSPACES_PATH
  else process.env.WORKSPACES_PATH = previousPath
  await rm(dir, { recursive: true, force: true })
})

const envelope = (workspaces: unknown[]) => ({
  daedalusExport: 1,
  domain: 'workspaces',
  schemaVersion: 1,
  source: 'host',
  revision: null,
  generatedAt: new Date().toISOString(),
  data: { root: '/home/op/projects', workspaces },
})

const CLONE = {
  name: 'santree',
  remote: 'santree-ai/santree',
  branch: 'main',
  head: 'abc123def456',
  headAt: '2026-08-15T10:00:00-03:00',
  dirty: false,
  ahead: 0,
  behind: 2,
  sync: { result: 'ok', detail: '', at: '2026-08-16T09:30:00-03:00' },
}

describe('readWorkspaces', () => {
  it('decodes a published snapshot', async () => {
    await writeFile(join(dir, 'workspaces.json'), JSON.stringify(envelope([CLONE])), 'utf8')
    const result = await readWorkspaces()
    expect(result.available).toBe(true)
    expect(result.data.root).toBe('/home/op/projects')
    expect(result.data.workspaces).toEqual([CLONE])
  })

  it('tolerates a never-synced clone (sync null) and a non-GitHub remote', async () => {
    const raw = { ...CLONE, name: 'scratch', remote: null, ahead: null, behind: null, sync: null }
    await writeFile(join(dir, 'workspaces.json'), JSON.stringify(envelope([raw])), 'utf8')
    const result = await readWorkspaces()
    expect(result.available).toBe(true)
    expect(result.data.workspaces[0]?.sync).toBeNull()
    expect(result.data.workspaces[0]?.remote).toBeNull()
  })

  it('falls back to empty when the host has never published', async () => {
    const result = await readWorkspaces()
    expect(result.available).toBe(false)
    expect(result.data.workspaces).toEqual([])
  })
})

describe('workspaceFor', () => {
  const data = { root: '/home/op/projects', workspaces: [CLONE] }

  it('matches the remote slug case-insensitively (GitHub slugs are)', () => {
    expect(workspaceFor('Santree-AI/Santree', data)?.name).toBe('santree')
  })

  it('does not match a repo that is merely a prefix', () => {
    expect(workspaceFor('santree-ai/santree-cli', data)).toBeNull()
  })
})
