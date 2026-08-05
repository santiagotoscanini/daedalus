// The repositories an app could be created from, and whether each one is
// actually ready to become one.
//
// Read-only, deliberately. Daedalus creates the registry ENTRY; it does not
// create repos, push workflows or set repo secrets. That half stays manual for
// the same reason the runner PAT never enters a container (lib/ci.ts): a
// credential that can write to a repo is a credential that can change what CI
// builds and therefore what this box runs, and the control plane already has
// enough reach. What daedalus can do is tell you, before you commit to an
// entry, exactly which of the manual steps are still missing — the checks
// below are the checklist from stacks/apps/declarations.nix, answered.
//
// Separate from lib/dashboard/github.ts, which reads four public projects'
// release notes. Same API, different question and different credential: that
// one wants rate-limit headroom on public data, this one needs to SEE private
// repos of the account, which the GHCR pull token cannot.

import { key } from './dashboard/format'

/** Every app repo lives under this account — the same assumption stacks/gha-runner makes. */
export const OWNER = 'santiagotoscanini'

/**
 * Listings change when a repo is pushed to, which is minutes-to-days apart,
 * and the picker is re-rendered on every keystroke of the search box. A short
 * cache keeps typing from spending the hourly budget.
 */
const TTL_MS = 60_000

type Cached<T> = { at: number; value: T }
const cache = new Map<string, Cached<unknown>>()

async function cached<T>(k: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(k) as Cached<T> | undefined
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value
  const value = await load()
  cache.set(k, { at: Date.now(), value })
  return value
}

/**
 * The read-only PAT, when one is configured.
 *
 * `DASH_GITHUB_REPO_TOKEN` is its own key in service-keys.sops rather than a
 * reuse of `DASH_GITHUB_TOKEN`: that one is scraped out of the GHCR authfile
 * and carries `read:packages` only, which cannot list private repositories.
 * Both are read-only and neither can write anything.
 *
 * Absent is a supported state: the listing falls back to the account's PUBLIC
 * repos and every check that needs authentication reports `unknown` rather
 * than failing. The UI says which of the two it is — an empty list because a
 * token is missing must not read as "you have no repos".
 */
function token(): string | null {
  return key('GITHUB_REPO_TOKEN') || null
}

function headers(): Record<string, string> {
  const t = token()
  return {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(t ? { Authorization: `Bearer ${t}` } : {}),
  }
}

export type Repo = {
  name: string
  description: string | null
  private: boolean
  archived: boolean
  language: string | null
  pushedAt: string | null
  htmlUrl: string
}

export type RepoList = {
  repos: Repo[]
  /** False when the token is absent — the list is then public repos only. */
  authenticated: boolean
  /** Set when GitHub refused. The list is empty AND the reason is shown. */
  error: string | null
}

type GhRepo = {
  name?: string
  description?: string | null
  private?: boolean
  archived?: boolean
  language?: string | null
  pushed_at?: string | null
  html_url?: string
}

/**
 * The account's repositories, most recently pushed first.
 *
 * `/user/repos` with a token (it sees private ones), `/users/{owner}/repos`
 * without. One page of 100: this is a personal account, and a picker that
 * paginates is a picker nobody scrolls to the end of. The search box filters
 * what came back rather than querying — 100 names filter instantly and the
 * search API has a far tighter rate limit.
 */
export async function listRepos(): Promise<RepoList> {
  return cached('repos', async () => {
    const authenticated = token() !== null
    const url =
      authenticated ?
        'https://api.github.com/user/repos?affiliation=owner&sort=pushed&per_page=100'
      : `https://api.github.com/users/${OWNER}/repos?sort=pushed&per_page=100`

    try {
      const res = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(10_000) })
      if (!res.ok) {
        return {
          repos: [],
          authenticated,
          error: `GitHub answered ${String(res.status)} — ${
            res.status === 401 ? 'the token is rejected; rotate DASH_GITHUB_REPO_TOKEN'
            : res.status === 403 ? 'rate limited, or the token lacks repository read'
            : 'unexpected'
          }`,
        }
      }

      const body = (await res.json()) as GhRepo[]
      return {
        authenticated,
        error: null,
        repos: body
          .filter((r): r is GhRepo & { name: string } => typeof r.name === 'string')
          .map((r) => ({
            name: r.name,
            description: r.description ?? null,
            private: r.private ?? false,
            archived: r.archived ?? false,
            language: r.language ?? null,
            pushedAt: r.pushed_at ?? null,
            htmlUrl: r.html_url ?? `https://github.com/${OWNER}/${r.name}`,
          })),
      }
    } catch {
      return { repos: [], authenticated, error: 'GitHub could not be reached' }
    }
  })
}

/**
 * A single preflight answer.
 *
 * `unknown` is a first-class state and NOT a synonym for `bad`. Two of these
 * checks can only be answered by a credential daedalus deliberately does not
 * hold; reporting those as failures would train you to click past the
 * checklist, which is the one thing that would make it useless.
 */
export type CheckState = 'ok' | 'warn' | 'bad' | 'unknown'

export type Check = {
  id: string
  label: string
  state: CheckState
  detail: string
  /** What to do about it, when there is something to do. */
  fix?: string
}

export type RepoChecks = {
  checks: Check[]
  /** Workflow filenames found, for the detail lines. */
  workflows: string[]
}

type GhContent = { name?: string; type?: string; path?: string }

