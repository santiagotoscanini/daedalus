import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Ctx } from '../../core/ctx'
import { imageInfo } from '../../host/registry'
import { decode, num, obj, optional, str } from '../contract/decode'
import {
  deploymentKey,
  deploymentKeysSince,
  insertDeployments,
  sha256Digest,
} from '../repo/deployments'

// Folds deploy.sh's journal into the deployments table (lib/repo/deployments.ts).

const journalLine = obj({
  startedAt: str,
  finishedAt: str,
  app: str,
  digest: str,
  previousDigest: optional(str, ''),
  result: str,
  durationMs: optional(num, 0),
  http: optional(str, ''),
})

type JournalLine = ReturnType<typeof journalLine>

/**
 * Fold `/deploy-state/<app>.log` into the deployments table.
 *
 * Idempotent — the journal is a bounded ring (deploy.sh keeps the last 200
 * lines) that gets re-read on every Deployments tab load and by the build
 * reporter, so re-inserting the same line must be a no-op. Only the rows
 * inside the journal's own window are read to tell which lines are new.
 *
 * Ingest is a pull rather than a push because most deploys never touch
 * daedalus: the timer and manual runs land only in that script.
 */
export async function ingestDeployments(
  ctx: Pick<Ctx, 'env'>,
  appId: string,
  appName: string,
): Promise<void> {
  let raw: string
  try {
    raw = await readFile(join(ctx.env('DEPLOY_STATE_DIR') ?? '', `${appName}.log`), 'utf8')
  } catch {
    return // no deploys recorded yet, or the app has no deploy unit
  }

  const lines = raw
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => {
      try {
        const line = decode(journalLine, JSON.parse(l))
        if (!Number.isFinite(Date.parse(line.startedAt))) return null
        return { ...line, digest: sha256Digest(line.digest) }
      } catch {
        // A torn last line (appended while we read) is expected; skip it
        // rather than failing the whole ingest.
        return null
      }
    })
    .filter((l): l is JournalLine => l !== null)

  if (lines.length === 0) return

  // Which of these are new? Resolving image labels costs two registry
  // round-trips each, so only do it for rows we are actually inserting.
  const since = new Date(Math.min(...lines.map((l) => Date.parse(l.startedAt))))
  const known = await deploymentKeysSince(appId, since)
  const fresh = lines.filter((l) => !known.has(deploymentKey(l.digest, new Date(l.startedAt))))
  if (fresh.length === 0) return

  // Labels are looked up ONCE per digest and stored, not resolved on render:
  // zot's retention will eventually GC an old manifest and the history should
  // outlive the image it describes. All digests at once — each lookup is two
  // requests to the box's own zot, and a first ingest can hold dozens.
  const digests = [...new Set(fresh.map((l) => l.digest))]
  const infos = new Map(
    await Promise.all(digests.map(async (d) => [d, await imageInfo(appName, d)] as const)),
  )

  await insertDeployments(
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
}
