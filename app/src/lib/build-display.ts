import type { Detection, DetectionWarning } from './build-detect'
import {
  ACTIVE_BUILD_STATES,
  type BuildChecks,
  type BuildPublish,
  type BuildRequester,
  type BuildState,
  type BuildStrategy,
  isActiveBuildState,
} from './builds'

// How a build reads on the page: the shapes the server functions send and the
// pure helpers the board, the build page and the overview share. Client-safe —
// no row types from the repository, dates as ISO strings for the wire.

export type BuildSummary = {
  id: string
  sha: string
  state: BuildState
  phase: string
  requestedBy: BuildRequester
  actor: string | null
  strategy: BuildStrategy
  resolvedStrategy: Exclude<BuildStrategy, 'auto'> | null
  publish: BuildPublish
  error: string | null
  createdAt: string
  startedAt: string | null
  updatedAt: string
}

/** What happened to the image after the build, as far as this box can tell. */
export type DeployOutcome =
  | { kind: 'none' }
  | { kind: 'candidate' }
  | { kind: 'pinned'; why: 'frozen' | 'image-override' }
  | { kind: 'waiting' }
  | { kind: 'deployed'; result: string; at: string; httpCode: string | null }

export type BuildView = BuildSummary & {
  app: string
  detection: Detection | null
  warnings: DetectionWarning[]
  checks: BuildChecks | null
  digest: string | null
  imageRef: string | null
  sizeBytes: number | null
  timings: Record<string, number>
  checkRunId: number | null
  deploymentId: number | null
  deploy: DeployOutcome
  log: { available: boolean; text: string; truncated: boolean; sizeBytes: number | null }
}

export type BuildCommit = {
  message: string
  author: string | null
  authoredAt: string | null
  htmlUrl: string | null
}

/** Still moving: the page keeps asking while this is true. */
export const isOpenBuild = (state: BuildState): boolean =>
  state === 'queued' || isActiveBuildState(state)

export const sha7 = (sha: string): string => sha.slice(0, 7)

