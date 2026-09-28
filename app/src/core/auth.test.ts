import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  actorLabelOf,
  actorOf,
  actorOrNull,
  forwardedHeaderOf,
  NO_ACTOR_REASON,
  provenByProxy,
  UNKNOWN_ACTOR,
} from './auth'

// The one identity rule, and the one place it is asserted. The ambient forms
// (requireActor, actorLabel) are these same two functions over
// getRequestHeader, which needs a request to be running inside — what is worth
// pinning is the rule, not which of the two readers found the header.

const PROOF = 'a'.repeat(64)

beforeEach(() => {
  vi.stubEnv('PROXY_PROOF', PROOF)
})
afterEach(() => {
  vi.unstubAllEnvs()
})

/** A request as traefik's forward-auth leaves it: the identity, and the proof it came from traefik. */
const req = (email?: string, proof: string | null = PROOF): Request =>
  new Request('https://daedalus-app.test/', {
    headers: {
      ...(email === undefined ? {} : { 'x-forwarded-email': email }),
      ...(proof === null ? {} : { 'x-proxy-proof': proof }),
    },
  })

describe('the gate', () => {
  it('reads a missing or blank header as no one', () => {
    for (const email of [undefined, '', '   ']) {
      expect(actorOf(req(email))).toEqual({ ok: false, reason: NO_ACTOR_REASON })
      expect(actorOrNull(actorOf(req(email)))).toBeNull()
    }
  })

  it('trims the identity it does find', () => {
    expect(actorOf(req(' op@example.test '))).toEqual({ ok: true, value: 'op@example.test' })
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

describe('the proxy proof', () => {
  // Anything sharing a bridge with the container can dial it and send these
  // headers. Only traefik holds the proof, so without it nobody is named.
  const forged = (proof: string | null) => req('op@example.test', proof)

  it('names nobody on a request without it', () => {
    expect(actorOf(forged(null))).toEqual({ ok: false, reason: NO_ACTOR_REASON })
    expect(actorLabelOf(forged(null), 'api')).toBe('api')
    expect(forwardedHeaderOf(forged(null), 'x-forwarded-email')).toBeUndefined()
  })

  it('names nobody on a wrong one, of any length', () => {
    for (const proof of ['', 'b'.repeat(64), 'a'.repeat(63), `${PROOF}a`]) {
      expect(provenByProxy((n) => forged(proof).headers.get(n))).toBe(false)
      expect(actorOf(forged(proof))).toEqual({ ok: false, reason: NO_ACTOR_REASON })
    }
  })

  it('names nobody when this container was given no proof to check against', () => {
    vi.stubEnv('PROXY_PROOF', '')
    expect(actorOf(forged(PROOF))).toEqual({ ok: false, reason: NO_ACTOR_REASON })
    expect(actorOf(forged(''))).toEqual({ ok: false, reason: NO_ACTOR_REASON })
  })

  it('passes the identity through when it matches', () => {
    expect(provenByProxy((n) => forged(PROOF).headers.get(n))).toBe(true)
    expect(actorOf(forged(PROOF))).toEqual({ ok: true, value: 'op@example.test' })
  })
})
