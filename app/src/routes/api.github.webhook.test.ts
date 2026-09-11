import { createHmac } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleGithubWebhook, MAX_BODY_BYTES, type WebhookDeps } from './api.github.webhook'

// The webhook skeleton: 405 off POST, 413 over the cap (declared or streamed),
// 503 without a usable secret, 401 without a matching signature, then `pong`
// for ping and `ignored` for everything else.

const URL_ = 'http://app-daedalus:3000/api/github/webhook'
const SECRET = 'whsec-7f3a9c1e5b2d8046'
const MiB = 1024 * 1024

let dir: string
let clock: number
let deps: WebhookDeps

const sign = (body: string | Uint8Array, secret = SECRET) =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`

const writeSecret = (value: string) => writeFile(join(dir, 'webhook-secret'), value)

function post(body: string, headers: Record<string, string> = {}): Request {
  return new Request(URL_, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  })
}

function delivery(event: string, body: string, secret = SECRET): Request {
  return post(body, {
    'x-github-event': event,
    'x-github-delivery': '72d3162e-cc78-11e3-81ab-4c9367dc0958',
    'x-hub-signature-256': sign(body, secret),
  })
}

/** A body of `chunks` 1 MiB pieces, counting how many were pulled. */
function streamed(chunks: number) {
  const state = { pulled: 0 }
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.pulled === chunks) {
        controller.close()
        return
      }
      state.pulled++
      controller.enqueue(new Uint8Array(MiB).fill(0x61))
    },
  })
  return { stream, state }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gh-webhook-'))
  clock = 1_000_000
  deps = {
    env: (name) => (name === 'GITHUB_APP_DIR' ? dir : undefined),
    now: () => clock,
  }
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
})

describe('handleGithubWebhook', () => {
  it('answers 405 to anything but POST, secret or not', async () => {
    const res = await handleGithubWebhook(new Request(URL_), deps)
    expect(res.status).toBe(405)
    expect(res.headers.get('allow')).toBe('POST')
  })

  it('answers 503 without a secret file', async () => {
    const res = await handleGithubWebhook(delivery('ping', '{}'), deps)
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'github app not configured' })
  })

  it.each([
    ['empty', ''],
    ['a trailing newline', `${SECRET}\n`],
    ['leading whitespace', ` ${SECRET}`],
  ])('answers 503 when the secret file holds %s', async (_label, value) => {
    await writeSecret(value)
    const res = await handleGithubWebhook(delivery('ping', '{}'), deps)
    expect(res.status).toBe(503)
  })

  it('does not remember a missing secret', async () => {
    expect((await handleGithubWebhook(delivery('ping', '{}'), deps)).status).toBe(503)
    await writeSecret(SECRET)
    expect((await handleGithubWebhook(delivery('ping', '{}'), deps)).status).toBe(200)
  })

  it('picks up a rotated secret once the cache has aged out', async () => {
    await writeSecret(SECRET)
    expect((await handleGithubWebhook(delivery('ping', '{}'), deps)).status).toBe(200)
    await writeSecret('whsec-rotated-0b91')
    clock += 61_000
    const res = await handleGithubWebhook(delivery('ping', '{}', 'whsec-rotated-0b91'), deps)
    expect(res.status).toBe(200)
  })

  it('answers 413 on a declared length over the cap without reading the body', async () => {
    await writeSecret(SECRET)
    const { stream, state } = streamed(1)
    const req = new Request(URL_, {
      method: 'POST',
      headers: { 'content-length': String(MAX_BODY_BYTES + 1) },
      body: stream,
      duplex: 'half',
    } as RequestInit)
    const res = await handleGithubWebhook(req, deps)
    expect(res.status).toBe(413)
    expect(state.pulled).toBeLessThanOrEqual(1)
  })

  it('answers 413 while streaming a body with no content-length past the cap', async () => {
    await writeSecret(SECRET)
    const { stream, state } = streamed(10)
    const req = new Request(URL_, { method: 'POST', body: stream, duplex: 'half' } as RequestInit)
    expect(req.headers.get('content-length')).toBeNull()
    const res = await handleGithubWebhook(req, deps)
    expect(res.status).toBe(413)
    expect(state.pulled).toBeLessThan(10)
  })

  it('answers 401 to a wrong signature, logging the delivery id and never the body', async () => {
    await writeSecret(SECRET)
    const body = '{"marker":"do-not-log-me"}'
    const res = await handleGithubWebhook(delivery('push', body, 'someone-elses-secret'), deps)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'bad signature' })
    const logged = vi.mocked(console.warn).mock.calls.flat().join(' ')
    expect(logged).toContain('72d3162e-cc78-11e3-81ab-4c9367dc0958')
    expect(logged).toContain('push')
    expect(logged).not.toContain('do-not-log-me')
    expect(logged).not.toContain('sha256=')
  })

  it('answers 401 to a missing signature header', async () => {
    await writeSecret(SECRET)
    const res = await handleGithubWebhook(post('{}', { 'x-github-event': 'ping' }), deps)
    expect(res.status).toBe(401)
  })

  it('answers pong to a correctly signed ping', async () => {
    await writeSecret(SECRET)
    const res = await handleGithubWebhook(
      delivery('ping', '{"zen":"Keep it logically awesome."}'),
      deps,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'pong' })
  })

  it('ignores a correctly signed push', async () => {
    await writeSecret(SECRET)
    const res = await handleGithubWebhook(delivery('push', '{"ref":"refs/heads/main"}'), deps)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ignored', reason: 'builds are not enabled yet' })
  })
})
