import { describe, expect, it } from 'vitest'
import { readJsonObject } from './http-result'

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
