import { describe, expect, it } from 'vitest'
import { ADMIN_GROUP, groupsOf, isAdmin, NO_ACTOR_REASON, NOT_ADMIN_REASON } from './auth'
import { type Authorization, allow, assertMachineActor } from './authz'

// `allow` is the whole authorization decision as a pure function, which is why
// it is exported apart from the request-reading `authorize`: the interesting
// cases are the combinations of (signed in?) x (admin?), and none of them
// should need a request to state.

describe('reading the groups claim', () => {
  it('keeps the strings of a list', () => {
    expect(groupsOf([ADMIN_GROUP, 'family'])).toEqual([ADMIN_GROUP, 'family'])
    expect(groupsOf(['family', 1, null, '  '])).toEqual(['family'])
  })

  it('reads every other shape as no groups at all', () => {
    // A claim is the provider's to shape. All of these must be "not an admin",
    // never an exception on a page that was only reading.
    for (const raw of [undefined, null, '', 'admins', '["admins"]', { groups: ['admins'] }, 1]) {
      expect(groupsOf(raw), String(raw)).toEqual([])
      expect(isAdmin(groupsOf(raw)), String(raw)).toBe(false)
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
  admin: true,
  ...o,
})

describe('the decision', () => {
  it('lets an admin through, and names them', () => {
    expect(allow(decision({}))).toEqual({ ok: true, value: 'op@example.test' })
  })

  it('refuses a signed-in non-admin', () => {
    expect(allow(decision({ admin: false }))).toEqual({ ok: false, reason: NOT_ADMIN_REASON })
  })

  it('answers "not signed in" ahead of "not an admin"', () => {
    // Both are wrong, but they send the operator to different places: one is
    // a broken forward-auth gate, the other is a group they are not in.
    const anonymous = { ok: false as const, reason: NO_ACTOR_REASON }
    expect(allow(decision({ actor: anonymous, admin: false }))).toEqual(anonymous)
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
