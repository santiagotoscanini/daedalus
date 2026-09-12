import { defineBridge } from '../lib/bridge'
import { readCommittedSite } from '../lib/contract/domains/site-doc'
import type { SnapshotResult } from '../lib/contract/snapshot'
import { type GithubInstallation, readGithubInstallation, usableToken } from '../lib/github-token'
import type { Ctx } from './ctx'
import type { SiteGithubApp } from './site/file'

// The daedalus GitHub App, server side: who the App is (the committed
// site.json), what the host's token minter last published, and the one door
// every App-authenticated call to GitHub goes through.
//
// This container never holds the App's private key. The most it holds is the
// one-hour installation token the host mints into a read-only mount, and that
// token stays inside ghApp(): it is never part of a result, an error or a log.

export const GITHUB_API = 'https://api.github.com'
export const GITHUB_API_VERSION = '2022-11-28'

const TIMEOUT_MS = 10_000
/** A rate-limited caller leaves GitHub alone at least this long, whatever retry-after says. */
export const MIN_BACKOFF_MS = 60_000
/** The host mints at most once a minute anyway; asking more often only rewrites the file. */
const REFRESH_DEBOUNCE_MS = 60_000

/** The App as the committed site.json records it; null when there is none. */
export async function appIdentity(_ctx: Ctx): Promise<SiteGithubApp | null> {
  const site = await readCommittedSite()
  return site.present ? (site.doc.github?.app ?? null) : null
}

/** The installation file the host's minter publishes (GITHUB_TOKEN_PATH). */
export function installationState(ctx: Ctx): Promise<SnapshotResult<GithubInstallation>> {
  return readGithubInstallation(ctx.env)
}

const tokenRequest = defineBridge({
  requestFile: 'github-token-request.json',
  statusFile: 'github-token-status.json',
  idle: { id: null, state: 'idle' },
})

// On globalThis so a Vite re-evaluation does not reset the debounce.
const memo = globalThis as unknown as { daedalusGithubTokenRefreshAt?: number }

/**
 * Ask the host to mint a fresh installation token now rather than at its next
 * half-hour tick. Debounced per process; true when a request was written.
 */
export async function requestTokenRefresh(): Promise<boolean> {
  const now = Date.now()
  if (now - (memo.daedalusGithubTokenRefreshAt ?? 0) < REFRESH_DEBOUNCE_MS) return false
  memo.daedalusGithubTokenRefreshAt = now
  try {
    await tokenRequest.request({ version: 1 })
    return true
  } catch {
    return false
  }
}

export type GhError = 'no-token' | 'timeout' | 'unreachable' | 'invalid-path'

export type GhResult<T = unknown> = {
  /** GitHub's HTTP status; null when it never answered or nothing was sent. */
  status: number | null
  /** The parsed JSON body; null when there was none or it was not JSON. */
  body: T | null
  headers: Headers
  /** Set on a rate-limit answer: how long to leave GitHub alone. */
  retryAfterMs: number | null
  /** Why `status` is null. */
  error: GhError | null
}

/**
 * How long a 403 or 429 asks the caller to wait, or null when it is not a rate
 * limit (a 403 is also "the token lacks this permission"). GitHub's secondary
 * limits send retry-after; the primary one sends a zero remaining count and a
 * reset time; a secondary limit with neither means at least a minute.
 */
export function retryAfterMs(status: number, headers: Headers, now = Date.now()): number | null {
  if (status !== 403 && status !== 429) return null
  const after = headers.get('retry-after')
  if (after !== null) {
    const seconds = Number(after)
    const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(after) - now
    if (Number.isFinite(ms)) return Math.max(MIN_BACKOFF_MS, ms)
  }
  if (headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(headers.get('x-ratelimit-reset')) * 1000
    return Math.max(MIN_BACKOFF_MS, Number.isFinite(reset) ? reset - now : 0)
  }
  return status === 429 ? MIN_BACKOFF_MS : null
}

/**
 * One call to the GitHub API as the installation. Never throws and never
 * retries: a 401 asks the host for a new token (once, debounced) and a rate
 * limit comes back as `retryAfterMs`, and what to do next is the caller's call.
 */
