import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createFileRoute } from '@tanstack/react-router'
import type { Ctx } from '../core/ctx'
import { decode } from '../lib/contract/decode'
import { type GithubPushEvent, pushEventDecoder } from '../lib/github-app'
import { verifyWebhookSignature } from '../lib/github-app-crypto'
import {
  alreadyHandled,
  appsPinnedTo,
  type BuildIntent,
  eventKind,
  isDeliveryId,
  isEventName,
  parsePayload,
  readAction,
  repoMove,
  repoMoveNote,
  repositoryId,
  routePush,
} from '../lib/webhook-routing'

// GitHub's webhook for the daedalus GitHub App.
//
// Public: `hooks.<baseDomain>` reaches this through the Cloudflare tunnel with
// no forward-auth, and traefik forwards only POST on this exact path. The
// signature is therefore the only authentication, so nothing about a delivery
// is believed before it verifies, and the log gets the delivery id, the event
// name and what was done with it, never a header value or a byte of the body.
//
// A verified delivery is recorded in github_deliveries in the same transaction
// as anything it causes. The id is the primary key, so a redelivery is a no-op;
// and a failure rolls the record back with the build, so the redelivery that
// recovers it is not refused as a duplicate.
//
// Nothing here calls GitHub or starts a build. A push queues a row; the
// scheduler (core/builds/scheduler.ts) hands it to the host, and the host
// builds only when the sha is still the branch tip, which is what stops a
// replayed or out-of-order push.
//
// GitHub never retries a delivery, so every non-2xx here is a lost event until
// someone redelivers it or the sweep finds the tip.

export const MAX_BODY_BYTES = 5 * 1024 * 1024

/** A rotated secret reaches a running process within this long. */
const SECRET_TTL_MS = 60_000

const DEFAULT_GITHUB_APP_DIR = '/github'

/** A queued push's outcome until the enqueue answers, inside the same transaction. */
const QUEUEING = 'queueing'

export type WebhookDeps = Ctx & { now?: () => number }

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

  const id = request.headers.get('x-github-delivery')
  const event = request.headers.get('x-github-event')
  const delivery = loggable(id)

  if (!verifyWebhookSignature(body, request.headers.get('x-hub-signature-256'), secret)) {
    console.warn(`[github-webhook] bad signature: delivery ${delivery} event ${loggable(event)}`)
    return Response.json({ error: 'bad signature' }, { status: 401 })
  }

  const payload = parsePayload(body)
  if (payload === null) {
    log(delivery, loggable(event), 'bad-json')
    return Response.json({ error: 'body is not a JSON object' }, { status: 400 })
  }
  if (!isDeliveryId(id) || !isEventName(event)) {
    log(delivery, loggable(event), 'bad-headers')
    return Response.json(
      { error: 'missing or malformed X-GitHub-Delivery or X-GitHub-Event' },
      { status: 400 },
    )
  }

  const received: Delivery = { id, event, action: readAction(payload), payload }
  try {
    return await handleDelivery(received, deps)
  } catch (e) {
    log(id, event, `error${errorCode(e)}`)
    return Response.json({ error: 'delivery could not be processed' }, { status: 500 })
  }
}

type Delivery = {
  id: string
  event: string
  action: string | null
  payload: Record<string, unknown>
}

type Reply = {
  kind: 'reply'
  outcome: string
  body: Record<string, unknown>
  /** An installation or repository event: ask the host for a fresh token once recorded. */
  installationChanged?: boolean
}

type Plan = Reply | { kind: 'queue'; intent: BuildIntent }

const reply = (outcome: string, body: Record<string, unknown>): Reply => ({
  kind: 'reply',
  outcome,
  body,
})
const ignored = (reason: string): Reply => reply(`ignored:${reason}`, { status: 'ignored', reason })