/** A queue row as the wire carries it. */
export function summarizeBuild(row: import('./build-queue').BuildRow): BuildSummary {
  return {
    id: row.id,
    sha: row.sha,
    state: row.state,
    phase: row.phase,
    requestedBy: row.requestedBy,
    actor: row.actor,
    strategy: row.strategy,
    resolvedStrategy: row.resolvedStrategy,
    publish: row.publish,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt === null ? null : row.startedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/**
 * Milliseconds from hand-off to the last word, or to `now` while it runs.
 * Null for a build that never started.
 */
export function buildDurationMs(b: BuildSummary, now = Date.now()): number | null {
  if (b.startedAt === null) return null
  const start = Date.parse(b.startedAt)
  const end = isOpenBuild(b.state) ? now : Date.parse(b.updatedAt)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  return Math.max(0, end - start)
}

export type TimelineStep = {
  phase: string
  ms: number | null
  status: 'done' | 'running' | 'failed' | 'pending'
}

// What the host may call each phase in its timings: the state's own name, or
// the verb it grew from.
const PHASE_KEYS: Partial<Record<BuildState, string[]>> = {
  cloning: ['cloning', 'clone'],
  detecting: ['detecting', 'detect', 'prepare'],
  checking: ['checking', 'checks', 'check'],
  building: ['building', 'build'],
  publishing: ['publishing', 'publish', 'push'],
}

/**
 * The phases in order, with their timings. A failed build's failing phase is
 * the first one after the last timed phase; phases the host timed under names
 * this does not know follow the known ones, as reported.
 */
export function buildTimeline(state: BuildState, timings: Record<string, number>): TimelineStep[] {
  const used = new Set<string>()
  const steps: TimelineStep[] = ACTIVE_BUILD_STATES.map((phase) => {
    const key = (PHASE_KEYS[phase] ?? [phase]).find((k) => k in timings)
    if (key !== undefined) used.add(key)
    return {
      phase,
      ms: key === undefined ? null : (timings[key] ?? null),
      status: key === undefined ? 'pending' : 'done',
    }
  })

  const firstUntimed = steps.findIndex((s) => s.ms === null)
  const current = steps.findIndex((s) => s.phase === state)
  if (current !== -1) {
    const step = steps[current]
    if (step !== undefined) step.status = 'running'
  } else if (state === 'failed' && firstUntimed !== -1) {
    const step = steps[firstUntimed]
    if (step !== undefined) step.status = 'failed'
  } else if (state === 'succeeded') {
    // A phase with no timing on a finished build was skipped, not pending.
    for (const s of steps) if (s.ms === null) s.status = 'done'
  }

  for (const [k, v] of Object.entries(timings)) {
    if (!used.has(k)) steps.push({ phase: k, ms: v, status: 'done' })
  }
  return steps
}

/** The tags the host pushes (plan D): live → sha-<sha> + latest, candidate → candidate-<sha>. */
export function buildTags(publish: BuildPublish, sha: string): string[] {
  return publish === 'candidate' ? [`candidate-${sha}`] : [`sha-${sha}`, 'latest']
}

const FRAMEWORKS: Record<string, string> = {
  'tanstack-start': 'TanStack Start',
  next: 'Next.js',
  nextjs: 'Next.js',
  vite: 'Vite',
  astro: 'Astro',
  remix: 'Remix',
  'react-router': 'React Router',
  nuxt: 'Nuxt',
  sveltekit: 'SvelteKit',
  angular: 'Angular',
  node: 'Node',
  static: 'static site',
}

export const frameworkName = (id: string): string => FRAMEWORKS[id.toLowerCase()] ?? id

const PROVIDERS: Record<string, string> = { node: 'Railpack', staticfile: 'Railpack' }

/**
 * The overview's one line: "Built with Railpack · Node 24.18.1 (.tool-versions)
 * · pnpm 11.18.0 · TanStack Start · start `node start.mjs`". Parts, so the
 * caller can set the command in monospace.
 */
export function detectionParts(
  resolved: BuildSummary['resolvedStrategy'],
  d: Detection | null,
): { text: string; code?: boolean }[] {
  if (resolved === 'dockerfile' || d === null) {
    return [{ text: resolved === 'dockerfile' ? 'Built from the Dockerfile' : 'Built' }]
  }
  const parts: { text: string; code?: boolean }[] = [
    {
      text: `Built with ${d.provider === null ? 'Railpack' : (PROVIDERS[d.provider] ?? 'Railpack')}`,
    },
  ]
  if (d.node !== null) parts.push({ text: `Node ${d.node.version} (${d.node.source})` })
  if (d.pnpm !== null) parts.push({ text: `pnpm ${d.pnpm.version}` })
  if (d.framework !== null) parts.push({ text: frameworkName(d.framework) })
  if (d.startCommand !== null) parts.push({ text: d.startCommand, code: true })
  return parts
}

const DIGEST_PREFIX = /^sha256:/

export const sameDigest = (a: string | null, b: string | null): boolean =>
  a !== null && b !== null && a.replace(DIGEST_PREFIX, '') === b.replace(DIGEST_PREFIX, '')

/**
 * What became of a build's image. The builds table does not keep the host's
 * `pinned` flag, so a live build that never deployed is read against the app:
 * frozen, or held on an image override, is pinned; otherwise the deploy has
 * not landed yet.
 */
export function deployOutcome(input: {
  state: BuildState
  publish: BuildPublish
  digest: string | null
  deployEnable: boolean
  imageOverride: string | null
  deployment: { result: string; startedAt: string; httpCode: string | null } | null
}): DeployOutcome {
  if (input.state !== 'succeeded') return { kind: 'none' }
  if (input.publish === 'candidate') return { kind: 'candidate' }
  if (input.deployment !== null) {
    return {
      kind: 'deployed',
      result: input.deployment.result,
      at: input.deployment.startedAt,
      httpCode: input.deployment.httpCode,
    }
  }
  if (!input.deployEnable) return { kind: 'pinned', why: 'frozen' }
  if (input.imageOverride !== null && input.imageOverride !== '') {
    return { kind: 'pinned', why: 'image-override' }
  }
  return { kind: 'waiting' }
}
