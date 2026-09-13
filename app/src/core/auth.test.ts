import { describe, expect, it } from 'vitest'
import { actorLabelOf, actorOf, actorOrNull, NO_ACTOR_REASON, UNKNOWN_ACTOR } from './auth'

// The one identity rule, and the one place it is asserted. The ambient forms
// (requireActor, actorLabel) are these same two functions over
// getRequestHeader, which needs a request to be running inside — what is worth
// pinning is the rule, not which of the two readers found the header.

/** A request as traefik's forward-auth leaves it. */
const req = (email?: string): Request =>
  new Request('https://daedalus-app.test/', {
    headers: email === undefined ? {} : { 'x-forwarded-email': email },
  })

describe('the gate', () => {
  it('reads a missing or blank header as no one', () => {
    for (const email of [undefined, '', '   ']) {
      expect(actorOf(req(email))).toEqual({ ok: false, reason: NO_ACTOR_REASON })
      expect(actorOrNull(actorOf(req(email)))).toBeNull()
    }
  })

  it('trims the identity it does find', () => {
    expect(actorOf(req(' op@example.test '))).toEqual({ ok: true, actor: 'op@example.test' })
    expect(actorOrNull(actorOf(req(' op@example.test ')))).toBe('op@example.test')
  })
})

describe('the display label', () => {
  it('never fails, and says so when nobody is named', () => {
    expect(actorLabelOf(req())).toBe(UNKNOWN_ACTOR)
    expect(actorLabelOf(req(), 'api')).toBe('api')
    expect(actorLabelOf(req(), 'registry')).toBe('registry')
  })

  it('passes a present header through untouched', () => {
    // Including a blank one: the label has never trimmed, and a record that
    // names nobody is what those requests have always written.
    expect(actorLabelOf(req('op@example.test'))).toBe('op@example.test')
    expect(actorLabelOf(req(''), 'api')).toBe('')
  })
})
