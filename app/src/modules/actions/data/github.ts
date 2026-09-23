import type { Ctx } from '../../../core/ctx'
import { listExternalApps } from '../../../core/settings/external-apps'
import { type Decoder, decode } from '../../../lib/contract/decode'
import { ENGINE_REPO } from '../../../lib/engine'
import { listApps } from '../../../lib/repo/apps'

// How the Actions page reads GitHub: which repositories, with which voice,
// and remembered for how long.
//
// The box's App speaks for every repository it is installed on, but only
// within the permissions it was granted — `actions` is not among them until
// the operator widens the App (view/shared.tsx says how), and GitHub answers
// that gap with a 403 that looks exactly like "no such repository". So each
// read is tried as the App first and, on a 403, once more with no token at
// all: a public repository answers the world, which is how the engine's own
// releases show before the App can read anything else. The two answers are
// kept apart in `access`, because "GitHub told the App" and "anyone could
// have read this" are different claims and the page says which it is.
//
// Every answer is remembered here, per path, for minutes: the page asks the
// same questions on every tab, the anonymous budget is sixty calls an hour
// for the whole address, and a completed run never changes again.

export type Access =
  /** Read as the App. */
  | 'app'
  /** The App could not; the repository is public and anyone can. */
  | 'public'
  /** The App could not and the repository is private: it needs `actions: read`. */
  | 'needs-actions'
  /** Public, but the address's anonymous budget for the hour is spent. */
  | 'budget'
  /** GitHub answered something else (a 5xx, a shape that moved). */
  | 'denied'
  /** GitHub did not answer. */
  | 'unreachable'

export type Answer<T> = { access: Access; value: T | null; status: number | null }

const MINUTE = 60_000
/** A list of runs or workflows: fresh enough for a page, kind to the budget. */
export const LIST_TTL = 3 * MINUTE
/** A 403 will not change until someone edits the App; do not ask again soon. */
const REFUSED_TTL = 30 * MINUTE
/** A completed run's jobs, or a workflow file at a sha: immutable. */
export const DONE_TTL = 24 * 60 * MINUTE

/** An answer anyone could have read is kept longer: the budget it came out of is small. */
const PUBLIC_TTL = 20 * MINUTE

type Slot = { at: number; ttl: number; answer: Answer<unknown> }
const memory = new Map<string, Slot>()

/**
 * The anonymous budget as GitHub last reported it. Sixty an hour for the
 * address, shared with everything else on the box that reads GitHub without
 * a token; when it is spent, reads that would need it answer `denied` at
 * once instead of spending a round trip on a 403.
 */
const anon = { remaining: null as number | null, resetAt: 0 }

export type AnonBudget = { remaining: number | null; resetAt: number; spent: boolean }

export function anonBudget(now: number = Date.now()): AnonBudget {
  const spent = anon.remaining === 0 && now < anon.resetAt
  return { remaining: spent ? 0 : anon.remaining, resetAt: anon.resetAt, spent }
}

function noteAnon(headers: Headers): void {
  const remaining = Number(headers.get('x-ratelimit-remaining'))
  const reset = Number(headers.get('x-ratelimit-reset')) * 1000
  if (Number.isFinite(remaining)) anon.remaining = remaining
  if (Number.isFinite(reset) && reset > 0) anon.resetAt = reset
}

/** Whether a path is remembered right now, so a caller can read for free. */
export function remembered(path: string, now: number = Date.now()): boolean {
  const hit = memory.get(path)
  return hit !== undefined && now - hit.at < hit.ttl
}

/** Drop everything remembered — tests, and the day the App is widened. */
export function forgetGithub(): void {
  memory.clear()
}

/**
 * One read, App first then anonymous, decoded, remembered. `ttl` is for a
 * good answer; a refusal is remembered longer on its own. A decode failure
 * is a `denied` with the status GitHub sent: the shape moved, and the page
 * should say so rather than crash.
 */
