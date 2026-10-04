import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isRecord } from '../lib/is-record'
import { env } from './env'

// site/apps.json as it stands in the site directory (the read-only /site
// mount), raw: what the next build authorizes against and what a register run
// compares its file with. Not decoded: a register keeps every entry it does
// not own byte for byte, so it must see them as written.

export type CommittedRegistry = {
  text: string
  schemaVersion: unknown
  /** Entry name → the entry as written. */
  apps: Record<string, unknown>
}

/** The file, or null when it is missing or not an object with an `apps` object. */
export async function readCommittedRegistry(): Promise<CommittedRegistry | null> {
  let text: string
  try {
    text = await readFile(join(env.get('SITE_PATH'), 'apps.json'), 'utf8')
  } catch {
    return null
  }
  try {
    const doc: unknown = JSON.parse(text)
    if (!isRecord(doc) || !isRecord(doc.apps)) return null
    return { text, schemaVersion: doc.schemaVersion, apps: doc.apps }
  } catch {
    return null
  }
}

/** Whether an entry as written carries the marker (the host's own test: exactly `true`). */
export const isAwaitingEntry = (entry: unknown): boolean =>
  isRecord(entry) && entry.awaitingImage === true
