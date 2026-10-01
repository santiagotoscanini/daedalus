import { PgDialect } from 'drizzle-orm/pg-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ControllerNodeDetail } from '../../host/controller/wire'

// Every decision about a machine reaches the controller AND the gateway. A
// revoked or forgotten machine whose LiteLLM routes stayed published until the
// next five-minute sync was the gap: revoke is the "stop trusting it" button.
// A machine's own settings request, and the santree grant, reach the
// controller ALONE: neither moves a DHCP line or a route, and a DHCP write
// reloads pi-hole for the whole house.
//
// The database is a chain that answers each statement with the next rows
// queued in `h.rows` (one row `{id:'n1'}` when none is), and records what
// each update set; what matters here is what follows the write, and the
// SQL the patch writes is pinned on its own below.

const h = vi.hoisted(() => ({
  desired: 0,
  gateway: 0,
  dhcp: 0,
  rows: [] as unknown[][],
  sets: [] as Record<string, unknown>[],
}))

vi.mock('../../host/db', () => {
  const chain: Record<string, unknown> = {}
  for (const m of [
    'select',
    'from',
    'where',
    'update',
    'insert',
    'values',
    'onConflictDoNothing',
    'delete',
    'returning',
    'limit',
  ]) {
    chain[m] = () => chain
  }
  chain.set = (v: Record<string, unknown>) => {
    h.sets.push(v)
    return chain
  }
  // biome-ignore lint/suspicious/noThenProperty: a drizzle statement is awaited as a thenable
  chain.then = (ok: (rows: unknown[]) => unknown) =>
    Promise.resolve(h.rows.shift() ?? [{ id: 'n1' }]).then(ok)
  return { db: chain }
})
vi.mock('../../host/dhcp-hosts', () => ({
  householdMacs: async () => new Set<string>(),
  dhcpHostsMissing: () => false,
  writeDhcpHosts: async () => {
    h.dhcp++
    return true
  },
}))
vi.mock('../../host/controller/nodes', () => ({
  requestDesiredSync: () => {
    h.desired++
  },
  enrollValues: () => ({ id: 'n1' }),
  observedFacts: () => null,
}))
// No machine here logged in with a tunnel of its own.
vi.mock('./enroll', () => ({ enrollStore: { tunnelOf: async () => null } }))
vi.mock('../../host/gateway-sync', () => ({
  requestGatewaySync: () => {
    h.gateway++
  },
}))

const repo = await import('./nodes')
const { fingerprintOf } = await import('../../host/enroll')

beforeEach(() => {
  h.desired = 0
  h.gateway = 0
  h.dhcp = 0
  h.rows = []
  h.sets = []
})

describe('a decision about a machine', () => {
  it.each([
    ['approve', () => repo.approveNode('n1', 'alice')],
    ['enroll', () => repo.enrollNode({} as ControllerNodeDetail, 'alice')],
    ['revoke', () => repo.revokeNode('n1')],
    ['forget', () => repo.forgetNode('n1')],
    [
      'a policy save',
      () => repo.setNodePolicy('n1', { set: { awakeHold: false }, unset: [] }, 'alice'),
    ],
  ])('%s syncs the desired set, the gateway and the DHCP lines', async (_, act) => {
    expect(await act()).toBe(true)
    expect([h.desired, h.gateway, h.dhcp]).toEqual([1, 1, 1])
  })
})

