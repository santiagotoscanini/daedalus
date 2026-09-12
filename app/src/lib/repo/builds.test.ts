import { readdirSync, readFileSync } from 'node:fs'
import { getTableColumns } from 'drizzle-orm'
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import type { Executor } from '../db'
import { builds } from '../schema'
import {
  BUILD_LIST_COLUMNS,
  type BuildRecord,
  type BuildStatusPatch,
  claimQueued,
  claimQueuedQuery,
  getBuild,
  insertOrSupersedeQueued,
  isQueuedLaneConflict,
  listBuildsQuery,
  toBuildRow,
  UNREPORTED_LIMIT,
  unreportedBuildsQuery,
} from './builds'

// No database here (vitest points DATABASE_URL at a closed port): these pin the
// index the supersede transaction leans on, the SQL of the queue's one exit,
// and the shape of the migration that runs under a live app.

const DRIZZLE = new URL('../../../drizzle/', import.meta.url)

function migration(prefix: string): string {
  const file = readdirSync(DRIZZLE).find((n) => n.startsWith(prefix) && n.endsWith('.sql'))
  if (file === undefined) throw new Error(`no migration ${prefix}*.sql`)
  return readFileSync(new URL(file, DRIZZLE), 'utf8')
}

const AT = new Date('2026-09-11T00:00:00Z')
const ID = '0b6f3c1e-8a2d-4e5f-9c7b-1d2e3f4a5b6c'
const SHA_A = 'aaaaaaa000000000000000000000000000000001'
const SHA_B = 'bbbbbbb000000000000000000000000000000002'

const record = (over: Partial<BuildRecord> = {}): BuildRecord => ({
  id: ID,
  appId: 'a',
  lane: 'main',
  prNumber: null,
  sha: SHA_A,
  strategy: 'auto',
  resolvedStrategy: 'railpack',
  publish: 'live',
  requestedBy: 'webhook',
  actor: 'santiago',
  deliveryId: 'd-1',
  state: 'queued',
  phase: null,
  error: null,
  startedAt: null,
  detected: null,
  warnings: null,
  checks: null,
  timings: null,
  facts: null,
  checkRunId: 38_000_000_001,
  deploymentId: null,
  reported: false,
  digest: null,
  imageRef: null,
  sizeBytes: null,
  createdAt: AT,
  updatedAt: AT,
  ...over,
})

describe('builds_one_queued_per_lane', () => {
  it('is a unique index whose predicate is a literal, not a bound parameter', () => {
    const index = getTableConfig(builds).indexes.find(
      (i) => i.config.name === 'builds_one_queued_per_lane',
    )
    expect(index?.config.unique).toBe(true)
    const where = index?.config.where
    if (where === undefined) throw new Error('the partial index lost its WHERE')
    expect(new PgDialect().sqlToQuery(where, 'indexes')).toMatchObject({
      sql: `"state" = 'queued'`,
      params: [],
    })
  })
})

describe('isQueuedLaneConflict', () => {
  const violation = { code: '23505', constraint_name: 'builds_one_queued_per_lane' }

  it('finds the violation however deep drizzle wrapped it', () => {
    expect(isQueuedLaneConflict(violation)).toBe(true)
    expect(
      isQueuedLaneConflict(Object.assign(new Error('Failed query'), { cause: violation })),
    ).toBe(true)
    expect(isQueuedLaneConflict({ cause: { cause: violation } })).toBe(true)
  })

  it('refuses every other error, and survives a cause cycle', () => {
    const cycle: { cause?: unknown } = {}
    cycle.cause = cycle
    expect(isQueuedLaneConflict({ code: '23505', constraint_name: 'apps_name_idx' })).toBe(false)
    expect(isQueuedLaneConflict({ code: '40001' })).toBe(false)
    expect(isQueuedLaneConflict(new Error('boom'))).toBe(false)
    expect(isQueuedLaneConflict(cycle)).toBe(false)
    expect(isQueuedLaneConflict(null)).toBe(false)
    expect(isQueuedLaneConflict('23505')).toBe(false)
  })
})

