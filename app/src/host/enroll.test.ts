import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import type { EnrollQuery } from '../lib/agent/enroll'
import type { DesiredSync } from './controller/nodes'
import { nodeIdOf } from './controller/nodes'
import type { SystemInfo } from './controller/wire'
import {
  CODE_MS,
  type CodeRow,
  codeHash,
  confirmEnroll,
  type EnrollDeps,
  type EnrollStore,
  enrollPage,
  FORM_TOKEN_MS,
  fingerprintOf,
  mintFormToken,
  type NodeStanding,
  type PageRequest,
  pkceMatches,
  portOf,
  redeemBody,
  redeemEnroll,
  releaseTunnel,
  type Tunnel,
  takeFormToken,
} from './enroll'
import { makeWgEasy, type WgEasy } from './wg-easy'

// The log-in's flow against fakes: an in-memory store, a wg-easy that records
// its calls and fails where told, a controller that answers or does not.

const KEY = 'ab'.repeat(32)
const ID = nodeIdOf(KEY)
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWjOEjXk'
/** The agent's own golden (agent/src/enroll/tests.rs `pkce_is_rfc_7636_s256`). */
const CHALLENGE = 'VYFANLqdx_HDV6BqEhluZJ63rtrIPROSSFdB3P6G83I'
const STATE = 'S'.repeat(43)
const LAN = '192.168.0.2'

const QUERY: EnrollQuery = {
  key: KEY,
  name: 'Santiagos-MacBook-Pro',
  os: 'macos',
  arch: 'aarch64',
  version: '0.23.0',
  port: 51234,
  state: STATE,
  challenge: CHALLENGE,
}

const conf = (address: string, allowed = `${LAN}/32`) => `[Interface]
PrivateKey = oK56DE9Ue9zK76rAc8pBl6opph+1v36lm7cXXsQKrQM=
Address = ${address}/32
MTU = 1280

[Peer]
PublicKey = HIgo9xNzJMWLKASShiTqIybxZ0U3wGLiUeJ1PKf8ykw=
PresharedKey = FpCyhws9cxwWoV4xELtfJvjJN+zQVRPISllRWgeopVE=
AllowedIPs = ${allowed}
PersistentKeepalive = 25
Endpoint = box.example.org:51820`

type Row = NodeStanding & { publicKey: string; hostname: string }

function memoryStore() {
  const nodes = new Map<string, Row>()
  const tunnels = new Map<string, Tunnel>()
  const codes = new Map<string, CodeRow>()
  const store: EnrollStore = {
    standing: async (id) => {
      const n = nodes.get(id)
      return n === undefined
        ? null
        : {
            state: n.state,
            approvedAt: n.approvedAt,
            approvedBy: n.approvedBy,
            revokedAt: n.revokedAt,
          }
    },
    approve: async (r) => {
      const n = nodes.get(r.id)
      const prior =
        n === undefined
          ? null
          : {
              state: n.state,
              approvedAt: n.approvedAt,
              approvedBy: n.approvedBy,
              revokedAt: n.revokedAt,
            }
      nodes.set(r.id, {
        publicKey: r.publicKey,
        hostname: n?.hostname ?? r.hostname,
        state: 'approved',
        approvedAt: new Date(),
        approvedBy: r.by,
        revokedAt: null,
      })
      return prior
    },
    restore: async (id, prior) => {
      if (prior === null) nodes.delete(id)
      else {
        const n = nodes.get(id)
        if (n !== undefined) nodes.set(id, { ...n, ...prior })
      }
    },
    tunnelOf: async (id) => tunnels.get(id) ?? null,
    setTunnel: async (id, t) => {
      tunnels.set(id, t)
    },
    deleteTunnel: async (id) => {
      tunnels.delete(id)
    },
    putCode: async (row) => {
      codes.set(row.codeHash, row)
    },
    takeCode: async (hash) => {
      const row = codes.get(hash) ?? null
      codes.delete(hash)
      return row
    },
  }
  return { store, nodes, tunnels, codes }
}

type Step =
  | 'getInterface'
  | 'updateInterface'
  | 'createClient'
  | 'getClient'
  | 'updateClient'
  | 'configuration'
  | 'deleteClient'

