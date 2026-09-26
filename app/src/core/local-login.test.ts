import { hash } from '@node-rs/argon2'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ADMIN_GROUP } from './auth'
import { allow, localAuthorization } from './authz'
import {
  announceSetupToken,
  createFirstAdmin,
  endLocalSession,
  LOCAL_ACTOR_PREFIX,
  type LocalLoginStore,
  localIdentity,
  localLoginState,
  verifyLocalLogin,
  WRONG_CREDENTIALS,
} from './local-login'

// The break-glass login, asserted against a fake store — never the box's
// database, and never with the login on anywhere but in here.
//
// Four properties, each invisible from the outside when it breaks: off means
// NOTHING (no cookie read, no row, no token); the setup token really gates
// the first admin; a wrong password writes nothing; and a local session is
// an admin to the same `allow` every mutation runs. argon2 is real — the
// point of the third property is the hash, so faking it would test nothing.

// `@tanstack/react-start/server` reads an ambient request that no test has;
// the fake store below never reaches it, but the module imports it.
vi.mock('@tanstack/react-start/server', () => ({
  getCookie: () => undefined,
  getRequestProtocol: () => 'https',
  unsealSession: async () => ({}),
  useSession: async () => ({ update: async () => {}, clear: async () => {} }),
  getRequestHeader: () => undefined,
}))
vi.mock('../host/db', () => ({ db: {} }))
vi.mock('../host/contract/domains/site-doc', () => ({
  readCommittedSite: async () => ({ ok: false, reason: null }),
}))

type Fake = LocalLoginStore & {
  rows: { id: string; username: string; passwordHash: string; lastLoginAt: number | null }[]
  settings_: Map<string, unknown>
  cookieUser: string | null
  written: string[]
  logged: string[]
  on: boolean
  clock: number
  sessionReads: number
}

const fake = (o: Partial<Pick<Fake, 'on' | 'cookieUser' | 'clock'>> = {}): Fake => {
  const f: Fake = {
    rows: [],
    settings_: new Map(),
    cookieUser: o.cookieUser ?? null,
    written: [],
    logged: [],
    on: o.on ?? true,
    clock: o.clock ?? 1_800_000_000_000,
    sessionReads: 0,
    enabled: async () => f.on,
    admins: {
      any: async () => f.rows.length > 0,
      find: async (u) => f.rows.find((r) => r.username === u) ?? null,
      insert: async (username, passwordHash) => {
        f.rows.push({
          id: `a-${String(f.rows.length + 1)}`,
          username,
          passwordHash,
          lastLoginAt: null,
        })
      },
      stampLogin: async (id) => {
        const r = f.rows.find((x) => x.id === id)
        if (r) r.lastLoginAt = f.clock
      },
    },
    settings: {
      read: async <T>(key: string, guard: (v: unknown) => v is T) => {
        const v = f.settings_.get(key)
        return guard(v) ? v : undefined
      },
      write: async (key, value) => {
        f.settings_.set(key, value)
      },
      delete: async (key) => {
        f.settings_.delete(key)
      },
    },
    session: {
      read: async () => {
        f.sessionReads += 1
        return f.cookieUser
      },
      write: async (u) => {
        f.written.push(u)
        f.cookieUser = u
      },
      clear: async () => {
        f.written.push('<clear>')
        f.cookieUser = null
      },
    },
    log: (line) => {
      f.logged.push(line)
    },
    now: () => f.clock,
  }
  return f
}

/** The token the journal line carries, pulled back out of the fake's log. */
const tokenFrom = (f: Fake): string => {
  const line = f.logged.at(-1) ?? ''
  const m = /(dsetup_[A-Za-z0-9_-]+)/.exec(line)
  if (m === null) throw new Error(`no token in: ${line}`)
  return m[1] as string
}

describe('off', () => {
  // The default: site.json does not turn it on. Everything below must be unobservable.
  let f: Fake
  beforeEach(() => {
    f = fake({ on: false, cookieUser: 'ghost' })
  })

  it('has no login page', async () => {
    expect(await localLoginState(f)).toBeNull()
  })

  it('does not even read the cookie, and yields nobody', async () => {
    expect(await localIdentity(f)).toBeNull()
    expect(f.sessionReads).toBe(0)
  })

  it('prints no token and writes nothing', async () => {
    expect(await announceSetupToken({ ran: false }, f)).toBe('off')
    expect(f.logged).toEqual([])
    expect(f.settings_.size).toBe(0)
  })

  it('refuses to create an admin or sign in, as a throw, writing nothing', async () => {
    await expect(
      createFirstAdmin({ token: 'x', username: 'op', password: 'p'.repeat(16) }, f),
    ).rejects.toThrow(/off/)
    await expect(verifyLocalLogin({ username: 'op', password: 'p'.repeat(16) }, f)).rejects.toThrow(
      /off/,
    )
    await endLocalSession(f)
    expect(f.rows).toEqual([])
    expect(f.written).toEqual([])
  })
})

