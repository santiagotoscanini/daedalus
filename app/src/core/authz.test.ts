import { describe, expect, it } from 'vitest'
import { ADMIN_GROUP, groupsOf, isAdmin, NO_ACTOR_REASON, NOT_ADMIN_REASON } from './auth'
import { type Authorization, allow } from './authz'

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