export async function ghRead<T>(
  ctx: Ctx,
  path: string,
  decoder: Decoder<T>,
  ttl: number = LIST_TTL,
  now: number = Date.now(),
): Promise<Answer<T>> {
  const hit = memory.get(path)
  if (hit !== undefined && now - hit.at < hit.ttl) return hit.answer as Answer<T>

  const keep = (answer: Answer<T>, keepFor: number): Answer<T> => {
    memory.set(path, { at: now, ttl: keepFor, answer })
    return answer
  }
  const settle = (status: number | null, body: unknown, access: Access): Answer<T> => {
    if (status !== 200) return keep({ access, value: null, status }, REFUSED_TTL)
    try {
      return keep({ access, value: decode(decoder, body), status }, ttl)
    } catch {
      return keep({ access: 'denied', value: null, status }, LIST_TTL)
    }
  }

  const asApp = await ctx.github.app<unknown>(path)
  if (asApp.error !== null && asApp.error !== 'no-token') {
    return { access: 'unreachable', value: null, status: null }
  }
  if (asApp.status === 200) return settle(200, asApp.body, 'app')
  // The App can see the repository and says the path is not there: a
  // repository with no workflows directory, which is most of the apps. A
  // permission the App lacks is a 403, never a 404.
  if (asApp.status === 404) return keep({ access: 'app', value: null, status: 404 }, ttl)
  if (asApp.status === 403 || asApp.error === 'no-token') {
    if (anonBudget(now).spent) return { access: 'budget', value: null, status: 429 }
    const asAnyone = await ctx.github.anon<unknown>(path)
    if (asAnyone.error !== null) return { access: 'unreachable', value: null, status: null }
    noteAnon(asAnyone.headers)
    if (asAnyone.status === 200) {
      return keep(settle(200, asAnyone.body, 'public'), Math.max(ttl, PUBLIC_TTL))
    }
    // A rate-limited 403 is the budget, not the repository.
    if (asAnyone.retryAfterMs !== null) {
      anon.remaining = 0
      anon.resetAt = Math.max(anon.resetAt, now + asAnyone.retryAfterMs)
      return { access: 'budget', value: null, status: asAnyone.status }
    }
    if (asAnyone.status === 404 || asAnyone.status === 403 || asAnyone.status === 401) {
      return keep({ access: 'needs-actions', value: null, status: asApp.status }, REFUSED_TTL)
    }
    return keep({ access: 'denied', value: null, status: asAnyone.status }, LIST_TTL)
  }
  return keep({ access: 'denied', value: null, status: asApp.status }, LIST_TTL)
}

/* ── which repositories ───────────────────────────────────────────────── */

export type RepoKind = 'app' | 'project' | 'engine'

export type RepoRef = {
  /** owner/name */
  fullName: string
  /** The name alone, for rows. */
  short: string
  kind: RepoKind
  url: string
}

/**
 * The repositories this box has a reason to watch: every app it builds (an
 * app's name IS its repository under the owner), every project on Settings
 * › Projects that names one, and the engine itself when this box's owner is
 * the engine's — its Actions are where the agent and the image are built.
 */
export async function knownRepos(ctx: Ctx): Promise<RepoRef[]> {
  const owner = ctx.site.owner
  const seen = new Set<string>()
  const out: RepoRef[] = []
  const add = (fullName: string, kind: RepoKind) => {
    const key = fullName.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    out.push({
      fullName,
      short: fullName.split('/')[1] ?? fullName,
      kind,
      url: `https://github.com/${fullName}`,
    })
  }
  let apps: { name: string }[] = []
  try {
    apps = await listApps()
  } catch {
    // The database down leaves the registry empty; the page still reads the
    // projects and the engine.
  }
  for (const a of apps) add(`${owner}/${a.name}`, 'app')
  for (const p of await listExternalApps(ctx)) {
    if (p.repo !== null && /^[\w.-]+\/[\w.-]+$/.test(p.repo)) add(p.repo, 'project')
  }
  if (ENGINE_REPO.split('/')[0] === owner) add(ENGINE_REPO, 'engine')
  return out
}
