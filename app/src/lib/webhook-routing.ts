import {
  BUILD_PUBLISH_MODES,
  BUILD_STRATEGIES,
  type BuildPublish,
  type BuildStrategy,
} from './builds'
import { classifyPush, type GithubPushEvent, type PushIgnoreReason } from './github-app'

// The GitHub webhook's decisions without its I/O: which deliveries are
// well-formed, what an event asks for, and whether a push becomes a build.
// Client-safe. The route (routes/api.github.webhook.ts) does the reading,
// the transaction and the logging.

/** GitHub sends a GUID. It becomes a primary key and a log token, so nothing looser is let in. */
const DELIVERY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EVENT_WORD = /^[a-z_]{1,64}$/

export function isDeliveryId(value: string | null): value is string {
  return value !== null && DELIVERY_ID.test(value)
}

export function isEventName(value: string | null): value is string {
  return value !== null && EVENT_WORD.test(value)
}

const utf8 = new TextDecoder('utf-8', { fatal: true })

/** The body as a JSON object; null when it is not UTF-8, not JSON, or not an object. */
export function parsePayload(bytes: Uint8Array): Record<string, unknown> | null {
  let value: unknown
  try {
    value = JSON.parse(utf8.decode(bytes))
  } catch {
    return null
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** `action` when it is a plain event-action word; anything else is not stored. */
export function readAction(payload: Record<string, unknown>): string | null {
  const action = payload.action
  return typeof action === 'string' && EVENT_WORD.test(action) ? action : null
}

export type WebhookEventKind = 'ping' | 'installation' | 'push' | 'other'

export function eventKind(event: string): WebhookEventKind {
  switch (event) {
    case 'ping':
      return 'ping'
    case 'installation':
    case 'installation_repositories':
    case 'repository':
      return 'installation'
    case 'push':
      return 'push'
    default:
      return 'other'
  }
}

/** Repository actions that move a repo away from the name or owner a pinned app expects. */
export const REPO_MOVE_ACTIONS = ['renamed', 'transferred', 'deleted'] as const
export type RepoMove = (typeof REPO_MOVE_ACTIONS)[number]

export function repoMove(event: string, action: string | null): RepoMove | null {
  if (event !== 'repository') return null
  return REPO_MOVE_ACTIONS.find((a) => a === action) ?? null
}

/**
 * The operator's warning for apps pinned to a repository that moved. A push
 * from a renamed repository still reaches its app (matched on the pinned id),
 * but the builder mints its token for, and reads, the repository by the APP's
 * name, and the reporter posts to that name too, so the build fails closed. A
 * transfer leaves the App owner's account, which classifyPush refuses.
 *
 * Later: carrying the repository's current name in the build request would
 * let a rename keep building. That is a change to the host's contract.
 */
export function repoMoveNote(move: RepoMove, pinned: readonly string[]): string {
  const names = pinned.join(', ')
  switch (move) {
    case 'renamed':
      return `repository pinned by ${names} was renamed; builds for ${names} fail until the app is renamed to match or the repository is renamed back`
    case 'transferred':
      return `repository pinned by ${names} was transferred; the pin is kept, and pushes from outside the App owner's account are ignored`
    case 'deleted':
      return `repository pinned by ${names} was deleted; the pin is kept, and a repository recreated under that name does not build until it is re-pinned`
  }
}

export function repositoryId(payload: Record<string, unknown>): number | null {
  const repo = payload.repository
  if (repo === null || typeof repo !== 'object') return null
  const id = (repo as Record<string, unknown>).id
  return typeof id === 'number' && Number.isSafeInteger(id) ? id : null
}

export function appsPinnedTo(
  apps: readonly { name: string; githubRepoId: number | null }[],
  repoId: number,
): string[] {
  return apps.filter((a) => a.githubRepoId === repoId).map((a) => a.name)
}

// ── push ───────────────────────────────────────────────────────────────────

/** The app columns a push is gated on. */
export type PushApp = {
  id: string
  githubRepoId: number | null
  buildOnBox: boolean
  managedInNix: boolean
  sourceMode: string
  buildStrategy: string
  buildPublish: string
}

export type PushSkipReason = 'already-running' | 'already-built'

export type PushIgnore =
  | PushIgnoreReason
  | 'box-builds-off'
  | 'managed-in-nix'
  | 'not-registry-mode'
  | 'invalid-build-settings'
  | PushSkipReason

export type BuildIntent = {
  appId: string
  lane: 'main'
  sha: string
  strategy: BuildStrategy
  publish: BuildPublish
  requestedBy: 'webhook'
  actor: string | null
}

export type PushRoute =
  | { kind: 'queue'; intent: BuildIntent }
  | { kind: 'ignore'; reason: PushIgnore }

/**
 * classifyPush, then the app's own gates. The GitHub App is installed on every
 * repository, so `buildOnBox` is what keeps a push to a repo nobody moved to
 * box builds from building. Only registry-mode apps have an image to replace.
 */
export function routePush(
  event: GithubPushEvent,
  ctx: { ownerId: number; installationId: number | null; app: PushApp | null },
): PushRoute {
  const classified = classifyPush(event, ctx)
  if (classified.kind === 'ignore') return classified
  const app = ctx.app
  if (app === null) return { kind: 'ignore', reason: 'no-app' }
  if (!app.buildOnBox) return { kind: 'ignore', reason: 'box-builds-off' }
  if (app.managedInNix) return { kind: 'ignore', reason: 'managed-in-nix' }
  if (app.sourceMode !== 'registry') return { kind: 'ignore', reason: 'not-registry-mode' }
  const strategy = BUILD_STRATEGIES.find((s) => s === app.buildStrategy)
  const publish = BUILD_PUBLISH_MODES.find((p) => p === app.buildPublish)
  if (strategy === undefined || publish === undefined) {
    return { kind: 'ignore', reason: 'invalid-build-settings' }
  }
  return {
    kind: 'queue',
    intent: {
      appId: app.id,
      lane: 'main',
      sha: classified.sha,
      strategy,
      publish,
      requestedBy: 'webhook',
      actor: event.sender?.login ?? null,
    },
  }
}

/**
 * Whether the lane already has this sha in hand: building it now, or its newest
 * success in the same publish mode. build-queue.ts `enqueue`'s skip rule for a
 * push, which is never forced. A replayed delivery under a fresh id lands here
 * instead of rebuilding (and redeploying) the tip.
 */
export function alreadyHandled(
  intent: Pick<BuildIntent, 'appId' | 'lane' | 'sha'>,
  lane: {
    active: readonly { appId: string; lane: string; sha: string }[]
    lastSucceededSha: string | null
  },
): PushSkipReason | null {
  const running = lane.active.some(
    (b) => b.appId === intent.appId && b.lane === intent.lane && b.sha === intent.sha,
  )
  if (running) return 'already-running'
  if (lane.lastSucceededSha === intent.sha) return 'already-built'
  return null
}
