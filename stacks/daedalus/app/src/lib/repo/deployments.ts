import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { desc, eq } from 'drizzle-orm'
import { db } from '../db'
import { deployments } from '../schema'
import { imageInfo } from '../registry'

// Ingests deploy.sh's journal into Postgres, and reads it back for the UI.

const DEPLOY_STATE = process.env.DEPLOY_STATE_DIR ?? '/deploy-state'

type JournalLine = {
  startedAt: string
  finishedAt: string
  app: string
  digest: string
  previousDigest: string
  result: string
  durationMs: number
  http: string
}

/**
 * Fold `/deploy-state/<app>.log` into the deployments table.
 *
 * Idempotent — the journal is a bounded ring (deploy.sh keeps the last 200
 * lines) that gets re-read on every page load, so re-inserting the same line
 * must be a no-op. The unique index on (app, digest, startedAt) is what makes
 * onConflictDoNothing sufficient.
 *
 * Ingest is a pull rather than a push because most deploys never touch
 * daedalus: the timer and manual runs land only in that script.
 */
export async function ingestDeployments(appId: string, appName: string): Promise<void> {
  let raw: string
  try {
    raw = await readFile(join(DEPLOY_STATE, `${appName}.log`), 'utf8')
  } catch {
    return // no deploys recorded yet, or the app has no deploy unit
  }

  const lines = raw
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => {
      try {
        return JSON.parse(l) as JournalLine
      } catch {
        // A torn last line (appended while we read) is expected; skip it
        // rather than failing the whole ingest.
        return null
      }
    })
    .filter((l): l is JournalLine => l !== null && typeof l.digest === 'string')

  if (lines.length === 0) return

  // Which of these are new? Resolving image labels costs two registry
  // round-trips each, so only do it for rows we are actually inserting.
  const known = new Set(
    (
      await db
        .select({ digest: deployments.digest, startedAt: deployments.startedAt })
        .from(deployments)
        .where(eq(deployments.appId, appId))
    ).map((r) => `${r.digest}@${r.startedAt.toISOString()}`),
  )

  const fresh = lines.filter((l) => !known.has(`${l.digest}@${new Date(l.startedAt).toISOString()}`))
  if (fresh.length === 0) return

  // Labels are looked up ONCE per digest and stored, not resolved on render:
  // zot's retention will eventually GC an old manifest and the history should
  // outlive the image it describes.
  const infos = new Map<string, Awaited<ReturnType<typeof imageInfo>>>()
  for (const digest of new Set(fresh.map((l) => l.digest))) {
    infos.set(digest, await imageInfo(appName, digest))
  }

  await db
    .insert(deployments)
    .values(
      fresh.map((l) => {
        const info = infos.get(l.digest)
        return {
          appId,
          digest: l.digest,
          previousDigest: l.previousDigest || null,
          result: l.result,
          httpCode: l.http || null,
          startedAt: new Date(l.startedAt),
          finishedAt: new Date(l.finishedAt),
          durationMs: Number.isFinite(l.durationMs) ? l.durationMs : 0,
          revision: info?.revision ?? null,
          sourceUrl: info?.sourceUrl ?? null,
          imageCreatedAt: info?.createdAt ?? null,
        }
      }),
    )
    .onConflictDoNothing()
}

export async function listDeployments(appId: string, limit = 25) {
  return db
    .select()
    .from(deployments)
    .where(eq(deployments.appId, appId))
    .orderBy(desc(deployments.startedAt))
    .limit(limit)
}