function fakeWg(opts: { failAt?: Step; firewall?: boolean; allowed?: string } = {}) {
  const calls: string[] = []
  const clients = new Map<number, Record<string, unknown>>()
  let iface: Record<string, unknown> = { name: 'wg0', firewallEnabled: opts.firewall ?? false }
  let next = 7
  const step = (s: Step, detail = '') => {
    calls.push(detail === '' ? s : `${s} ${detail}`)
    if (opts.failAt === s) throw new Error(`wg-easy answered ${s} with 500`)
  }
  const wg: WgEasy = {
    getInterface: async () => {
      step('getInterface')
      return { ...iface }
    },
    updateInterface: async (i) => {
      step('updateInterface')
      iface = { ...i }
    },
    createClient: async (name) => {
      step('createClient', name)
      const id = next++
      clients.set(id, {
        id,
        name,
        ipv4Address: `10.8.0.${String(id)}`,
        allowedIps: null,
        firewallIps: null,
      })
      return id
    },
    getClient: async (id) => {
      step('getClient', String(id))
      return { ...(clients.get(id) as Record<string, unknown>), id }
    },
    updateClient: async (id, c) => {
      step('updateClient', String(id))
      clients.set(id, { ...c })
    },
    configuration: async (id) => {
      step('configuration', String(id))
      const c = clients.get(id)
      if (c === undefined) throw new Error('404')
      return conf(String(c.ipv4Address), opts.allowed)
    },
    deleteClient: async (id) => {
      step('deleteClient', String(id))
      clients.delete(id)
    },
  }
  return { wg, calls, clients, iface: () => iface }
}

const SYSTEM = {
  controller: {
    publicKey: 'cd'.repeat(32),
    fingerprint: 'c0de:f00d',
    listen: '0.0.0.0:7788',
    advertise: ['box.example.org:7788'],
    rotation: null,
  },
} as unknown as SystemInfo

function syncOk(): { sync: () => Promise<DesiredSync>; count: () => number; sets: string[][] } {
  let n = 0
  const sets: string[][] = []
  return {
    count: () => n,
    sets,
    sync: async () => {
      n++
      return {
        at: '',
        sent: [{ id: ID, state: 'approved' }],
        skipped: [],
        answer: null,
        error: null,
      }
    },
  }
}

function deps(over: Partial<EnrollDeps> & { store: EnrollStore; wg: WgEasy }): EnrollDeps {
  return {
    systemInfo: async () => SYSTEM,
    sync: syncOk().sync,
    lanIp: LAN,
    hostAlias: '169.254.1.2',
    sessionHostPort: 7789,
    log: () => {},
    ...over,
  }
}

const tokenFor = (actor = 'santi', q: EnrollQuery = QUERY, now?: number) =>
  mintFormToken({ query: q, fingerprint: fingerprintOf(q.key), actor }, now)
const typed = fingerprintOf(KEY).slice(0, 4)

describe('keys and PKCE', () => {
  it('fingerprints a key as the agent does (SHA-256, hex in fours)', () => {
    // SHA-256 of 32 zero bytes, a value anyone can check.
    expect(fingerprintOf('00'.repeat(32))).toBe(
      '6668:7aad:f862:bd77:6c8f:c18b:8e9f:8e20:0897:1485:6ee2:33b3:902a:591d:0d5f:2925',
    )
    expect(fingerprintOf(KEY).replaceAll(':', '').slice(0, 16)).toBe(ID)
  })
  it('checks S256 against the agent’s own golden', () => {
    expect(pkceMatches(VERIFIER, CHALLENGE)).toBe(true)
    expect(pkceMatches(`${VERIFIER.slice(0, -1)}A`, CHALLENGE)).toBe(false)
    expect(pkceMatches(VERIFIER, CHALLENGE.slice(1))).toBe(false)
    expect(pkceMatches(VERIFIER, '')).toBe(false)
  })
  it('reads the controller’s port', () => {
    expect(portOf('box.example.org:7788')).toBe(7788)
    expect(portOf('0.0.0.0:7788')).toBe(7788)
    expect(portOf('box.example.org')).toBeNull()
    expect(portOf(null)).toBeNull()
  })
})

describe('the form token', () => {
  it('is spent by its first use', () => {
    const t = tokenFor()
    expect(takeFormToken(t)?.query.key).toBe(KEY)
    expect(takeFormToken(t)).toBeNull()
  })
  it('expires', () => {
    const t = tokenFor('santi', QUERY, 1_000)
    expect(takeFormToken(t, 1_000 + FORM_TOKEN_MS)).toBeNull()
  })
  it('is unknown when made up', () => {
    expect(takeFormToken('made-up')).toBeNull()
  })
})