export async function ghApp<T = unknown>(
  ctx: Ctx,
  path: string,
  init: RequestInit = {},
): Promise<GhResult<T>> {
  const none = (error: GhError): GhResult<T> => ({
    status: null,
    body: null,
    headers: new Headers(),
    retryAfterMs: null,
    error,
  })
  // A path, never a URL: nothing here may send the token to another host.
  if (!path.startsWith('/') || path.startsWith('//')) return none('invalid-path')

  const token = usableToken(await installationState(ctx))
  if (token === null) {
    await requestTokenRefresh()
    return none('no-token')
  }

  const headers = new Headers(init.headers)
  headers.set('Accept', 'application/vnd.github+json')
  headers.set('X-GitHub-Api-Version', GITHUB_API_VERSION)
  headers.set('User-Agent', 'daedalus')
  headers.set('Authorization', `Bearer ${token}`)
  if (init.body !== undefined && init.body !== null && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  let res: Response
  let text: string
  try {
    res = await fetch(`${GITHUB_API}${path}`, {
      ...init,
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    text = await res.text()
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')
    return none(timedOut ? 'timeout' : 'unreachable')
  }

  if (res.status === 401) await requestTokenRefresh()

  let body: T | null = null
  if (text !== '') {
    try {
      body = JSON.parse(text) as T
    } catch {
      body = null
    }
  }
  return {
    status: res.status,
    body,
    headers: res.headers,
    retryAfterMs: retryAfterMs(res.status, res.headers),
    error: null,
  }
}

/** A failed ghApp result, as a sentence that is safe to show. */
export function describeGhFailure(r: GhResult): string {
  switch (r.error) {
    case 'no-token':
      return 'The host has not published a usable installation token; a new one has been requested.'
    case 'timeout':
      return 'GitHub did not answer within 10 seconds.'
    case 'unreachable':
      return 'GitHub could not be reached.'
    case 'invalid-path':
      return 'The request was not a GitHub API path.'
    case null:
      break
  }
  if (r.status === 401)
    return 'GitHub refused the installation token; a new one has been requested.'
  if (r.retryAfterMs !== null) {
    return `GitHub's rate limit is spent; try again in ${String(Math.ceil(r.retryAfterMs / 60_000))} min.`
  }
  return `GitHub answered ${String(r.status)}.`
}

export type InstallationRepo = {
  id: number
  name: string
  fullName: string
  private: boolean
  archived: boolean
  defaultBranch: string
  htmlUrl: string
  pushedAt: string | null
  /** The two the create form's picker renders; nothing else reads them. */
  description: string | null
  language: string | null
}

export type InstallationRepos =
  | { ok: true; repos: InstallationRepo[]; total: number }
  | { ok: false; reason: string; retryAfterMs: number | null }

const PER_PAGE = 100
const MAX_PAGES = 10

function readRepo(raw: unknown): InstallationRepo | null {
  if (raw === null || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (
    typeof r.id !== 'number' ||
    typeof r.name !== 'string' ||
    typeof r.full_name !== 'string' ||
    typeof r.default_branch !== 'string' ||
    typeof r.html_url !== 'string'
  ) {
    return null
  }
  return {
    id: r.id,
    name: r.name,
    fullName: r.full_name,
    private: r.private === true,
    archived: r.archived === true,
    defaultBranch: r.default_branch,
    htmlUrl: r.html_url,
    pushedAt: typeof r.pushed_at === 'string' ? r.pushed_at : null,
    description: text(r.description),
    language: text(r.language),
  }
}

const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)

/** Every repository the installation can see, by name. */
export async function listInstallationRepos(ctx: Ctx): Promise<InstallationRepos> {
  const repos: InstallationRepo[] = []
  let total = 0
  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await ghApp<{ total_count?: unknown; repositories?: unknown }>(
      ctx,
      `/installation/repositories?per_page=${String(PER_PAGE)}&page=${String(page)}`,
    )
    if (r.status !== 200 || r.body === null) {
      return { ok: false, reason: describeGhFailure(r), retryAfterMs: r.retryAfterMs }
    }
    const list = Array.isArray(r.body.repositories) ? (r.body.repositories as unknown[]) : []
    if (typeof r.body.total_count === 'number') total = r.body.total_count
    for (const raw of list) {
      const repo = readRepo(raw)
      if (repo !== null) repos.push(repo)
    }
    if (list.length < PER_PAGE || repos.length >= total) break
  }
  repos.sort((a, b) => a.name.localeCompare(b.name))
  return { ok: true, repos, total: Math.max(total, repos.length) }
}

/** A repository as GitHub names it now. `owner`/`name` are `fullName`, split. */
export type RepoById = {
  id: number
  fullName: string
  owner: string
  name: string
  defaultBranch: string
}

export type RepoLookup = { ok: true; repo: RepoById } | { ok: false; reason: string }

/**
 * The repository with this id — the ONE way anything in the build and report
 * path names a repo to GitHub.
 *
 * `apps.githubRepoId` is what the sweep pinned and what the webhook matches on;
 * the app's own name is a label that a rename makes wrong, and every path that
 * built `owner/<app name>` broke silently the moment somebody renamed a repo.
 * Asked every time rather than cached: a rename is exactly the case this
 * exists for, and one GET against a 5000/hour budget is cheaper than a wrong
 * answer kept warm.
 */
export async function repoById(ctx: Ctx, id: number): Promise<RepoLookup> {
  if (!Number.isSafeInteger(id) || id <= 0) return { ok: false, reason: 'Not a repository id.' }
  const r = await ghApp<{ id?: unknown; full_name?: unknown; default_branch?: unknown }>(
    ctx,
    `/repositories/${String(id)}`,
  )
  if (r.status !== 200 || r.body === null) return { ok: false, reason: describeGhFailure(r) }
  const { id: got, full_name: fullName, default_branch: defaultBranch } = r.body
  const [owner = '', name = ''] = typeof fullName === 'string' ? fullName.split('/') : []
  if (got !== id || typeof fullName !== 'string' || owner === '' || name === '') {
    return { ok: false, reason: 'GitHub answered with a repository this app is not linked to.' }
  }
  return {
    ok: true,
    repo: {
      id,
      fullName,
      owner,
      name,
      defaultBranch: typeof defaultBranch === 'string' ? defaultBranch : 'main',
    },
  }
}
