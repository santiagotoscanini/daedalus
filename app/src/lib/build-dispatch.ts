// Which queued builds the scheduler cancels, holds, and runs next — the pure
// half of core/builds/dispatch.ts, which reads the inputs and acts on the plan.

import { type BuildRow, nextToRun } from './build-queue'

export const BOX_BUILDS_OFF = 'box builds off'

/** The minter says the App is not installed (removed or suspended). */
export const NO_INSTALLATION = 'no installation'

/** What the scheduler reads of an app. */
export type AppBuildFacts = {
  id: string
  name: string
  buildOnBox: boolean
  githubRepoId: number | null
  buildStrategy: string
  buildPublish: string
  buildEnvPlaceholders: Record<string, string>
  railpackEnv: Record<string, string>
}

export type DispatchPlan = {
  /** Queued rows that can never build as asked, with the error they are cancelled with. */
  cancel: { row: BuildRow; error: string }[]
  /** Queued and waiting, with why — an unpinned repo, or an app not in apps.json yet. */
  held: { row: BuildRow; reason: string }[]
  next: BuildRow | null
}

/**
 * Pure: which queued builds are cancelled, held, and which one runs next.
 * `inManifest` null means "not picking one now" (a build is in flight): the
 * cancellations still apply, and nothing is chosen.
 */
export function planDispatch(
  queued: BuildRow[],
  apps: Map<string, AppBuildFacts>,
  opts: { inManifest: Set<string> | null; installed: boolean },
): DispatchPlan {
  const cancel: DispatchPlan['cancel'] = []
  const held: DispatchPlan['held'] = []
  const candidates: BuildRow[] = []
  for (const row of queued) {
    if (row.state !== 'queued') continue
    const app = apps.get(row.app)
    if (!opts.installed) cancel.push({ row, error: NO_INSTALLATION })
    else if (app === undefined || !app.buildOnBox) cancel.push({ row, error: BOX_BUILDS_OFF })
    else if (app.githubRepoId === null) {
      held.push({
        row,
        reason: `${row.app} has no GitHub repository pinned yet; it builds once the hourly sweep finds a repository named ${row.app}.`,
      })
    } else candidates.push(row)
  }
  if (opts.inManifest === null) return { cancel, held, next: null }
  const pick = nextToRun(candidates, { inManifest: opts.inManifest, inFlight: false })
  return { cancel, held: [...held, ...pick.held], next: pick.row }
}