describe('the page', () => {
  const search = `?${new URLSearchParams({
    key: KEY,
    name: 'Santiagos-MacBook-Pro',
    os: 'macos',
    arch: 'aarch64',
    version: '0.23.0',
    port: '51234',
    state: STATE,
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
  }).toString()}`
  const req = (over: Partial<PageRequest> = {}): PageRequest => ({
    path: '/agent/enroll',
    search,
    site: 'none',
    mode: 'navigate',
    dest: 'document',
    referer: null,
    ...over,
  })
  const pageDeps = (over: Partial<Parameters<typeof enrollPage>[1]> = {}) => ({
    authorize: async () => ({ ok: true as const, value: 'santi' }),
    available: true,
    idpOrigin: 'https://id.example.org',
    standing: async () => null,
    ...over,
  })

  it('says “not available yet” while the box binds no wg-easy, and mints nothing', async () => {
    const p = await enrollPage(
      req(),
      pageDeps({
        available: false,
        standing: async () => {
          throw new Error('read')
        },
      }),
    )
    expect(p).toEqual({
      kind: 'unavailable',
      name: 'Santiagos-MacBook-Pro',
      declineUrl: `http://127.0.0.1:51234/callback?state=${STATE}&error=denied`,
    })
  })

  it('tells a viewer who is not an admin, minting nothing', async () => {
    const p = await enrollPage(
      req(),
      pageDeps({
        authorize: async () => ({
          ok: false,
          reason: 'Only members of the admins group can change this box.',
        }),
      }),
    )
    expect(p.kind).toBe('forbidden')
  })

  it('asks nobody who they are while it cannot make a tunnel', async () => {
    let asked = 0
    const p = await enrollPage(
      req(),
      pageDeps({
        available: false,
        authorize: async () => {
          asked++
          return { ok: false, reason: 'x' }
        },
      }),
    )
    expect(p.kind).toBe('unavailable')
    expect(asked).toBe(0)
  })

  it('refuses a bad link before anything else', async () => {
    const p = await enrollPage(req({ search: '?key=1' }), pageDeps({ available: false }))
    expect(p.kind).toBe('invalid')
  })

  it('refuses a router fetch of the page and a link from elsewhere, minting no token', async () => {
    expect((await enrollPage(req({ path: '/_serverFn/abc' }), pageDeps())).kind).toBe('invalid')
    expect((await enrollPage(req({ mode: 'cors', dest: 'empty' }), pageDeps())).kind).toBe(
      'refused',
    )
    expect((await enrollPage(req({ site: 'cross-site' }), pageDeps())).kind).toBe('refused')
    expect(
      (
        await enrollPage(
          req({ site: 'same-site', referer: 'https://iris.example.org/' }),
          pageDeps(),
        )
      ).kind,
    ).toBe('refused')
  })

  it('mints a token bound to the machine shown, when the menu bar opened it', async () => {
    for (const r of [req(), req({ site: 'same-site', referer: 'https://id.example.org/' })]) {
      const p = await enrollPage(
        r,
        pageDeps({
          standing: async () => ({
            state: 'revoked',
            approvedAt: null,
            approvedBy: null,
            revokedAt: new Date(),
          }),
        }),
      )
      if (p.kind !== 'ready') throw new Error(p.kind)
      expect(p.machine).toEqual({
        id: ID,
        name: 'Santiagos-MacBook-Pro',
        os: 'macos',
        arch: 'aarch64',
        version: '0.23.0',
        fingerprint: fingerprintOf(KEY),
      })
      expect(p.standing).toBe('revoked')
      const t = takeFormToken(p.token)
      expect(t?.query).toEqual(QUERY)
      expect(t?.actor).toBe('santi')
    }
  })
})

