import { join } from 'node:path'
import { obj, optional, recordOf, str } from '../decode'
import { readSnapshot } from '../snapshot'

// /export/images.json — every container's image tag as the flake wrote it,
// WHATEVER shape it is (`10.11.11ubu2404-ls42`, `jvm-stable`, `latest`, `8`).
// Deciding whether a tag names a version is the reader's job; see
// lib/dashboard/images.ts for the pin-vs-label ordering argument.

const shape = obj({ tags: optional(recordOf(str), {}) })

export async function imageTagMap(): Promise<Record<string, string>> {
  const r = await readSnapshot({
    path: join(process.env.EXPORT_DIR ?? '/export', 'images.json'),
    decoder: shape,
    fallback: { tags: {} },
    acceptVersions: [1],
  })
  return r.data.tags
}
