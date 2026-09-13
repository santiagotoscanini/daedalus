// The repositories an app could be created from: the listing behind the
// create form's picker.
//
// It is the GitHub App's installation — exactly the repositories the box was
// given, which is what a "connect a repo" picker should show and nothing more.
// Nothing here holds a credential: core/github-app.ts `ghApp` is the one door
// to GitHub as the installation, and the token never leaves it.
//
// Read-only, deliberately. Daedalus creates the registry ENTRY; it does not
// create repos or push to them. The App's permissions say the same.
//
// `GITHUB_REPO_TOKEN` (service-keys.sops, rendered as DASH_GITHUB_REPO_TOKEN)
// is the explicit override, and the only reason a PAT path still exists here:
// a personal token lists the ACCOUNT's repositories rather than the
// installation's, which is the escape hatch for connecting a repo the App has
// not been given yet. Unset — the normal case — nothing here reads a PAT.

import { key } from './keys'

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
  /** 'app' when the installation answered, 'token' when the override did. */
  source: 'app' | 'token'
  /**
   * Why there is no listing. The list is then EMPTY and the page shows this
   * instead — a short list must never pass for the whole truth.
   */
  error: string | null
}

type GhRepo = {
  name?: unknown
  description?: unknown
  private?: unknown
  archived?: unknown
  language?: unknown
  pushed_at?: unknown
  html_url?: unknown
}

const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)

/** Most recently pushed first: the repo somebody came here to connect is a recent one. */
const byPushed = (a: Repo, b: Repo): number => (b.pushedAt ?? '').localeCompare(a.pushedAt ?? '')

/**
 * The account's own repositories, through the `GITHUB_REPO_TOKEN` override.
 * One page of 100: this is a personal account, and a picker that paginates is
 * one nobody scrolls to the end of.
 */
async function listByToken(token: string): Promise<RepoList> {
  const refused = (why: string): RepoList => ({
    repos: [],
    source: 'token',
    error: `GITHUB_REPO_TOKEN is set, and ${why}`,
  })
  try {
    const res = await fetch(
      'https://api.github.com/user/repos?affiliation=owner&sort=pushed&per_page=100',
      {
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          Authorization: `Bearer ${token}`,
        },
        signal: AbortSignal.timeout(10_000),
      },
    )
    if (!res.ok) {
      return refused(
        `GitHub answered ${String(res.status)} to it${
          res.status === 401
            ? ': the token is rejected'
            : res.status === 403
              ? ': rate limited, or it lacks repository read'
              : ''
        }.`,
      )
    }
    const body = (await res.json()) as GhRepo[]
    const repos = body
      .filter((r): r is GhRepo & { name: string } => typeof r.name === 'string')
      .map((r) => ({
        name: r.name,
        description: text(r.description),
        private: r.private === true,
        archived: r.archived === true,
        language: text(r.language),
        pushedAt: text(r.pushed_at),
        htmlUrl: text(r.html_url) ?? `https://github.com/${r.name}`,
      }))
    return { repos: repos.sort(byPushed), source: 'token', error: null }
  } catch {
    return refused('GitHub could not be reached.')
  }
}

/**
 * What the picker lists. Server-only — it reaches the installation token
 * through `ghApp` — and it never half-answers: a refusal comes back as an
 * empty list WITH the reason, so an empty picker is never mistaken for an
 * account with nothing in it.
 */
export async function listRepos(): Promise<RepoList> {
  const override = key('GITHUB_REPO_TOKEN')
  if (override !== '') return listByToken(override)

  const { makeCtx } = await import('../core/ctx')
  const { listInstallationRepos } = await import('../core/github-app')
  const listed = await listInstallationRepos(await makeCtx())
  if (!listed.ok) return { repos: [], source: 'app', error: listed.reason }
  return {
    source: 'app',
    error: null,
    repos: listed.repos
      .map((r) => ({
        name: r.name,
        description: r.description,
        private: r.private,
        archived: r.archived,
        language: r.language,
        pushedAt: r.pushedAt,
        htmlUrl: r.htmlUrl,
      }))
      .sort(byPushed),
  }
}
