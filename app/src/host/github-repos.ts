// The repositories an app could be created from: the listing behind the
// create form's picker.
//
// It is the GitHub App's installation — exactly the repositories the box was
// given, which is what a "connect a repo" picker should show and nothing more.
// The installation token is never held here: core/github-app.ts `ghApp` is the
// one door to GitHub as the installation (`listInstallationRepos` goes through
// it), and the token never leaves it.
//
// Read-only, deliberately. Daedalus creates the registry ENTRY; it does not
// create repos or push to them. The App's permissions say the same.

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
  /**
   * Why there is no listing. The list is then EMPTY and the page shows this
   * instead — a short list must never pass for the whole truth.
   */
  error: string | null
}

/** Most recently pushed first: the repo somebody came here to connect is a recent one. */
const byPushed = (a: Repo, b: Repo): number => (b.pushedAt ?? '').localeCompare(a.pushedAt ?? '')

/**
 * What the picker lists. Server-only — it reaches the installation token
 * through `ghApp` — and it never half-answers: a refusal comes back as an
 * empty list WITH the reason, so an empty picker is never mistaken for an
 * account with nothing in it.
 */
export async function listRepos(): Promise<RepoList> {
  const { makeCtx } = await import('../core/ctx')
  const { listInstallationRepos } = await import('../core/github-app')
  const listed = await listInstallationRepos(await makeCtx())
  if (!listed.ok) return { repos: [], error: listed.reason }
  return {
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
