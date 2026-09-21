import { describe, expect, it } from 'vitest'
import {
  clientHost,
  forwardAuthClient,
  type IdentityCtx,
  idpAuditLog,
  idpClients,
  idpSettings,
} from './pocket-id'

type Call = { url: string; init: RequestInit | undefined }

/** A ctx whose getJson answers from `reply` and records what it was asked. */
function fakeCtx(reply: (url: string) => unknown): { ctx: IdentityCtx; calls: Call[] } {
  const calls: Call[] = []
  const ctx: IdentityCtx = {
    hosts: { base: (app) => `https://${app}.example`, hc: 'http://host' },
    secret: (name) => (name === 'POCKETID_KEY' ? 'k-123' : ''),
    http: {
      getJson: (async (url: string, init?: RequestInit) => {
        calls.push({ url, init })
        return reply(url)
      }) as IdentityCtx['http']['getJson'],
    },
  }
  return { ctx, calls }
}

describe('the Pocket ID reader', () => {
  it('dials the host and sends the key its ctx carries', async () => {
    const { ctx, calls } = fakeCtx(() => ({ data: [{ id: 'a', name: 'A' }] }))
    expect(await idpClients(ctx)).toEqual([{ id: 'a', name: 'A' }])
    expect(calls[0]?.url.startsWith('https://pocket-id.example/api/oidc/clients')).toBe(true)
    expect(calls[0]?.init?.headers).toEqual({ 'X-API-KEY': 'k-123' })
  })

  it('reads no answer as an empty list', async () => {
    const { ctx } = fakeCtx(() => null)
    expect(await idpClients(ctx)).toEqual([])
    expect((await idpSettings(ctx)).size).toBe(0)
  })

  it('keeps the settings rows that carry both halves', async () => {
    const { ctx } = fakeCtx(() => [{ key: 'allowUserSignups', value: 'disabled' }, { key: 'x' }])
    expect([...(await idpSettings(ctx))]).toEqual([['allowUserSignups', 'disabled']])
  })
})

describe('idpAuditLog', () => {
  const page = (n: string) => Number(/pagination\[page\]=(\d+)/.exec(n)?.[1])

  it('stops at the page that reaches past the window', async () => {
    const { ctx, calls } = fakeCtx((url) => ({
      data: [
        { id: `e${String(page(url))}`, createdAt: page(url) === 1 ? '2026-01-10' : '2026-01-01' },
      ],
      pagination: { totalPages: 9 },
    }))
    const log = await idpAuditLog(ctx, Date.parse('2026-01-05'))
    expect(calls).toHaveLength(2)
    expect(log).toEqual({
      events: [
        { id: 'e1', createdAt: '2026-01-10' },
        { id: 'e2', createdAt: '2026-01-01' },
      ],
      truncated: false,
    })
  })

  it('says so when six pages did not cover the window', async () => {
    const { ctx, calls } = fakeCtx(() => ({
      data: [{ createdAt: '2026-01-10' }],
      pagination: { totalPages: 9 },
    }))
    const log = await idpAuditLog(ctx, Date.parse('2026-01-05'))
    expect(calls).toHaveLength(6)
    expect(log.truncated).toBe(true)
  })
})

describe('clientHost and forwardAuthClient', () => {
  it('names the host from the launch URL, else the first callback', () => {
    expect(clientHost({ launchURL: 'https://a.example/x' })).toBe('a.example')
    expect(clientHost({ callbackURLs: ['https://b.example/cb'] })).toBe('b.example')
    expect(clientHost({})).toBeNull()
  })

  it('knows the gate by its one generated callback', () => {
    expect(
      forwardAuthClient({ callbackURLs: ['https://a.example/oidc/callback'] }, 'a.example'),
    ).toBe(true)
    expect(
      forwardAuthClient(
        { callbackURLs: ['https://a.example/oidc/callback', 'https://a.example/api/auth'] },
        'a.example',
      ),
    ).toBe(false)
  })
})
