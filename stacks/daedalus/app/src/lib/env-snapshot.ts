import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  IMAGE_KEYS,
  PLATFORM_KEYS,
  isSecret,
  type EnvGroup,
  type EnvOrigin,
  type EnvVar,
} from './env-groups'

// Deliberately NOT re-exporting GROUP_LABELS and friends. A convenience
// re-export here would let a component import them from this module, which
// pulls node:fs/promises into the browser bundle — exactly the bug this split
// fixes. Client code imports ./env-groups; only this module reads the disk.

// The merged environment a container actually has, as published by
// daedalus-env-snapshot (stacks/daedalus/host/env-snapshot.sh).
//
// Read from the container rather than re-derived: it is the only place where
// what the platform injects, what the registry declares, what the image bakes
// in, and every --env-file value are already combined. Reconstructing it here
// would mean reimplementing stacks/apps and then drifting from it.

const ENV_DIR = process.env.ENV_SNAPSHOT_DIR ?? '/env-snapshot'

export type EnvSnapshot = {
  vars: EnvVar[]
  /** When the snapshot was taken; the UI shows this so nobody reads a stale env as current. */
  takenAt: string | null
  available: boolean
}

/**
 * @param declared keys the registry declares for this app, used only to label
 *        origin — the VALUES always come from the container.
 * @param hasSecretsFile whether the app has a tracked <name>-env.sops. Without
 *        it, an unrecognised key can only have come from the image; with it,
 *        the sops file is by far the likelier source, and saying so is more
 *        useful than a shrug.
 */
export async function readEnvSnapshot(
  app: string,
  declared: Map<string, string | null>,
  hasSecretsFile = false,
): Promise<EnvSnapshot> {
  const path = join(ENV_DIR, `${app}.json`)

  let raw: string
  let takenAt: string | null = null
  try {
    ;[raw, takenAt] = await Promise.all([
      readFile(path, 'utf8'),
      stat(path).then((s) => s.mtime.toISOString()),
    ])
  } catch {
    // No snapshot: the app has no running container, or the timer has not run
    // since it started. Reported as unavailable rather than as "no variables",
    // which would read as a configuration fact rather than a missing file.
    return { vars: [], takenAt: null, available: false }
  }

  let entries: string[]
  try {
    entries = JSON.parse(raw) as string[]
  } catch {
    return { vars: [], takenAt, available: false }
  }

  const vars: EnvVar[] = entries.map((entry) => {
    // Split on the FIRST '=' only: values legitimately contain '=' (a
    // DATABASE_URL query string, a base64 secret).
    const eq = entry.indexOf('=')
    const key = eq === -1 ? entry : entry.slice(0, eq)
    const value = eq === -1 ? '' : entry.slice(eq + 1)

    // Order matters. A registry declaration wins over everything — if the
    // author wrote it down, that is where it came from. Then the explicit
    // platform list, then the base image. Whatever is left is the app's own
    // sops file if it has one, and genuinely unknown if it does not.
    const origin: EnvOrigin =
      declared.has(key) ? 'registry'
      : key in PLATFORM_KEYS ? 'platform'
      : IMAGE_KEYS.has(key) ? 'image'
      : hasSecretsFile ? 'secrets'
      : 'image'

    const group: EnvGroup =
      origin === 'platform' ? (PLATFORM_KEYS[key] ?? 'other')
      : origin === 'image' ? 'runtime'
      : 'other'

    return {
      key,
      value,
      secret: isSecret(key),
      origin,
      group,
      note: declared.get(key) ?? null,
    }
  })

  vars.sort((a, b) => a.key.localeCompare(b.key))
  return { vars, takenAt, available: true }
}