describe('a policy patch', () => {
  const dialect = new PgDialect()
  const q = (set: object, unset: string[]) =>
    dialect.sqlToQuery(repo.policyPatchSql({ set, unset: unset as never }))

  it('removes the keys cleared, then merges the keys set, the row’s others kept', () => {
    const { sql, params } = q({ awakeHold: false }, ['claudeWorkdir', 'name'])
    expect(sql).toBe('("nodes"."policy" - $1::text - $2::text) || $3::jsonb')
    expect(params).toEqual(['claudeWorkdir', 'name', '{"awakeHold":false}'])
    expect(q({ santree: false }, []).sql).toBe('("nodes"."policy") || $1::jsonb')
  })

  it('records who changed it, and never turns santree on from a page', async () => {
    await repo.setNodePolicy('n1', { set: { claudeRemoteControl: false }, unset: [] }, 'alice')
    expect(h.sets[0]).toMatchObject({ policyChangedBy: 'alice' })
    expect(h.sets[0]?.policyChangedAt).toBeInstanceOf(Date)
    await expect(
      repo.setNodePolicy('n1', { set: { santree: true }, unset: [] }, 'alice'),
    ).rejects.toThrow(/confirmation/)
  })
})

describe('a machine asking for its settings', () => {
  it('writes only the keys asked for, as the machine, and syncs the controller alone', async () => {
    h.rows = [[{ id: 'n1', hostname: 'mac', policy: {} }]]
    expect(await repo.applyNodePolicyRequest('n1', { awakeHold: false })).toBe(true)
    expect(h.sets[0]).toMatchObject({ policyChangedBy: 'node:n1' })
    expect([h.desired, h.gateway, h.dhcp]).toEqual([1, 0, 0])
  })

  it('is a no-op when the row holds it already, or is not approved', async () => {
    // The UPDATE's own condition (state approved, NOT policy @> patch)
    // matched no row.
    h.rows = [[]]
    expect(await repo.applyNodePolicyRequest('n1', { claudeRemoteControl: true })).toBe(false)
    expect(h.desired).toBe(0)
  })

  it('never turns santree on, whatever reached it', async () => {
    await expect(repo.applyNodePolicyRequest('n1', { santree: true } as never)).rejects.toThrow(
      /only an admin/,
    )
    expect(await repo.applyNodePolicyRequest('n1', {})).toBe(false)
    expect(h.sets).toEqual([])
  })
})

describe('turning santree on (the confirmation)', () => {
  const key = '11'.repeat(32)
  const fingerprint = fingerprintOf(key)
  const row = (over: object = {}) => ({
    id: 'n1',
    publicKey: key,
    state: 'approved',
    hostname: 'mac',
    policy: {},
    ...over,
  })
  const deps = (host = true) => {
    const d = { synced: 0, sessionHost: async () => host, sync: async () => void d.synced++ }
    return d
  }
  const grant = (over: Partial<Parameters<typeof repo.grantSantree>[0]> = {}, d = deps()) =>
    repo.grantSantree({ id: 'n1', fingerprint, by: 'alice', ...over }, d)

  it('writes santree on under the admin, and answers once the controller has the set', async () => {
    const d = deps()
    h.rows = [[row()], [{ id: 'n1' }]]
    expect(await grant({}, d)).toEqual({ ok: true, already: false })
    expect(h.sets[0]).toMatchObject({ policyChangedBy: 'alice' })
    expect(d.synced).toBe(1)
    // The controller alone: no DHCP write, no gateway sync.
    expect([h.gateway, h.dhcp]).toEqual([0, 0])
  })

  it('refuses a key that moved, an unapproved row', async () => {
    h.rows = [[row()]]
    expect(await grant({ fingerprint: fingerprintOf('22'.repeat(32)) })).toMatchObject({
      ok: false,
    })
    h.rows = [[row({ state: 'revoked' })]]
    expect(await grant()).toEqual({ ok: false, reason: 'This machine is not approved.' })
    h.rows = [[]]
    expect((await grant()).ok).toBe(false)
    expect(h.sets).toEqual([])
  })

  it('answers "already" when it is on, and refuses without a session host', async () => {
    h.rows = [[row({ policy: { santree: true } })]]
    expect(await grant()).toEqual({ ok: true, already: true })
    h.rows = [[row()]]
    const none = await grant({}, deps(false))
    expect(none.ok ? '' : none.reason).toMatch(/no session host/)
    expect(h.sets).toEqual([])
  })
})
