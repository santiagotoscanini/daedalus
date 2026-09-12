import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The webhook's app lookup: the pinned id first, the lowercased name only when
// nothing is pinned to that id. The database is a findFirst stub answering in
// order; each where clause is rendered to SQL to see which column it asked.

const h = vi.hoisted(() => ({
  answers: [] as unknown[],
  calls: [] as { where: unknown }[],
}))

vi.mock('../db', () => ({
  db: {
    query: {
      apps: {
        findFirst: async (config: { where: unknown }) => {
          h.calls.push(config)
          return h.answers.shift()
        },
      },
    },
  },
}))

const { appForRepository } = await import('./app-lookup')

const REPO_ID = 812_004_117
const dialect = new PgDialect()
const asked = (i: number) => {
  const q = dialect.sqlToQuery(h.calls[i]?.where as SQL)
  return { sql: q.sql, params: q.params.map(String) }
}

beforeEach(() => {
  h.answers = []
  h.calls = []
})

describe('appForRepository', () => {
  it('returns the app pinned to the repository id without asking by name', async () => {
    const pinned = { id: 'app-iris', name: 'iris', githubRepoId: REPO_ID }
    h.answers = [pinned]
    expect(await appForRepository(REPO_ID, 'iris-renamed')).toBe(pinned)
    expect(h.calls).toHaveLength(1)
    expect(asked(0).sql).toContain('"github_repo_id" = $1')
    expect(asked(0).params).toEqual([String(REPO_ID)])
  })

  it('falls back to the lowercased repo name when nothing is pinned to the id', async () => {
    const named = { id: 'app-iris', name: 'iris', githubRepoId: null }
    h.answers = [undefined, named]
    expect(await appForRepository(REPO_ID, 'Iris')).toBe(named)
    expect(h.calls).toHaveLength(2)
    expect(asked(1).sql).toContain('"name" = $1')
    expect(asked(1).params).toEqual(['iris'])
  })

  it('returns undefined when neither finds an app', async () => {
    h.answers = [undefined, undefined]
    expect(await appForRepository(REPO_ID, 'santree')).toBeUndefined()
  })
})