describe('Confirm', () => {
  let mem: ReturnType<typeof memoryStore>
  beforeEach(() => {
    mem = memoryStore()
  })

  it('approves, tells the controller, makes a confined client, and hands the loopback a code', async () => {
    const w = fakeWg()
    const s = syncOk()
    const r = await confirmEnroll(deps({ store: mem.store, wg: w.wg, sync: s.sync }), {
      token: tokenFor(),
      typed,
      actor: 'santi',
    })
    if (!r.ok) throw new Error(r.reason)
    expect(mem.nodes.get(ID)?.state).toBe('approved')
    expect(mem.nodes.get(ID)?.approvedBy).toBe('santi')
    expect(s.count()).toBe(1)
    // The firewall turned on first, then the client made, confined and read.
    expect(w.calls).toEqual([
      'getInterface',
      'updateInterface',
      'getInterface',
      'createClient daedalus-santiagos-macbook-pro',
      'getClient 7',
      'updateClient 7',
      'configuration 7',
    ])
    expect(w.iface().firewallEnabled).toBe(true)
    expect(w.clients.get(7)).toMatchObject({
      name: 'daedalus-santiagos-macbook-pro',
      allowedIps: [`${LAN}/32`],
      firewallIps: ['169.254.1.2:7788/tcp', '169.254.1.2:7789/tcp'],
      mtu: 1280,
      persistentKeepalive: 25,
    })
    expect(mem.tunnels.get(ID)).toEqual({ clientId: 7, address: '10.8.0.7' })
    const url = new URL(r.value.callback)
    expect(url.origin).toBe('http://127.0.0.1:51234')
    expect(url.pathname).toBe('/callback')
    expect(url.searchParams.get('state')).toBe(STATE)
    const code = url.searchParams.get('code') ?? ''
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/)
    // Stored by digest, bound to the challenge, the node and the client.
    const row = mem.codes.get(codeHash(code))
    expect(row).toMatchObject({
      nodeId: ID,
      clientId: 7,
      challenge: CHALLENGE,
      controllerPin: 'c0de:f00d',
      controllerAddress: `${LAN}:7788`,
    })
    expect([...mem.codes.keys()]).not.toContain(code)
  })

  it('keeps the token when the box cannot answer yet, so the same page tries again', async () => {
    const w = fakeWg()
    const t = tokenFor()
    const r = await confirmEnroll(deps({ store: mem.store, wg: w.wg, lanIp: '' }), {
      token: t,
      typed,
      actor: 'santi',
    })
    expect(r).toEqual({
      ok: false,
      reason: 'The box’s LAN address is not known here.',
      retry: true,
    })
    const down = await confirmEnroll(
      deps({
        store: mem.store,
        wg: w.wg,
        systemInfo: async () => {
          throw new Error('unreachable')
        },
      }),
      { token: t, typed, actor: 'santi' },
    )
    expect(down.ok ? null : down.retry).toBe(true)
    expect(mem.nodes.size).toBe(0)
    expect(
      (
        await confirmEnroll(deps({ store: mem.store, wg: w.wg }), {
          token: t,
          typed,
          actor: 'santi',
        })
      ).ok,
    ).toBe(true)
  })

  it('leaves an enabled firewall alone', async () => {
    const w = fakeWg({ firewall: true })
    const r = await confirmEnroll(deps({ store: mem.store, wg: w.wg }), {
      token: tokenFor(),
      typed,
      actor: 'santi',
    })
    expect(r.ok).toBe(true)
    expect(w.calls).not.toContain('updateInterface')
  })

  it('refuses a spent token, another admin’s, and the wrong characters, changing nothing', async () => {
    const w = fakeWg()
    const t = tokenFor()
    expect(
      (
        await confirmEnroll(deps({ store: mem.store, wg: w.wg }), {
          token: t,
          typed: '0000',
          actor: 'santi',
        })
      ).ok,
    ).toBe(false)
    // The token went with the wrong try.
    expect(
      (
        await confirmEnroll(deps({ store: mem.store, wg: w.wg }), {
          token: t,
          typed,
          actor: 'santi',
        })
      ).ok,
    ).toBe(false)
    expect(
      (
        await confirmEnroll(deps({ store: mem.store, wg: w.wg }), {
          token: tokenFor('other'),
          typed,
          actor: 'santi',
        })
      ).ok,
    ).toBe(false)
    expect(mem.nodes.size).toBe(0)
    expect(w.calls).toEqual([])
  })

  it('undoes the approval when the controller does not take it', async () => {
    const w = fakeWg()
    const r = await confirmEnroll(
      deps({
        store: mem.store,
        wg: w.wg,
        sync: async () => ({ at: '', sent: [], skipped: [], answer: null, error: 'not reachable' }),
      }),
      { token: tokenFor(), typed, actor: 'santi' },
    )
    expect(r.ok).toBe(false)
    expect(mem.nodes.has(ID)).toBe(false)
    expect(w.calls).toEqual([])
  })

  const failures: Step[] = [
    'updateInterface',
    'createClient',
    'getClient',
    'updateClient',
    'configuration',
  ]
  for (const step of failures) {
    it(`rolls back when wg-easy fails at ${step}`, async () => {
      const w = fakeWg({ failAt: step })
      const s = syncOk()
      const r = await confirmEnroll(deps({ store: mem.store, wg: w.wg, sync: s.sync }), {
        token: tokenFor(),
        typed,
        actor: 'santi',
      })
      expect(r.ok).toBe(false)
      expect(r.ok ? '' : r.reason).toContain('Nothing was changed')
      // The node that was not there is gone again, and the controller told.
      expect(mem.nodes.has(ID)).toBe(false)
      expect(s.count()).toBe(2)
      // A client that was made is deleted; none is left behind.
      expect(w.clients.size).toBe(0)
      const made = step !== 'updateInterface' && step !== 'createClient'
      expect(w.calls.includes('deleteClient 7')).toBe(made)
      expect(mem.tunnels.size).toBe(0)
      expect(mem.codes.size).toBe(0)
    })
  }

  it('rolls back a client whose AllowedIPs wg-easy did not keep', async () => {
    const w = fakeWg({ allowed: '0.0.0.0/0' })
    const r = await confirmEnroll(deps({ store: mem.store, wg: w.wg }), {
      token: tokenFor(),
      typed,
      actor: 'santi',
    })
    expect(r.ok).toBe(false)
    expect(w.clients.size).toBe(0)
  })

  it('puts a revoked machine back as it was when the tunnel fails', async () => {
    const revokedAt = new Date('2026-09-01T00:00:00Z')
    mem.nodes.set(ID, {
      publicKey: KEY,
      hostname: 'old',
      state: 'revoked',
      approvedAt: null,
      approvedBy: 'x',
      revokedAt,
    })
    const w = fakeWg({ failAt: 'configuration' })
    const r = await confirmEnroll(deps({ store: mem.store, wg: w.wg }), {
      token: tokenFor(),
      typed,
      actor: 'santi',
    })
    expect(r.ok).toBe(false)
    expect(mem.nodes.get(ID)).toMatchObject({ state: 'revoked', approvedBy: 'x', revokedAt })
  })

  it('restores the earlier tunnel’s record when the code cannot be stored', async () => {
    mem.tunnels.set(ID, { clientId: 3, address: '10.8.0.3' })
    const w = fakeWg()
    const store = {
      ...mem.store,
      putCode: async () => {
        throw new Error('db down')
      },
    }
    const r = await confirmEnroll(deps({ store, wg: w.wg }), {
      token: tokenFor(),
      typed,
      actor: 'santi',
    })
    expect(r.ok).toBe(false)
    expect(mem.tunnels.get(ID)).toEqual({ clientId: 3, address: '10.8.0.3' })
    expect(w.clients.size).toBe(0)
  })

  it('deletes the client an earlier log-in left, once the new one is in place', async () => {
    mem.tunnels.set(ID, { clientId: 3, address: '10.8.0.3' })
    const w = fakeWg()
    const r = await confirmEnroll(deps({ store: mem.store, wg: w.wg }), {
      token: tokenFor(),
      typed,
      actor: 'santi',
    })
    expect(r.ok).toBe(true)
    expect(w.calls.at(-1)).toBe('deleteClient 3')
    expect(mem.tunnels.get(ID)?.clientId).toBe(7)
  })
})

