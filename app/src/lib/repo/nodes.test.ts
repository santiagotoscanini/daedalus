import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ControllerNodeDetail } from '../../host/controller/wire'

// Every decision about a machine reaches the controller AND the gateway. A
// revoked or forgotten machine whose LiteLLM routes stayed published until the
// next five-minute sync was the gap: revoke is the "stop trusting it" button.
//
// The database is a chain that answers every statement with one row; what
// matters here is what follows the write, not the SQL.

const h = vi.hoisted(() => ({ desired: 0, gateway: 0, dhcp: 0 }))

vi.mock('../../host/db', () => {
  const chain: Record<string, unknown> = {}
  for (const m of [
    'select',
    'from',
    'where',
    'update',
    'set',
    'insert',
    'values',
    'onConflictDoNothing',
    'delete',
    'returning',
  ]) {
    chain[m] = () => chain
  }
  // biome-ignore lint/suspicious/noThenProperty: a drizzle statement is awaited as a thenable
  chain.then = (ok: (rows: unknown[]) => unknown) => Promise.resolve([{ id: 'n1' }]).then(ok)
  return { db: chain }
})
vi.mock('../../host/dhcp-hosts', () => ({
  householdMacs: async () => new Set<string>(),
  dhcpHostsMissing: () => false,
  writeDhcpHosts: async () => {
    h.dhcp++
  },
}))
vi.mock('../../host/controller/nodes', () => ({
  requestDesiredSync: () => {
    h.desired++
  },
  enrollValues: () => ({ id: 'n1' }),
  observedFacts: () => null,
}))
vi.mock('../../host/gateway-sync', () => ({
  requestGatewaySync: () => {
    h.gateway++
  },
}))

const repo = await import('./nodes')

beforeEach(() => {
  h.desired = 0
  h.gateway = 0
  h.dhcp = 0
})

describe('a decision about a machine', () => {
  it.each([
    ['approve', () => repo.approveNode('n1', 'alice')],
    ['enroll', () => repo.enrollNode({} as ControllerNodeDetail, 'alice')],
    ['revoke', () => repo.revokeNode('n1')],
    ['forget', () => repo.forgetNode('n1')],
    ['a policy save', () => repo.setNodePolicy('n1', {})],
  ])('%s syncs the desired set, the gateway and the DHCP lines', async (_, act) => {
    expect(await act()).toBe(true)
    expect(h).toEqual({ desired: 1, gateway: 1, dhcp: 1 })
  })
})
