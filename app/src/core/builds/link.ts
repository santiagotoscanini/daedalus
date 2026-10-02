import type { Result } from '../../lib/result'
import type { Ctx } from '../ctx'
import type { InstallationRepo } from '../github-app'

// Linking an app to its GitHub repository: the pin that pushes, Build now and
// the sweep all key off (`apps.githubRepoId`).
//
// The id comes from the installed App's own listing, matched by the app's
// name — never from a push payload, which would let whichever repository holds
// the name at that moment claim the app. One lookup, used by every door that
// wants a link now: the create form, Build now (button and MCP tool) and a
// push for an app that is not linked yet. The hourly sweep lists once for every
// app and pins through `pinNamed`, the same write.

export type RepoLink = Result<{ repoId: number; fullName: string | null }>

/**
 * Pin the app to this repository, unless something already did. False when
 * another writer pinned it between the caller's read and this write.
 */
export async function pinNamed(
  app: { id: string; name: string },
  named: Pick<InstallationRepo, 'id' | 'fullName'>,
): Promise<boolean> {
  const { pinGithubRepoId } = await import('../../lib/repo/builds')
  if (!(await pinGithubRepoId(app.id, named.id))) return false
  console.info(
    `[builds] pinned ${app.name} to ${named.fullName} (repository id ${String(named.id)})`,
  )
  return true
}

/**
 * The app's repository id: its pin, or the repository the installed App sees
 * under the app's name, pinned now. A refusal says why in words a page can show.
 */
export async function linkAppRepo(
  ctx: Ctx,
  app: { id: string; name: string; githubRepoId: number | null },
): Promise<RepoLink> {
  if (app.githubRepoId !== null) {
    return { ok: true, value: { repoId: app.githubRepoId, fullName: null } }
  }

  const { listInstallationRepos } = await import('../github-app')
  const listed = await listInstallationRepos(ctx)
  if (!listed.ok) {
    return {
      ok: false,
      reason: `Could not ask GitHub for the App's repositories: ${listed.reason}`,
    }
  }
  const named = listed.repos.find((r) => r.name.toLowerCase() === app.name.toLowerCase())
  if (named === undefined) {
    return {
      ok: false,
      reason: `The GitHub App cannot see a repository named ${app.name}. Give the installation access to it on GitHub, then try again.`,
    }
  }
  if (await pinNamed(app, named)) {
    return { ok: true, value: { repoId: named.id, fullName: named.fullName } }
  }

  // Raced: someone pinned it first. Their pin is the answer.
  const { getApp } = await import('../../lib/repo/apps')
  const fresh = await getApp(app.name)
  if (fresh === undefined || fresh.githubRepoId === null) {
    return { ok: false, reason: `${app.name} could not be linked; try again.` }
  }
  return { ok: true, value: { repoId: fresh.githubRepoId, fullName: null } }
}