describe('the redeem', () => {
  async function confirmed(now = Date.now()) {
    const mem = memoryStore()
    const w = fakeWg()
    const r = await confirmEnroll(deps({ store: mem.store, wg: w.wg, now: () => now }), {
      token: tokenFor('santi', QUERY, now),
      typed,
      actor: 'santi',
    })
    if (!r.ok) throw new Error(r.reason)
    const code = new URL(r.value.callback).searchParams.get('code') ?? ''
    return { mem, w, code }
  }

  it('answers the machine’s tunnel and the controller, once', async () => {
    const { mem, w, code } = await confirmed()
    const a = await redeemEnroll(
      { store: mem.store, wg: w.wg, log: () => {} },
      { code, code_verifier: VERIFIER },
    )
    expect(a).toEqual({
      status: 200,
      body: {
        node: ID,
        controller: { pin: 'c0de:f00d', address: `${LAN}:7788` },
        wireguard: {
          private_key: 'oK56DE9Ue9zK76rAc8pBl6opph+1v36lm7cXXsQKrQM=',
          address: '10.8.0.7',
          server_public_key: 'HIgo9xNzJMWLKASShiTqIybxZ0U3wGLiUeJ1PKf8ykw=',
          preshared_key: 'FpCyhws9cxwWoV4xELtfJvjJN+zQVRPISllRWgeopVE=',
          endpoint: 'box.example.org:51820',
          allowed_ips: [`${LAN}/32`],
        },
      },
    })
    const again = await redeemEnroll(
      { store: mem.store, wg: w.wg, log: () => {} },
      { code, code_verifier: VERIFIER },
    )
    expect(again.status).toBe(400)
  })

  it('spends the code on a wrong verifier: the right one after it is refused too', async () => {
    const { mem, w, code } = await confirmed()
    const lines: string[] = []
    const d = { store: mem.store, wg: w.wg, log: (l: string) => lines.push(l) }
    const wrong = await redeemEnroll(d, { code, code_verifier: 'x'.repeat(43) })
    expect(wrong).toEqual({
      status: 400,
      body: { error: 'the verifier does not match; log in again' },
    })
    expect((await redeemEnroll(d, { code, code_verifier: VERIFIER })).status).toBe(400)
    expect(mem.codes.size).toBe(0)
    expect(lines.join('\n')).not.toContain(code)
  })

  it('refuses an expired code, and spends it', async () => {
    const t0 = 1_800_000_000_000
    const { mem, w, code } = await confirmed(t0)
    const a = await redeemEnroll(
      { store: mem.store, wg: w.wg, now: () => t0 + CODE_MS, log: () => {} },
      { code, code_verifier: VERIFIER },
    )
    expect(a).toEqual({ status: 400, body: { error: 'this code expired; log in again' } })
    expect(mem.codes.size).toBe(0)
  })

  it('refuses a machine revoked, or a tunnel replaced, since the Confirm', async () => {
    {
      const { mem, w, code } = await confirmed()
      const n = mem.nodes.get(ID)
      if (n !== undefined) n.state = 'revoked'
      expect(
        (
          await redeemEnroll(
            { store: mem.store, wg: w.wg, log: () => {} },
            { code, code_verifier: VERIFIER },
          )
        ).status,
      ).toBe(409)
    }
    {
      const { mem, w, code } = await confirmed()
      mem.tunnels.set(ID, { clientId: 99, address: '10.8.0.99' })
      expect(
        (
          await redeemEnroll(
            { store: mem.store, wg: w.wg, log: () => {} },
            { code, code_verifier: VERIFIER },
          )
        ).status,
      ).toBe(409)
    }
  })

  it('answers 502 when wg-easy cannot hand the config over', async () => {
    const { mem, w, code } = await confirmed()
    w.clients.clear()
    const a = await redeemEnroll(
      { store: mem.store, wg: w.wg, log: () => {} },
      { code, code_verifier: VERIFIER },
    )
    expect(a.status).toBe(502)
  })

  it('checks the body strictly, before any code is looked up', async () => {
    const mem = memoryStore()
    let looked = 0
    const store = {
      ...mem.store,
      takeCode: async () => {
        looked++
        return null
      },
    }
    const d = { store, wg: fakeWg().wg, log: () => {} }
    for (const body of [
      null,
      [],
      'x',
      { code: 'c'.repeat(43) },
      { code: 'c'.repeat(15), code_verifier: VERIFIER },
      { code: 'c'.repeat(43), code_verifier: 'short' },
      { code: 'c'.repeat(43), code_verifier: `${'v'.repeat(42)}!` },
      { code: 'c'.repeat(43), code_verifier: VERIFIER, extra: 1 },
    ]) {
      expect((await redeemEnroll(d, body)).status).toBe(400)
    }
    expect(looked).toBe(0)
    expect(redeemBody({ code: 'c'.repeat(43), code_verifier: VERIFIER }).ok).toBe(true)
    expect((await redeemEnroll(d, { code: 'c'.repeat(43), code_verifier: VERIFIER })).status).toBe(
      400,
    )
    expect(looked).toBe(1)
  })

  it('looks a code up by its digest, never by itself', () => {
    expect(codeHash('abc')).toBe(createHash('sha256').update('abc').digest('hex'))
  })
})

