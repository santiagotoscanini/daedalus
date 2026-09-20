import { describe, expect, it, vi } from 'vitest'
import {
  ADMIN_GROUP,
  describeGroups,
  groupsOf,
  isAdmin,
  NO_ACTOR_REASON,
  NOT_ADMIN_REASON,
} from './auth'
import { type Authorization, allow, assertMachineActor, setEnforcingAdmins } from './authz'

// Two rules, asserted apart from the database that stores the flag.
//
// `allow` is the whole authorization decision as a pure function, which is why
// it is exported separately from `requireAdmin`: the interesting cases are the
// combinations of (signed in?) x (admin?) x (enforced?), and none of them
// should need a Postgres to state. `enforcingAdmins` is the only part that
// reads a row, and it is a one-line `readSetting` with a boolean guard.

/** A request as traefik's forward-auth leaves it, groups included. */
const req = (email?: string, groups?: string): Request =>
  new Request('https://daedalus-app.test/', {
    headers: {
      ...(email === undefined ? {} : { 'x-forwarded-email': email }),
      ...(groups === undefined ? {} : { 'x-forwarded-groups': groups }),
    },
  })

describe('reading the groups header', () => {
  it('parses the JSON array the plugin renders', () => {
    expect(groupsOf(req('op@test', '["admins","family"]'))).toEqual([ADMIN_GROUP, 'family'])
    expect(groupsOf(req('op@test', '["family"]'))).toEqual(['family'])
  })

  it('reads every unusable header as no groups at all', () => {
    // Absent is the nix change not landed yet; blank is a traefik-bypassed
    // path, where the strip middleware ran and the plugin never re-set it;
    // the rest are shapes this app must not crash on. All of them must be
    // "not an admin", never an exception on a page that was only reading.
    for (const raw of [
      undefined,
      '',
      '   ',
      'admins',
      '[admins family]',
      '{"groups":["admins"]}',
      'null',
      '[1,2]',
      '["  "]',
      '[',
    ]) {
      expect(groupsOf(req('op@test', raw)), String(raw)).toEqual([])
      expect(isAdmin(groupsOf(req('op@test', raw))), String(raw)).toBe(false)
    }
  })

  it('says how the header arrived, not just what it parsed to', () => {
    // The arming panel renders this: `[]` alone cannot tell "the proxy sent
    // nothing" from "the proxy sent a list without admins", and the two
    // call for different fixes.
    expect(describeGroups(undefined)).toEqual({ state: 'absent', groups: [] })
    expect(describeGroups(null)).toEqual({ state: 'absent', groups: [] })
    expect(describeGroups('')).toEqual({ state: 'blank', groups: [] })
    expect(describeGroups('  ')).toEqual({ state: 'blank', groups: [] })
    expect(describeGroups('[admins family]')).toEqual({ state: 'unparseable', groups: [] })
    expect(describeGroups('{"g":1}')).toEqual({ state: 'unparseable', groups: [] })
    expect(describeGroups('[]')).toEqual({ state: 'list', groups: [] })
    expect(describeGroups('["family"]')).toEqual({ state: 'list', groups: ['family'] })
  })

  it('does not treat a lookalike group as the admin group', () => {
    for (const g of ['admin', 'Admins', 'admins-readonly', 'superadmins']) {
      expect(isAdmin([g]), g).toBe(false)
    }
    expect(isAdmin(['family', ADMIN_GROUP])).toBe(true)
  })
})

/** A decision, spelled out so each test names only what it is about. */
const decision = (o: Partial<Authorization>): Authorization => ({
  actor: { ok: true, value: 'op@example.test' },
  header: 'list',
  groups: [ADMIN_GROUP],
  admin: true,
  enforced: true,
  ...o,
})

