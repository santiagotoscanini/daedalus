import type { Ctx } from '../../../core/ctx'
import { type VersionGap, versionGap } from '../../../lib/dashboard/github'
import { imageTag } from '../../../lib/dashboard/images'
import { getJson } from '../../../lib/http'

/* ── Calibre ──────────────────────────────────────────────────────────── */

/**
 * The book shelf, beside Jellyfin rather than in a "Books" section.
 *
 * Both are the END of a pipeline — the thing a person actually opens — and
 * everything after the rule on the tab row is machinery that fills them. Books
 * used to be its own tab pairing the shelf with its downloader, which put a
 * downloader on the far side of that line from every other downloader.
 */
export type CalibreData = {
  version: string | null
  gap: VersionGap
  books: number | null
  authors: number | null
  series: number | null
  categories: number | null
  disk: { usedBytes: number | null; freeBytes: number | null }
}

export async function loadCalibre(ctx: Ctx): Promise<CalibreData> {
  const version = await imageTag('calibre-web')

  const [stats, disk, gap] = await Promise.all([
    // /opds is on calibre-web's forward-auth bypass and takes its own basic
    // auth (stacks/calibre-web), so this reads it with those credentials.
    getJson<{ books?: number; authors?: number; categories?: number; series?: number }>(
      `${ctx.hosts.base('calibre-web')}/opds/stats`,
      {
        headers: {
          Authorization: `Basic ${Buffer.from(
            `${ctx.secret('CALIBREWEB_USER')}:${ctx.secret('CALIBREWEB_PASS')}`,
          ).toString('base64')}`,
        },
      },
    ),
    ctx.prom.scalars({
      size: 'node_filesystem_size_bytes{mountpoint="/s2/books"}',
      avail: 'node_filesystem_avail_bytes{mountpoint="/s2/books"}',
    }),
    imageTag('calibre-web').then((v) =>
      versionGap('crocodilestick/Calibre-Web-Automated', v, {
        tag: /^[Vv]?(\d+\.\d+\.\d+)$/,
      }),
    ),
  ])

  return {
    version,
    gap,
    books: stats?.books ?? null,
    authors: stats?.authors ?? null,
    series: stats?.series ?? null,
    categories: stats?.categories ?? null,
    disk: {
      usedBytes: disk.size !== null && disk.avail !== null ? disk.size - disk.avail : null,
      freeBytes: disk.avail,
    },
  }
}