describe('a machine that leaves', () => {
  it('has its client deleted and its record gone', async () => {
    const mem = memoryStore()
    mem.tunnels.set(ID, { clientId: 7, address: '10.8.0.7' })
    const w = fakeWg()
    expect(await releaseTunnel({ store: mem.store, wg: w.wg }, ID, () => {})).toBe(true)
    expect(w.calls).toEqual(['deleteClient 7'])
    expect(mem.tunnels.size).toBe(0)
  })
  it('keeps the record when wg-easy fails or is not there, for the next try', async () => {
    const mem = memoryStore()
    mem.tunnels.set(ID, { clientId: 7, address: '10.8.0.7' })
    expect(
      await releaseTunnel(
        { store: mem.store, wg: fakeWg({ failAt: 'deleteClient' }).wg },
        ID,
        () => {},
      ),
    ).toBe(false)
    expect(await releaseTunnel({ store: mem.store, wg: null }, ID, () => {})).toBe(false)
    expect(mem.tunnels.size).toBe(1)
  })
  it('is nothing for a machine without a tunnel', async () => {
    const w = fakeWg()
    expect(await releaseTunnel({ store: memoryStore().store, wg: w.wg }, ID, () => {})).toBe(false)
    expect(w.calls).toEqual([])
  })
})