describe('the decision', () => {
  it('lets an enforced admin through, and names them', () => {
    expect(allow(decision({}))).toEqual({ ok: true, value: 'op@example.test' })
  })

  it('refuses an enforced non-admin', () => {
    expect(allow(decision({ groups: ['family'], admin: false }))).toEqual({
      ok: false,
      reason: NOT_ADMIN_REASON,
    })
  })

  it('reports but does not refuse while the flag is off', () => {
    // The rollout state: the header may not even exist yet. A non-admin
    // decision must still hand back the actor, or every mutation on the box
    // stops working the moment this module is wired in.
    expect(allow(decision({ groups: [], admin: false, enforced: false }))).toEqual({
      ok: true,
      value: 'op@example.test',
    })
  })

  it('answers "not signed in" ahead of "not an admin"', () => {
    // Both are wrong, but they send the operator to different places: one is
    // a broken forward-auth gate, the other is a group they are not in.
    const anonymous = { ok: false as const, reason: NO_ACTOR_REASON }
    expect(allow(decision({ actor: anonymous, groups: [], admin: false }))).toEqual(anonymous)
    expect(
      allow(decision({ actor: anonymous, groups: [], admin: false, enforced: false })),
    ).toEqual(anonymous)
  })
})

describe('the machine door', () => {
  // The MCP server's callers have no session and no groups header — /mcp is in
  // authBypassRule, so traefik does not set one. `assertMachineActor` is the
  // ONE place that authorises them, and these are the three things it must
  // refuse, so it can never become the bypass flag it exists instead of.

  it('names the actor a write token writes under', () => {
    expect(assertMachineActor({ door: 'mcp-token', label: 'claude-code', scope: 'write' })).toBe(
      'mcp:claude-code',
    )
  })

  it('namespaces the label, so a record says which door it came through', () => {
    // `mcp:triage` and a person called triage must not be the same string in a
    // commit message, a build row or a journal line.
    expect(assertMachineActor({ door: 'mcp-token', label: 'triage', scope: 'write' })).toBe(
      'mcp:triage',
    )
  })

  it('refuses a read token', () => {
    expect(() => assertMachineActor({ door: 'mcp-token', label: 'triage', scope: 'read' })).toThrow(
      /read-only/,
    )
  })

  it('refuses a token with nothing to record the write under', () => {
    expect(() => assertMachineActor({ door: 'mcp-token', label: '  ', scope: 'write' })).toThrow(
      /no label/,
    )
  })

  it('refuses a door it does not know', () => {
    // The `door` field is not decoration: a future machine caller gets its own
    // value here and its own review, rather than inheriting this one's licence.
    expect(() =>
      assertMachineActor({
        door: 'something-else' as 'mcp-token',
        label: 'x',
        scope: 'write',
      }),
    ).toThrow(/unknown machine door/)
  })
})

describe('the switch', () => {
  // Settings › Developer › Authorization. The request that flips the switch
  // is the proof that the header has landed: arming from one the check would
  // refuse is the lockout the rollout order exists to prevent, so it is
  // refused here — server-side, not in a disabled button — and NOTHING is
  // written. Disarming is the way back out and must always work.

  it('refuses to arm from a request that does not carry admins, and writes nothing', async () => {
    for (const header of ['absent', 'blank', 'unparseable', 'list'] as const) {
      const write = vi.fn(async () => {})
      const r = await setEnforcingAdmins(
        true,
        decision({ header, groups: header === 'list' ? ['family'] : [], admin: false }),
        write,
      )
      expect(r.ok, header).toBe(false)
      if (!r.ok) expect(r.reason).toMatch(/refuse this very account/)
      expect(write, header).not.toHaveBeenCalled()
    }
  })

  it('arms from a request that carries admins', async () => {
    const write = vi.fn(async () => {})
    expect(await setEnforcingAdmins(true, decision({}), write)).toEqual({ ok: true, value: null })
    expect(write).toHaveBeenCalledWith('auth.enforceAdmins', true)
  })

  it('disarms from any request at all', async () => {
    for (const header of ['absent', 'blank', 'unparseable', 'list'] as const) {
      const write = vi.fn(async () => {})
      const r = await setEnforcingAdmins(
        false,
        decision({ header, groups: [], admin: false }),
        write,
      )
      expect(r, header).toEqual({ ok: true, value: null })
      expect(write).toHaveBeenCalledWith('auth.enforceAdmins', false)
    }
  })
})