async function ghJson<T>(path: string): Promise<{ status: number; body: T | null }> {
  try {
    const res = await fetch(`https://api.github.com${path}`, {
      headers: headers(),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return { status: res.status, body: null }
    return { status: res.status, body: (await res.json()) as T }
  } catch {
    return { status: 0, body: null }
  }
}

async function ghRaw(path: string): Promise<string | null> {
  try {
    const res = await fetch(`https://api.github.com${path}`, {
      headers: { ...headers(), Accept: 'application/vnd.github.raw' },
      signal: AbortSignal.timeout(10_000),
    })
    return res.ok ? await res.text() : null
  } catch {
    return null
  }
}

/** Workflow files read per repo. Enough for ci + image + release, not a crawl. */
const MAX_WORKFLOWS = 6

/**
 * The repo-side half of "add an app", checked rather than remembered.
 *
 * Each of these is a step from the workflow comment in
 * stacks/apps/declarations.nix. Skipping one does not fail the Apply — it
 * fails later and somewhere else (a container that restart-loops on a missing
 * image, a runner unit that restart-loops on a 404 from the registration-token
 * endpoint), which is exactly the kind of failure worth moving forward in
 * time.
 */
export async function repoChecks(repo: string): Promise<RepoChecks> {
  return cached(`checks:${repo}`, async () => {
    const checks: Check[] = []

    // --- workflows ---------------------------------------------------------
    const dir = await ghJson<GhContent[]>(
      `/repos/${OWNER}/${repo}/contents/${encodeURIComponent('.github/workflows')}`,
    )
    const files = (dir.body ?? [])
      .filter((f) => f.type === 'file' && (f.name ?? '').match(/\.ya?ml$/))
      .slice(0, MAX_WORKFLOWS)
    const workflows = files.map((f) => f.name ?? '')

    const bodies = await Promise.all(
      files.map((f) => ghRaw(`/repos/${OWNER}/${repo}/contents/${encodeURIComponent(f.path ?? '')}`)),
    )
    const allYaml = bodies.filter((b): b is string => b !== null).join('\n')

    if (dir.status === 404) {
      checks.push({
        id: 'workflows',
        label: 'CI workflows',
        state: 'bad',
        detail: 'no .github/workflows in the repo',
        fix: 'Copy ci.yml and image.yml from an existing app repo.',
      })
    } else if (dir.body === null) {
      checks.push({
        id: 'workflows',
        label: 'CI workflows',
        state: 'unknown',
        detail:
          dir.status === 0 ?
            'GitHub could not be reached'
          : `GitHub answered ${String(dir.status)}`,
      })
    } else {
      checks.push({
        id: 'workflows',
        label: 'CI workflows',
        state: workflows.length > 0 ? 'ok' : 'bad',
        detail:
          workflows.length > 0 ?
            workflows.join(', ')
          : 'the directory exists but holds no workflow files',
      })
    }

    // --- does anything publish an image to this box's registry? ------------
    //
    // Grepping the YAML rather than parsing it: the question is "does this repo
    // push to zot at all", which a substring answers, and a YAML parser here
    // would be a dependency plus a schema to keep in step with GitHub's.
    const pushesImage = allYaml.includes('registry.toscanini.me')
    checks.push({
      id: 'image-workflow',
      label: 'Publishes to registry.toscanini.me',
      state: allYaml === '' ? 'unknown' : pushesImage ? 'ok' : 'bad',
      detail:
        allYaml === '' ? 'no workflow contents could be read'
        : pushesImage ? 'a workflow pushes to the box’s registry'
        : 'no workflow mentions the registry — nothing would ever be deployed',
      fix:
        pushesImage ? undefined : (
          'Add the image workflow that builds and pushes registry.toscanini.me/<name>:latest.'
        ),
    })

    // --- the container the platform will run -------------------------------
    const root = await ghJson<GhContent[]>(`/repos/${OWNER}/${repo}/contents/`)
    const hasContainerfile = (root.body ?? []).some((f) =>
      ['Dockerfile', 'Containerfile'].includes(f.name ?? ''),
    )
    checks.push({
      id: 'containerfile',
      label: 'Dockerfile at the repo root',
      state: root.body === null ? 'unknown' : hasContainerfile ? 'ok' : 'warn',
      detail:
        root.body === null ? 'the repo contents could not be read'
        : hasContainerfile ? 'found'
        : 'none at the root — fine if the workflow builds from elsewhere',
    })

    // --- the credential CI pushes with -------------------------------------
    //
    // 403 here is the expected answer for a token without `Secrets: read`, and
    // it is reported as unknown: the platform never reads this secret, only CI
    // does, so daedalus not being able to see it is a gap in the CHECK, not in
    // the setup.
    const secret = await ghJson<unknown>(
      `/repos/${OWNER}/${repo}/actions/secrets/REGISTRY_PASSWORD`,
    )
    checks.push({
      id: 'registry-secret',
      label: 'REGISTRY_PASSWORD repo secret',
      state:
        secret.status === 200 ? 'ok'
        : secret.status === 404 ? 'bad'
        : 'unknown',
      detail:
        secret.status === 200 ? 'set'
        : secret.status === 404 ? 'not set — the image push will 401'
        : secret.status === 403 ? 'the token cannot read repo secrets — check by hand'
        : 'could not be checked',
      fix:
        secret.status === 404 ?
          'gh secret set REGISTRY_PASSWORD --repo ' +
          `${OWNER}/${repo}` +
          ' (the ci password from stacks/registry/env.sops)'
        : undefined,
    })

    return { checks, workflows }
  })
}
