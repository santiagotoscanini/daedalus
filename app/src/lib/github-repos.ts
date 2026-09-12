// The repositories an app could be created from: the listing behind the
// create form's picker.
//
// Read-only, deliberately. Daedalus creates the registry ENTRY; it does not
// create repos or push to them. A credential that can write to a repo is a
// credential that can change what this box runs, and the control plane already
// has enough reach.
//
// Separate from lib/dashboard/github.ts, which reads four public projects'
// release notes. Same API, different question and different credential: that
// one wants rate-limit headroom on public data, this one needs to SEE private
// repos of the account, which the GHCR pull token cannot.

import { swrCache } from './cache'
import { key } from './keys'
import { OWNER } from './site'

// Every app repo lives under OWNER (site.ts, nix-bound). Re-exported so this
// module's importers keep their import path.
export { OWNER }

/**
 * Listings change when a repo is pushed to, which is minutes-to-days apart,
 * and the picker is re-rendered on every keystroke of the search box. A short
 * cache keeps typing from spending the hourly budget.
 */
const TTL_MS = 60_000

const cache = swrCache({ ttlMs: TTL_MS })

/**
 * The credential these reads authenticate with.
 *
 * `GITHUB_REPO_TOKEN` first, when service-keys.sops defines one — that key
 * exists so this can be narrowed to a read-only PAT independently of the
 * credential below.
 *
 * Otherwise `GITHUB_TOKEN`, which is the GHCR pull credential re-shaped by a
 * boot oneshot (stacks/daedalus/daedalus.nix) and already present for the
 * release-notes panels. It is a classic PAT carrying `repo`, so it can list
 * private repositories. Worth knowing what that means: `repo` is read-WRITE on
 * every repository on the account, and this module only ever issues GETs.
 * Narrowing it is what the first key is for.
 *
 * Neither present is a supported state: the listing falls back to the
 * account's PUBLIC repos. The UI says which it is — an empty list because a
 * token is missing must not read as "you have no repos".
 */
function token(): string | null {
  return key('GITHUB_REPO_TOKEN') || key('GITHUB_TOKEN') || null
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
  return cache.get('repos', async () => {
    const authenticated = token() !== null
    const url = authenticated
      ? 'https://api.github.com/user/repos?affiliation=owner&sort=pushed&per_page=100'
      : `https://api.github.com/users/${OWNER}/repos?sort=pushed&per_page=100`

    try {
      const res = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(10_000) })
      if (!res.ok) {
        return {
          repos: [],
          authenticated,
          error: `GitHub answered ${String(res.status)} — ${
            res.status === 401
              ? 'the token is rejected; rotate DASH_GITHUB_REPO_TOKEN'
              : res.status === 403
                ? 'rate limited, or the token lacks repository read'
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
