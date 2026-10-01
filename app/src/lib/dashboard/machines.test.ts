import { describe, expect, it } from 'vitest'
import type { NodeState, NodeSummary } from '../../host/controller/generated'
import type { NodeRow } from '../repo/nodes'
import { joinMachines } from './machines'

const seen = (id: string, state: NodeState, hostname: string | null = null): NodeSummary => ({
  id,
  fingerprint: `${id.slice(0, 4)}:…`,
  state,
  connected: state === 'pending',
  since: null,
  last_seen: null,
  hostname,
  os: null,
  arch: null,
  agent_version: null,
  lan_ip: null,
  mac: null,
  claude: null,
})

const node = (id: string, state: NodeRow['state'], name: string) =>
  ({ id, state, name }) as unknown as NodeRow

describe('Settings › Machines, joined', () => {
  it('lists the waiting keys first, then the approved rows, then the revoked', () => {
    const rows = [
      node('aaaaaaaaaaaaaaaa', 'revoked', 'Old'),
      node('bbbbbbbbbbbbbbbb', 'approved', 'PC'),
      node('cccccccccccccccc', 'approved', 'Mac'),
    ]
    const list = joinMachines(rows, [
      seen('bbbbbbbbbbbbbbbb', 'approved', 'PC'),
      seen('dddddddddddddddd', 'pending', 'Laptop'),
    ])
    expect(list.map((m) => m.node?.name ?? `waiting:${m.pending?.hostname}`)).toEqual([
      'waiting:Laptop',
      'Mac',
      'PC',
      'Old',
    ])
    expect(list[0]?.pending?.fingerprint).toBe('dddd:…')
  })

  it('merges by id: a key with a row is never offered again as waiting', () => {
    const list = joinMachines(
      [node('bbbbbbbbbbbbbbbb', 'approved', 'PC')],
      [seen('bbbbbbbbbbbbbbbb', 'pending', 'PC')],
    )
    expect(list).toHaveLength(1)
    expect(list[0]?.pending).toBeNull()
  })

  it('offers only pending keys without a row, not the unknown or the forgotten', () => {
    const list = joinMachines(
      [],
      [
        seen('eeeeeeeeeeeeeeee', 'unknown', 'Gone'),
        seen('ffffffffffffffff', 'approved', 'Forgotten'),
        seen('1111111111111111', 'pending'),
      ],
    )
    expect(list.map((m) => m.pending?.id)).toEqual(['1111111111111111'])
  })
})
