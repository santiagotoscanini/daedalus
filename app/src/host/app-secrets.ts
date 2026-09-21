import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type AppSecretKey,
  appSecretFile,
  appSecretKeys,
  type SecretKeyHistory,
} from '../lib/apps/secret-keys'
import { isAppName } from '../lib/hostname'
import { env } from './env'

// WHICH keys an app's operator-secrets file holds, and when each was last
// written. Never a value.
//
// Read straight off the ciphertext in the read-only /site mount, not from a
// snapshot: a sops dotenv keeps its key NAMES in the clear, so the listing
// costs one file read and cannot be stale. That asymmetry is the whole reason
// a write-only editor can still show you what it is editing.
//
// The dates come from git, through the repo snapshot the host publishes —
// there is no .git under /site, and there is not meant to be. A key with no
// history is a key whose file has never been committed, or a snapshot from
// before this field existed; both render as "no date", never as a guess.

/** The site directory, read-only in this container. Mirrors core/vault.ts. */
const SITE = (): string => env.get('SITE_PATH')

/**
 * The key names in `<app>-env.sops`, or [] when the app has no such file.
 *
 * An absent file is the ordinary state for an app with no operator secrets —
 * `operator-secrets-lib.nix`'s "the file IS the switch" — so it is an empty
 * list, not an error. Any OTHER read failure is also an empty list: this
 * feeds a listing, and a tab that renders nothing is better than one that
 * throws, while the write path refuses on its own evidence rather than on
 * this.
 */
export async function readAppSecretKeys(app: string): Promise<string[]> {
  // The app name reaches a path here, so it is parsed before it is joined —
  // even though every caller has already checked it.
  if (!isAppName(app)) return []
  try {
    return appSecretKeys(await readFile(join(SITE(), appSecretFile(app)), 'utf8'))
  } catch {
    return []
  }
}

/**
 * Every key of an app's secrets file with the git facts for it, newest write
 * first as the file orders them.
 *
 * The history is looked up per key rather than merged in by the producer, so a
 * key that exists in the file but not in the snapshot (committed since the
 * last run of the 5-minute timer, or never committed at all) still appears.
 */
export async function readAppSecrets(app: string): Promise<AppSecretKey[]> {
  const keys = await readAppSecretKeys(app)
  if (keys.length === 0) return []
  const history = await secretHistory(app)
  return keys.map((key) => ({ key, history: history[key] ?? null }))
}

/** The git facts for one app's keys, keyed by key name. {} when unknown. */
async function secretHistory(app: string): Promise<Record<string, SecretKeyHistory>> {
  const { repoFacts } = await import('./contract/domains/repo')
  const facts = await repoFacts()
  return facts.data.site.appSecrets[app] ?? {}
}