describe('the setup token', () => {
  it('is printed once per process, while no admin exists', async () => {
    const f = fake()
    const memo = { ran: false }
    expect(await announceSetupToken(memo, f)).toBe('announced')
    expect(f.logged).toHaveLength(1)
    expect(f.logged[0]).toMatch(/shown once/)
    // The stored row is a digest, never the token.
    const stored = JSON.stringify([...f.settings_.values()])
    expect(stored).not.toContain(tokenFrom(f))
    expect(await announceSetupToken(memo, f)).toBe('off')
    expect(f.logged).toHaveLength(1)
  })

  it('is never printed again once an admin exists', async () => {
    const f = fake()
    f.rows.push({ id: 'a-1', username: 'op', passwordHash: 'x', lastLoginAt: null })
    expect(await announceSetupToken({ ran: false }, f)).toBe('admins-exist')
    expect(f.logged).toEqual([])
    expect(f.settings_.size).toBe(0)
  })

  it('gates the first admin: wrong, missing and expired tokens create nothing', async () => {
    const f = fake()
    await announceSetupToken({ ran: false }, f)
    const good = tokenFrom(f)
    const attempt = (token: string) =>
      createFirstAdmin({ token, username: 'op', password: 'correct horse battery' }, f)

    for (const bad of ['', 'dsetup_nope', `${good}x`, good.slice(0, -1)]) {
      const r = await attempt(bad)
      expect(r.ok, bad).toBe(false)
      expect(f.rows, bad).toEqual([])
      expect(f.written, bad).toEqual([])
    }
    f.clock += 25 * 60 * 60_000
    expect((await attempt(good)).ok).toBe(false)
    expect(f.rows).toEqual([])
  })

  it('creates the first admin with the right token, forgets the token, signs in', async () => {
    const f = fake()
    await announceSetupToken({ ran: false }, f)
    const token = tokenFrom(f)
    expect(
      await createFirstAdmin({ token, username: 'op', password: 'correct horse battery' }, f),
    ).toEqual({ ok: true, value: null })
    expect(f.rows).toHaveLength(1)
    expect(f.rows[0]?.passwordHash).toMatch(/^\$argon2id\$/)
    expect(f.rows[0]?.passwordHash).not.toContain('correct horse')
    expect(f.settings_.has('auth.localSetupToken')).toBe(false)
    expect(f.written).toEqual(['op'])
    // And a second admin cannot be created through this door.
    const again = await createFirstAdmin(
      { token, username: 'other', password: 'correct horse battery' },
      f,
    )
    expect(again.ok).toBe(false)
    expect(f.rows).toHaveLength(1)
  })

  it('refuses a bad username or a short password before writing', async () => {
    const f = fake()
    await announceSetupToken({ ran: false }, f)
    const token = tokenFrom(f)
    expect(
      (await createFirstAdmin({ token, username: 'Op!', password: 'correct horse battery' }, f)).ok,
    ).toBe(false)
    expect((await createFirstAdmin({ token, username: 'op', password: 'short' }, f)).ok).toBe(false)
    expect(f.rows).toEqual([])
    expect(f.settings_.has('auth.localSetupToken')).toBe(true)
  })
})

describe('signing in', () => {
  const PASSWORD = 'correct horse battery'
  let f: Fake
  beforeEach(async () => {
    f = fake()
    f.rows.push({
      id: 'a-1',
      username: 'op',
      passwordHash: await hash(PASSWORD),
      lastLoginAt: null,
    })
  })

  it('refuses a wrong password with one sentence and writes nothing', async () => {
    for (const [u, p] of [
      ['op', 'wrong password here'],
      ['nobody', PASSWORD],
      ['', PASSWORD],
      ['op', ''],
    ]) {
      expect(await verifyLocalLogin({ username: u as string, password: p as string }, f)).toEqual({
        ok: false,
        reason: WRONG_CREDENTIALS,
      })
    }
    expect(f.written).toEqual([])
    expect(f.rows[0]?.lastLoginAt).toBeNull()
  })

  it('signs in on the right password, stamping the row and the cookie', async () => {
    expect(await verifyLocalLogin({ username: 'op', password: PASSWORD }, f)).toEqual({
      ok: true,
      value: null,
    })
    expect(f.written).toEqual(['op'])
    expect(f.rows[0]?.lastLoginAt).toBe(f.clock)
    expect(await localLoginState(f)).toEqual({ mode: 'login', signedInAs: 'op' })
  })

  it('signs out', async () => {
    await verifyLocalLogin({ username: 'op', password: PASSWORD }, f)
    await endLocalSession(f)
    expect(f.cookieUser).toBeNull()
    expect(await localIdentity(f)).toBeNull()
  })
})

describe('the identity a session yields', () => {
  it('is the namespaced actor, and passes the enforced admin gate', async () => {
    const f = fake({ cookieUser: 'op' })
    f.rows.push({ id: 'a-1', username: 'op', passwordHash: 'x', lastLoginAt: null })
    const identity = await localIdentity(f)
    expect(identity).toEqual({ actor: `${LOCAL_ACTOR_PREFIX}op`, username: 'op' })
    if (identity === null) throw new Error('unreachable')
    const decision = localAuthorization(identity, true)
    expect(decision.groups).toEqual([ADMIN_GROUP])
    expect(allow(decision)).toEqual({ ok: true, value: 'local:op' })
  })

  it('dies with its row: a cookie naming a deleted admin is nobody', async () => {
    const f = fake({ cookieUser: 'gone' })
    expect(await localIdentity(f)).toBeNull()
  })
})