/** A query builder stand-in: every call chains, and `end` resolves the rows. */
function chain(end: string, rows: unknown[]): Record<string, () => unknown> {
  const q: Record<string, () => unknown> = {}
  for (const method of ['from', 'where', 'limit', 'set', 'values']) q[method] = () => q
  q[end] = async () => rows
  return q
}

/** An executor whose transaction sees `waiting` as the lane's queued row. */
function fakeExecutor(waiting: BuildRecord | undefined) {
  const calls: string[] = []
  const inserted = record({ id: 'inserted', sha: SHA_B })
  const tx = {
    select: () => {
      calls.push('select')
      return chain('for', waiting === undefined ? [] : [waiting])
    },
    update: () => {
      calls.push('update')
      return chain('returning', waiting === undefined ? [] : [{ ...waiting, state: 'superseded' }])
    },
    insert: () => {
      calls.push('insert')
      return chain('returning', [inserted])
    },
  }
  const exec = { transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) }
  return { exec: exec as unknown as Executor, calls, inserted }
}

describe('insertOrSupersedeQueued', () => {
  const request = { appId: 'a', sha: SHA_B, strategy: 'auto', requestedBy: 'webhook' } as const

  it('returns the queued row untouched when it already has the sha', async () => {
    const waiting = record({ sha: SHA_B, deliveryId: 'first' })
    const { exec, calls } = fakeExecutor(waiting)
    const result = await insertOrSupersedeQueued({ ...request, deliveryId: 'second' }, exec)
    expect(result).toEqual({ row: waiting, superseded: [], alreadyQueued: true })
    expect(result.row.deliveryId).toBe('first')
    expect(calls).toEqual(['select'])
  })

  it('supersedes a queued row of another sha, then inserts', async () => {
    const { exec, calls, inserted } = fakeExecutor(record({ sha: SHA_A }))
    const result = await insertOrSupersedeQueued(request, exec)
    expect(result).toMatchObject({ row: inserted, alreadyQueued: false })
    expect(result.superseded.map((r) => r.state)).toEqual(['superseded'])
    expect(calls).toEqual(['select', 'update', 'insert'])
  })

  it('inserts into an empty lane', async () => {
    const { exec, calls, inserted } = fakeExecutor(undefined)
    const result = await insertOrSupersedeQueued(request, exec)
    expect(result).toEqual({ row: inserted, superseded: [], alreadyQueued: false })
    expect(calls).toEqual(['select', 'update', 'insert'])
  })
})

describe('claimQueued', () => {
  const NOW = new Date('2026-09-11T20:00:00Z')

  it('moves a row to cloning only while it is still queued, and returns it', () => {
    const { sql, params } = claimQueuedQuery(ID, NOW).toSQL()
    expect(sql).toMatch(
      /^update "builds" set "state" = \$1, "phase" = \$2, "started_at" = \$3, "updated_at" = \$4 where \("builds"\."id" = \$5 and "builds"\."state" = \$6\) returning "id", /,
    )
    expect(params).toEqual([
      'cloning',
      'requested',
      NOW.toISOString(),
      NOW.toISOString(),
      ID,
      'queued',
    ])
  })

  it('answers a malformed id without querying', async () => {
    // A query would reject with a connection refusal, not resolve.
    await expect(claimQueued('../../etc/passwd', NOW)).resolves.toBeUndefined()
  })
})

describe('BuildStatusPatch', () => {
  it('cannot put a row back in the queue', () => {
    // @ts-expect-error `queued` is entered by insert and left by claimQueued, never folded back.
    const back: BuildStatusPatch = { state: 'queued' }
    const on: BuildStatusPatch = { state: 'cloning' }
    expect([back.state, on.state]).toEqual(['queued', 'cloning'])
  })
})

