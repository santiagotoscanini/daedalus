import { describe, expect, it } from 'vitest'
import {
  httpResult,
  REFUSAL_STATUS,
  type Refusal,
  readHttpResult,
  readJsonObject,
  refusalResponse,
} from './http-result'
import type { Result } from './result'

type Code = 'busy' | 'noop' | 'refused' | 'signed-out' | 'not-admin' | 'agent'

const kind = (code: Code) =>
  (
    ({
      busy: 'conflict',
      noop: 'conflict',
      refused: 'bad-input',
      'signed-out': 'unauthenticated',
      'not-admin': 'forbidden',
      agent: 'upstream',
    }) as const
  )[code]

const refused = (code: Code): Result<{ id: string }, Refusal<Code>> => ({
  ok: false,
  reason: { code, reason: `because ${code}` },
})

describe('httpResult', () => {
  it('answers 200 with the value spread beside `queued`, status first', async () => {
    const res = httpResult({ ok: true, value: { id: 'abc', changed: [] } }, { kind })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    // Byte-for-byte what routes/api.registry.apply.ts answered before this
    // helper existed, key order included.
    expect(await res.text()).toBe('{"status":"queued","id":"abc","changed":[]}')
  })

  it('answers 202 and `ok` when asked to', async () => {
    const res = httpResult(
      { ok: true, value: { imported: 3 } },
      { kind, accepted: 'ok', okStatus: 202 },
    )
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ status: 'ok', imported: 3 })
  })

  it('maps each kind of refusal to its status, with the code as the body’s status', async () => {
    const expected: [Code, number][] = [
      ['signed-out', 401],
      ['not-admin', 403],
      ['refused', 400],
      ['busy', 409],
      ['noop', 409],
      ['agent', 502],
    ]
    for (const [code, status] of expected) {
      const res = httpResult(refused(code), { kind })
      expect(res.status, code).toBe(status)
      expect(await res.json()).toEqual({ status: code, reason: `because ${code}` })
    }
  })

  it('has one status per kind and no two alike', () => {
    const statuses = Object.values(REFUSAL_STATUS)
    expect(new Set(statuses).size).toBe(statuses.length)
  })
})

describe('refusalResponse', () => {
  it('is the refusal half on its own, for a check made before there is a Result', async () => {
    const res = refusalResponse('bad-input', { code: 'refused', reason: 'body is not JSON' })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ status: 'refused', reason: 'body is not JSON' })
  })
})

describe('readHttpResult', () => {
  it('round-trips an accepted result, without the label', async () => {
    const value = { id: 'abc', targets: [{ container: 'iris', toTag: null }] }
    expect(await readHttpResult(httpResult({ ok: true, value }, { kind }))).toEqual({
      ok: true,
      value,
    })
  })

  it('round-trips a refusal, keeping the status it arrived with', async () => {
    expect(await readHttpResult(httpResult(refused('busy'), { kind }))).toEqual({
      ok: false,
      reason: { code: 'busy', reason: 'because busy', httpStatus: 409 },
    })
  })

  it('decides by the HTTP status, not by the word in the body', async () => {
    // Nothing sends `refused` under a 200, and the decoder must not invent a
    // refusal out of one: a code and an accepted label are both just a word.
    const body = { status: 'refused', id: 'x' }
    expect(await readHttpResult(Response.json(body))).toEqual({ ok: true, value: { id: 'x' } })
  })

  it('throws on a body that is not this dialect', async () => {
    await expect(readHttpResult(Response.json({ error: 'nope' }, { status: 500 }))).rejects.toThrow(
      'HTTP 500: not a result body',
    )
    await expect(
      readHttpResult(Response.json({ status: 'error', error: 'x' }, { status: 400 })),
    ).rejects.toThrow('a refusal without a reason')
  })
})

describe('readJsonObject', () => {
  const request = (body: string) => new Request('http://x/', { method: 'POST', body })

  it('tells a body that is not JSON from one that is not an object', async () => {
    expect(await readJsonObject(request('not json'))).toEqual({ ok: false, reason: 'not-json' })
    for (const body of ['null', '[]', '"anansi"', '3']) {
      expect(await readJsonObject(request(body)), body).toEqual({
        ok: false,
        reason: 'not-object',
      })
    }
    expect(await readJsonObject(request('{"app":"iris"}'))).toEqual({
      ok: true,
      value: { app: 'iris' },
    })
  })
})
