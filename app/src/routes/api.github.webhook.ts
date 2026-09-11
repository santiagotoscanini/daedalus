import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createFileRoute } from '@tanstack/react-router'
import type { Ctx } from '../core/ctx'
import { verifyWebhookSignature } from '../lib/github-app-crypto'

// GitHub's webhook for the daedalus GitHub App.
//
// Public: `hooks.<baseDomain>` reaches this through the Cloudflare tunnel with
// no forward-auth, and traefik forwards only POST on this exact path. The
// signature is therefore the only authentication, so nothing about a delivery
// is believed before it verifies, and the log gets the delivery id and event
// name, never a header value or a byte of the body.
//
// This is the skeleton: 503 until the host renders the App's webhook secret,
// 401 on a bad signature, `pong` for `ping`, `ignored` for everything else.
// Deliveries, dedupe and push routing arrive with builds (plan step 5).
//
// GitHub never retries a delivery, so every non-2xx here is a lost event until
// someone redelivers it.

export const MAX_BODY_BYTES = 5 * 1024 * 1024

/** A rotated secret reaches a running process within this long. */
const SECRET_TTL_MS = 60_000

const DEFAULT_GITHUB_APP_DIR = '/github'

export type WebhookDeps = Pick<Ctx, 'env'> & { now?: () => number }

export const Route = createFileRoute('/api/github/webhook')({
  server: {
    handlers: {
      ANY: async ({ request }) => {
        const { makeCtx } = await import('../core/ctx')
        return handleGithubWebhook(request, await makeCtx())
      },
    },
  },
})

export async function handleGithubWebhook(request: Request, deps: WebhookDeps): Promise<Response> {
  if (request.method !== 'POST') {
    return Response.json(
      { error: 'method not allowed' },
      { status: 405, headers: { Allow: 'POST' } },
    )
  }

  const declared = Number(request.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return tooLarge()

  const secret = await webhookSecret(deps.env, (deps.now ?? Date.now)())
  if (secret === null) {
    return Response.json({ error: 'github app not configured' }, { status: 503 })
  }

  let body: Uint8Array | null
  try {
    body = await readCapped(request.body, MAX_BODY_BYTES)
  } catch {
    return Response.json({ error: 'body could not be read' }, { status: 400 })
  }
  if (body === null) return tooLarge()

  const delivery = loggable(request.headers.get('x-github-delivery'))
  const event = request.headers.get('x-github-event')

  if (!verifyWebhookSignature(body, request.headers.get('x-hub-signature-256'), secret)) {
    console.warn(`[github-webhook] bad signature: delivery ${delivery} event ${loggable(event)}`)
    return Response.json({ error: 'bad signature' }, { status: 401 })
  }

  console.info(`[github-webhook] delivery ${delivery} event ${loggable(event)}`)
  if (event === 'ping') return Response.json({ status: 'pong' })
  return Response.json({ status: 'ignored', reason: 'builds are not enabled yet' })
}

function tooLarge(): Response {
  return Response.json({ error: 'payload too large' }, { status: 413 })
}

// Only a present secret is cached: the first delivery after the App is created
// must verify without waiting out a remembered absence.
let cached: { path: string; secret: string; readAt: number } | null = null

async function webhookSecret(env: Ctx['env'], now: number): Promise<string | null> {
  const path = join(env('GITHUB_APP_DIR') ?? DEFAULT_GITHUB_APP_DIR, 'webhook-secret')
  if (cached !== null && cached.path === path && now - cached.readAt < SECRET_TTL_MS) {
    return cached.secret
  }
  cached = null
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return null
  }
  // Surrounding whitespace is a copy that kept its newline, never what GitHub
  // signs with; verifying against it would fail every delivery as a 401.
  if (raw.trim() === '' || raw !== raw.trim()) return null
  cached = { path, secret: raw, readAt: now }
  return raw
}

/**
 * The exact bytes received, or null past `cap`. HMAC is over the raw body, and
 * a chunked body has no content-length, so the cap is enforced while reading.
 */
async function readCapped(
  stream: ReadableStream<Uint8Array> | null,
  cap: number,
): Promise<Uint8Array | null> {
  if (stream === null) return new Uint8Array(0)
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let chunk = await reader.read()
  while (!chunk.done) {
    total += chunk.value.byteLength
    if (total > cap) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(chunk.value)
    chunk = await reader.read()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    bytes.set(c, offset)
    offset += c.byteLength
  }
  return bytes
}

/** Header values reach the log unsigned-for; keep them to one short, plain token. */
function loggable(value: string | null): string {
  if (value === null) return '-'
  return value.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64) || '?'
}