describe('wg-easy’s API', () => {
  type Seen = { method: string; url: string; auth: string | null; body: unknown }
  function api(answers: Record<string, () => Response>) {
    const seen: Seen[] = []
    let creds = 'daedalus-api:pw-one'
    const wg = makeWgEasy({
      base: 'http://wg-easy:51821/',
      credentials: async () => creds,
      fetch: async (url, init) => {
        const method = init.method ?? 'GET'
        seen.push({
          method,
          url,
          auth: new Headers(init.headers).get('authorization'),
          body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
        })
        const a = answers[`${method} ${new URL(url).pathname}`]
        return a === undefined ? new Response('{"message":"nope"}', { status: 404 }) : a()
      },
    })
    return {
      wg,
      seen,
      rotate: (c: string) => {
        creds = c
      },
    }
  }

  it('makes a client as the engine step verified, with Basic auth read per call', async () => {
    const a = api({
      'POST /api/client': () => Response.json({ success: true, clientId: 12 }),
      'GET /api/client/12': () => Response.json({ id: 12, name: 'x', privateKey: 'secret' }),
      'POST /api/client/12': () => Response.json({ success: true }),
      'GET /api/client/12/configuration': () => new Response('[Interface]\n'),
    })
    expect(await a.wg.createClient('daedalus-mac')).toBe(12)
    expect(a.seen[0]).toEqual({
      method: 'POST',
      url: 'http://wg-easy:51821/api/client',
      auth: `Basic ${Buffer.from('daedalus-api:pw-one').toString('base64')}`,
      body: { name: 'daedalus-mac', expiresAt: null },
    })
    a.rotate('daedalus-api:pw-two')
    expect((await a.wg.getClient(12)).id).toBe(12)
    expect(a.seen[1]?.auth).toBe(`Basic ${Buffer.from('daedalus-api:pw-two').toString('base64')}`)
    await a.wg.updateClient(12, { id: 12, allowedIps: ['192.168.0.2/32'] })
    expect(a.seen[2]).toMatchObject({ method: 'POST', url: 'http://wg-easy:51821/api/client/12' })
    expect(await a.wg.configuration(12)).toBe('[Interface]\n')
  })

  it('counts a client that is gone as deleted, and says why a call was refused', async () => {
    const a = api({
      'GET /api/admin/interface': () => new Response('{"message":"Unauthorized"}', { status: 401 }),
    })
    await a.wg.deleteClient(5)
    expect(a.seen[0]).toMatchObject({ method: 'DELETE', url: 'http://wg-easy:51821/api/client/5' })
    await expect(a.wg.getInterface()).rejects.toThrow(
      /401: Unauthorized \(the credentials were refused/,
    )
  })

  it('refuses a create that names no client id', async () => {
    const a = api({ 'POST /api/client': () => Response.json({ success: true }) })
    await expect(a.wg.createClient('x')).rejects.toThrow('did not say its id')
  })
})