async function handleDelivery(delivery: Delivery, deps: WebhookDeps): Promise<Response> {
  const plan = await planDelivery(delivery, deps)
  if (plan instanceof Response) return plan

  const [{ withTransaction }, { recordDelivery, setDeliveryOutcome }, { insertOrSupersedeQueued }] =
    await Promise.all([
      import('../lib/db'),
      import('../lib/repo/github-deliveries'),
      import('../lib/repo/builds'),
    ])

  const done = await withTransaction(async (tx): Promise<Reply | null> => {
    const fresh = await recordDelivery(tx, {
      id: delivery.id,
      event: delivery.event,
      action: delivery.action,
      outcome: plan.kind === 'queue' ? QUEUEING : plan.outcome,
    })
    if (!fresh) return null
    if (plan.kind === 'reply') return plan

    const queued = await insertOrSupersedeQueued({ ...plan.intent, deliveryId: delivery.id }, tx)
    const outcome = `${queued.alreadyQueued ? 'already-queued' : 'queued'}:${queued.row.id}`
    await setDeliveryOutcome(tx, delivery.id, outcome)
    return reply(outcome, {
      status: 'queued',
      build: queued.row.id,
      superseded: queued.superseded.length,
      ...(queued.alreadyQueued ? { alreadyQueued: true } : {}),
    })
  })

  if (done === null) {
    log(delivery.id, delivery.event, 'duplicate')
    return Response.json({ status: 'ignored', reason: 'duplicate' })
  }
  log(delivery.id, delivery.event, done.outcome)
  if (done.installationChanged) await afterInstallationChange(delivery)
  return Response.json(done.body)
}

/** What a delivery will do, decided from reads before the transaction that records it. */
async function planDelivery(delivery: Delivery, deps: WebhookDeps): Promise<Plan | Response> {
  switch (eventKind(delivery.event)) {
    case 'ping':
      return reply('pong', { status: 'pong' })
    case 'installation':
      return { ...reply('noted', { status: 'noted' }), installationChanged: true }
    case 'push':
      return planPush(delivery, deps)
    case 'other':
      return ignored('event')
  }
}

async function planPush(delivery: Delivery, deps: WebhookDeps): Promise<Plan | Response> {
  let event: GithubPushEvent
  try {
    event = decode(pushEventDecoder, delivery.payload)
  } catch {
    // The decode error quotes values from the body; it is not logged.
    log(delivery.id, delivery.event, 'bad-payload')
    return Response.json({ error: 'not a push payload' }, { status: 400 })
  }

  const [
    { appIdentity, installationState },
    { appForRepository },
    { activeBuilds, latestSucceeded },
  ] = await Promise.all([
    import('../core/github-app'),
    import('../lib/repo/app-lookup'),
    import('../lib/repo/builds'),
  ])

  const identity = await appIdentity(deps)
  if (identity === null) return ignored('no-app-identity')
  const installation = await installationState(deps)
  const app = (await appForRepository(event.repository.id, event.repository.name)) ?? null

  const routed = routePush(event, {
    ownerId: identity.ownerId,
    installationId: installation.available ? installation.data.installationId : null,
    app,
  })
  if (routed.kind === 'ignore') return ignored(routed.reason)

  const { intent } = routed
  const [active, last] = await Promise.all([
    activeBuilds(),
    latestSucceeded(intent.appId, intent.lane, intent.publish),
  ])
  const skip = alreadyHandled(intent, { active, lastSucceededSha: last?.sha ?? null })
  if (skip !== null) return ignored(skip)
  return { kind: 'queue', intent }
}

/**
 * After an installation or repository event is recorded. Never throws: the
 * delivery has committed, and a 500 now would make its redelivery a duplicate.
 */
async function afterInstallationChange(delivery: Delivery): Promise<void> {
  try {
    const { requestTokenRefresh } = await import('../core/github-app')
    await requestTokenRefresh()

    const move = repoMove(delivery.event, delivery.action)
    const repoId = repositoryId(delivery.payload)
    if (move === null || repoId === null) return
    const { listApps } = await import('../lib/repo/apps')
    const pinned = appsPinnedTo(await listApps(), repoId)
    // Never unpinned here: a rename keeps building (the app is found by id),
    // and classifyPush already refuses a transferred or recreated repo.
    if (pinned.length > 0) {
      console.warn(`[github-webhook] delivery ${delivery.id}: ${repoMoveNote(move, pinned)}`)
    }
  } catch (e) {
    log(delivery.id, delivery.event, `after-commit-error${errorCode(e)}`)
  }
}

function log(delivery: string, event: string, outcome: string): void {
  console.info(`[github-webhook] delivery ${delivery} event ${event} outcome ${outcome}`)
}

/** A postgres SQLSTATE when there is one: an error's message can quote the row. */
function errorCode(e: unknown): string {
  for (let err = e, depth = 0; depth < 5 && typeof err === 'object' && err !== null; depth++) {
    const code = (err as { code?: unknown }).code
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return ` ${code}`
    err = (err as { cause?: unknown }).cause
  }
  return ''
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