describe('toBuildRow', () => {
  it('hands build-queue no null phase or timings, keeps a null warnings, and carries the app name', () => {
    const row = toBuildRow({ ...record(), app: 'demo' })
    expect(row).toMatchObject({
      app: 'demo',
      phase: '',
      timings: {},
      // Null, not []: nobody computed warnings for this row, and the two are
      // different claims (lib/schema.ts builds.warnings).
      warnings: null,
      strategy: 'auto',
      resolvedStrategy: 'railpack',
      actor: 'santiago',
      deliveryId: 'd-1',
      checkRunId: 38_000_000_001,
      reported: false,
    })
  })

  it('carries detected raw, as the status wrote it', () => {
    const raw = { info: { success: true, railpackVersion: '0.39.0' }, plan: { deploy: {} } }
    expect(toBuildRow({ ...record({ detected: raw }), app: 'demo' }).detected).toBe(raw)
  })
})

describe('getBuild', () => {
  it('answers a malformed id without querying', async () => {
    // A query would reject with a connection refusal, not resolve.
    await expect(getBuild('../../etc/passwd')).resolves.toBeUndefined()
  })
})

describe('list reads', () => {
  const HEAVY = ['detected', 'checks', 'timings', 'warnings']
  const heavyColumn = /"(detected|checks|timings|warnings)"/

  it('select every column but detected, checks, timings and warnings', () => {
    for (const k of HEAVY) expect(BUILD_LIST_COLUMNS).not.toHaveProperty(k)
    expect(Object.keys(BUILD_LIST_COLUMNS).sort()).toEqual(
      Object.keys(getTableColumns(builds))
        .filter((k) => !HEAVY.includes(k))
        .sort(),
    )
    const { sql } = listBuildsQuery(ID).toSQL()
    expect(sql).not.toMatch(heavyColumn)
    expect(sql).toContain('"builds"."sha"')
  })

  it('come back from the claim too', () => {
    expect(claimQueuedQuery(ID, AT).toSQL().sql).not.toMatch(heavyColumn)
  })

  it('read unreported builds of the window only, newest first, twenty at most', () => {
    const since = new Date('2026-09-10T00:00:00Z')
    const { sql, params } = unreportedBuildsQuery(since).toSQL()
    expect(sql).toMatch(/"builds"\."updated_at" >= \$\d+/)
    expect(sql).toContain('order by "builds"."updated_at" desc')
    expect(sql).toMatch(/ limit \$\d+$/)
    expect(sql).not.toMatch(heavyColumn)
    expect(params).toContain(since.toISOString())
    expect(params).toContain(UNREPORTED_LIMIT)
    expect(UNREPORTED_LIMIT).toBe(20)
  })

  it('hand the queue a row with no detection, checks, timings or warnings', () => {
    const {
      detected: _d,
      checks: _c,
      timings: _t,
      warnings: _w,
      ...list
    } = record({ detected: { info: {} }, checks: { ran: ['lint'], failed: null } })
    expect(toBuildRow({ ...list, app: 'demo' })).toMatchObject({
      detected: null,
      checks: null,
      timings: {},
      warnings: null,
      checkRunId: 38_000_000_001,
    })
  })
})

describe('migration 0009', () => {
  const text = migration('0009_')
  const statements = text
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter((s) => s !== '')

  it('is additive — it runs under the live app', () => {
    const allowed = [
      /^CREATE TABLE "/,
      /^CREATE (UNIQUE )?INDEX "\w+" ON "(builds|github_deliveries)"/,
      /^ALTER TABLE "\w+" ADD COLUMN "/,
      /^ALTER TABLE "(builds|github_deliveries)" ADD CONSTRAINT "/,
    ]
    for (const s of statements) {
      expect(
        allowed.some((re) => re.test(s)),
        s,
      ).toBe(true)
      const column = /^ALTER TABLE "\w+" ADD COLUMN "\w+" (.+);$/.exec(s)?.[1]
      if (column?.includes('NOT NULL')) expect(column, s).toContain('DEFAULT ')
    }
  })

  it('writes the queued literal into the partial index', () => {
    expect(text).toContain(`("app_id","lane") WHERE "builds"."state" = 'queued';`)
  })
})
