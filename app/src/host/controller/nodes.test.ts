import { describe, expect, it } from 'vitest'
import { fakeController as fake } from './fake'
import type { NodeDetail, NodeSummary } from './generated'
import {
  type DecidedRow,
  desiredSet,
  enrollValues,
  ensureControllerLink,
  lastDesiredSync,
  nodeIdOf,
  observedFacts,
  readNode,
  syncDesired,
} from './nodes'
import { ControllerError } from './wire'

// The app's machine handling over the controller, against fakes: the live
// controller is never asked anything here, and no command is ever sent.

const KEY_A = 'ab'.repeat(32)
const KEY_B = 'cd'.repeat(32)
const KEY_C = 'ef'.repeat(32)

const row = (key: string, state: DecidedRow['state'], policy: DecidedRow['policy'] = {}) => ({
  id: nodeIdOf(key),
  publicKey: key,
  state,
  policy,
})

describe('the desired set', () => {
  it('ids are sixteen hex characters of the key’s SHA-256', () => {
    // sha256 of 32 bytes of 0xab.
    expect(nodeIdOf(KEY_A)).toMatch(/^[0-9a-f]{16}$/)
    expect(nodeIdOf(KEY_A)).not.toBe(nodeIdOf(KEY_B))
  })

  it('carries every approved key with its policy and name, and every revoked key without either', () => {
    const { nodes, skipped } = desiredSet([
      row(KEY_A, 'approved', {
        displayName: 'PC',
        awakeHold: false,
        claudeWorkdir: '  C:/p  ',
        santree: true,
        providers: { lemonade: { port: 8000, offer: true, models: {} } },
        hardware: { finish: 'space-black' },
      }),
      row(KEY_B, 'revoked', { awakeHold: true, santree: true }),
      row(KEY_C, 'approved'),
    ])
    expect(skipped).toEqual([])
    const byId = new Map(nodes.map((n) => [n.id, n]))
    expect(byId.get(nodeIdOf(KEY_A))).toEqual({
      id: nodeIdOf(KEY_A),
      public_key: KEY_A,
      state: 'approved',
      // The display name, for the machine label of its series.
      name: 'PC',
      // The agent's Policy plus the offer the controller keeps for its
      // metrics: nothing else of the box's own (names,
      // models, hardware), the workdir trimmed.
      policy: {
        policy: {
          awake_hold: false,
          claude_remote_control: true,
          claude_workdir: 'C:/p',
          santree: true,
          providers: { lemonade: { port: 8000 } },
        },
        offer_lemonade: true,
        alert_link: true,
      },
    })
    // A revoked key hears no policy, santree or not: the allow-list never holds it.
    expect(byId.get(nodeIdOf(KEY_B))).toEqual({
      id: nodeIdOf(KEY_B),
      public_key: KEY_B,
      state: 'revoked',
    })
    // No display name, no name: the controller labels it by its hostname.
    expect(byId.get(nodeIdOf(KEY_C))).not.toHaveProperty('name')
    // The agent's defaults for an empty policy; no workdir key at all.
    expect(byId.get(nodeIdOf(KEY_C))?.policy).toEqual({
      policy: {
        awake_hold: true,
        claude_remote_control: true,
        santree: false,
        providers: { lemonade: { port: 13305 } },
      },
      offer_lemonade: false,
      alert_link: true,
    })
    // Sorted by id, so the same table sends the same set.
    expect(nodes.map((n) => n.id)).toEqual([...nodes.map((n) => n.id)].sort())
  })

  it('leaves out a row whose key is not hex, and says so', () => {
    const { nodes, skipped } = desiredSet([
      { id: '0123456789abcdef', publicKey: 'not-a-key', state: 'approved', policy: {} },
      row(KEY_C, 'revoked'),
    ])
    expect(nodes.map((n) => n.id)).toEqual([nodeIdOf(KEY_C)])
    expect(skipped.map((s) => s.id)).toEqual(['0123456789abcdef'])
  })

  it('sends the whole set, records the answer, and never throws', async () => {
    const sent: unknown[] = []
    const client = fake({
      'nodes.set_desired': ({ nodes }) => {
        sent.push(nodes)
        return Promise.resolve({
          nodes: nodes.length,
          approved: [],
          revoked: [],
          pending: [],
          policy: [],
        })
      },
    })
    const rows = () => Promise.resolve([row(KEY_A, 'approved'), row(KEY_B, 'revoked')])
    const r = await syncDesired({ controller: client }, rows)
    expect(r.error).toBeNull()
    expect(r.answer?.nodes).toBe(2)
    expect(sent).toHaveLength(1)
    expect(r.sent.map((s) => s.state).sort()).toEqual(['approved', 'revoked'])
    expect(lastDesiredSync()).toBe(r)

    const down = await syncDesired({ controller: fake({}) }, rows)
    expect(down.answer).toBeNull()
    expect(down.error).toMatch(/fake: nodes.set_desired/)
    expect(lastDesiredSync()).toBe(down)
  })

  it('runs one sync at a time: a call while one is queued shares it', async () => {
    let n = 0
    const client = fake({
      'nodes.set_desired': () => {
        n += 1
        return Promise.resolve({ nodes: 0, approved: [], revoked: [], pending: [], policy: [] })
      },
    })
    const rows = () => Promise.resolve([])
    const [a, b] = [
      syncDesired({ controller: client }, rows),
      syncDesired({ controller: client }, rows),
    ]
    expect(a).toBe(b)
    await a
    expect(n).toBe(1)
  })
})

