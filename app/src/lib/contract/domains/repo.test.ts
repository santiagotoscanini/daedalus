import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NO_REPO, repoFacts } from './repo'

// The reader over what host/repo-snapshot.sh publishes. The shapes here are
// the script's own output, so a change to either side that the other does
// not follow fails here rather than as an empty tab.

const envelope = (data: unknown, generatedAt = new Date().toISOString()) =>
  JSON.stringify({
    daedalusExport: 1,
    domain: 'repo',
    schemaVersion: 1,
    source: 'host',
    revision: null,
    generatedAt,
    data,
  })

const original = process.env.REPO_FACTS_PATH

async function publish(body: string): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'repo-facts-'))
  const path = join(dir, 'repo.json')
  await writeFile(path, body)
  process.env.REPO_FACTS_PATH = path
}

afterEach(() => {
  if (original === undefined) delete process.env.REPO_FACTS_PATH
  else process.env.REPO_FACTS_PATH = original
})

describe('repoFacts', () => {
  it('decodes a full snapshot', async () => {
    await publish(
      envelope({
        path: '/etc/nixos',
        remote: 'git@github.com:o/daedalus.git',
        branch: 'main',
        head: { rev: 'abc123', subject: 'x', committedAt: '2026-09-09T10:00:00-03:00' },
        tree: { modified: 2, untracked: 1 },
        upstream: { ref: 'origin/main', ahead: 1, behind: 0 },
        lastApply: null,
      }),
    )
    const r = await repoFacts()
    expect(r.available).toBe(true)
    expect(r.stale).toBe(false)
    expect(r.data.head?.rev).toBe('abc123')
    expect(r.data.tree).toEqual({ modified: 2, untracked: 1 })
    expect(r.data.upstream?.ahead).toBe(1)
    expect(r.data.lastApply).toBeNull()
  })

  it('tolerates the null-heavy shape of a repo with no upstream and no head', async () => {
    await publish(
      envelope({
        path: '/etc/nixos',
        remote: null,
        branch: null,
        head: null,
        tree: { modified: 0, untracked: 0 },
        upstream: null,
        lastApply: null,
      }),
    )
    const r = await repoFacts()
    expect(r.available).toBe(true)
    expect(r.data.remote).toBeNull()
    expect(r.data.head).toBeNull()
  })

  it('reports a stopped producer as stale, not as empty', async () => {
    await publish(envelope({ path: '/etc/nixos' }, new Date(Date.now() - 3_600_000).toISOString()))
    const r = await repoFacts()
    expect(r.available).toBe(true)
    expect(r.stale).toBe(true)
  })

  it('falls back when the file is missing', async () => {
    process.env.REPO_FACTS_PATH = '/nonexistent/repo.json'
    const r = await repoFacts()
    expect(r.available).toBe(false)
    expect(r.data).toEqual(NO_REPO)
  })
})
