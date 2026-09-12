import { asc, eq } from 'drizzle-orm'
import { db } from '../db'
import { apps } from '../schema'

// Which app a GitHub repository belongs to, for the webhook.

export type AppRow = typeof apps.$inferSelect

/**
 * The app pinned to this repository id, else the app named after the repo.
 *
 * By id first, so a push from a renamed repo still reaches its app. It does not
 * build there: the host reads the repository by the app's name, so builds for
 * the app fail until the app is renamed to match or the repo is renamed back.
 * The name is only the fallback for an app that is not pinned yet; classifyPush
 * still refuses a name match whose pin disagrees, so a new repo that takes a
 * pinned app's old name comes back `repo-mismatch` rather than claiming the app.
 */
export async function appForRepository(
  repoId: number,
  repoName: string,
): Promise<AppRow | undefined> {
  const pinned = await db.query.apps.findFirst({
    where: eq(apps.githubRepoId, repoId),
    orderBy: [asc(apps.name)],
  })
  if (pinned !== undefined) return pinned
  return db.query.apps.findFirst({ where: eq(apps.name, repoName.toLowerCase()) })
}