describe('the minute’s tick', () => {
  it('re-dials a controller whose connection is gone', async () => {
    const client = fake({
      'system.info': () => Promise.reject(new ControllerError('unreachable', 'down')),
    })
    await ensureControllerLink({ controller: client })
    expect(client.calls).toEqual(['system.info'])
  })
})

describe('what the controller observed', () => {
  const r = {
    hostname: 'PC',
    os: 'windows',
    arch: 'x86_64',
    agentVersion: '0.13.0',
    mac: 'aa:bb:cc:dd:ee:ff',
    lanIp: '192.168.0.120',
    lastSeenAt: new Date('2026-09-27T10:00:00Z'),
  }
  const seen: NodeSummary = {
    id: '0123456789abcdef',
    fingerprint: '',
    state: 'approved',
    connected: true,
    since: null,
    last_seen: '2026-09-27T10:05:00Z',
    hostname: 'PC',
    os: 'windows',
    arch: 'x86_64',
    agent_version: '0.14.0',
    lan_ip: '192.168.0.121',
    mac: 'aa:bb:cc:dd:ee:ff',
    claude: null,
    form: null,
    model: null,
    status: null,
    status_at: null,
  }

  it('names what moved', () => {
    expect(observedFacts(r, seen)).toEqual({
      agentVersion: '0.14.0',
      lanIp: '192.168.0.121',
      lastSeenAt: new Date('2026-09-27T10:05:00Z'),
    })
  })

  it('keeps the row when the controller has not heard from the machine, or nothing moved', () => {
    expect(observedFacts(r, { ...seen, hostname: null })).toBeNull()
    expect(
      observedFacts(r, {
        ...seen,
        agent_version: '0.13.0',
        lan_ip: '192.168.0.120',
        last_seen: null,
      }),
    ).toBeNull()
  })
})

describe('enrolment', () => {
  const detail = (over: Partial<NodeDetail> = {}): NodeDetail => ({
    id: nodeIdOf(KEY_A),
    fingerprint: '',
    state: 'pending',
    connected: true,
    since: null,
    last_seen: null,
    hostname: 'PC',
    os: 'windows',
    arch: 'x86_64',
    agent_version: '0.14.0',
    lan_ip: '192.168.0.120',
    mac: 'aa:bb:cc:dd:ee:ff',
    claude: null,
    form: null,
    model: null,
    public_key: KEY_A.toUpperCase(),
    hello: {
      proto: 1,
      node_id: nodeIdOf(KEY_A),
      agent_version: '0.14.0',
      os: 'windows',
      arch: 'x86_64',
      hostname: 'PC',
      mac: 'aa:bb:cc:dd:ee:ff',
      lan_ip: '192.168.0.120',
      facts: { os_name: '', os_version: '', cpu: '', memory_bytes: null },
      capabilities: [],
      telemetry: 'full',
    },
    status: null,
    status_at: null,
    telemetry: null,
    telemetry_at: null,
    providers: null,
    providers_at: null,
    ...over,
  })

  it('makes the row from the key and the hello', () => {
    expect(enrollValues(detail())).toEqual({
      id: nodeIdOf(KEY_A),
      publicKey: KEY_A,
      hostname: 'PC',
      os: 'windows',
      arch: 'x86_64',
      agentVersion: '0.14.0',
      mac: 'aa:bb:cc:dd:ee:ff',
      lanIp: '192.168.0.120',
    })
  })

  it('refuses what is not a waiting key the app may take', () => {
    expect(() => enrollValues(detail({ state: 'revoked' }))).toThrow(/not waiting/)
    expect(() => enrollValues(detail({ public_key: 'not-a-key' }))).toThrow(/64 hex/)
    expect(() => enrollValues(detail({ hello: null }))).toThrow(/no hello/)
  })
})

describe('reading one machine', () => {
  it('says a machine the controller never heard of is not connected', async () => {
    const r = await readNode(
      {
        controller: fake({
          'nodes.get': () => Promise.reject(new ControllerError('not_found', 'no machine')),
        }),
      },
      '0123456789abcdef',
    )
    expect(r.detail).toBeNull()
    expect(r.error).toMatch(/not connected/)
    const down = await readNode({ controller: fake({}) }, '0123456789abcdef')
    expect(down.error).toMatch(/^the controller: fake: nodes.get/)
  })
})
