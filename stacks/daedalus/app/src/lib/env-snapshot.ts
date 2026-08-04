import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

// The merged environment a container actually has, as published by
// daedalus-env-snapshot (stacks/daedalus/host/env-snapshot.sh).
//
// Read from the container rather than re-derived: it is the only place where
// what the platform injects, what the registry declares, what the image bakes
// in, and every --env-file value are already combined. Reconstructing it here
// would mean reimplementing stacks/apps and then drifting from it.

const ENV_DIR = process.env.ENV_SNAPSHOT_DIR ?? '/env-snapshot'

export type EnvOrigin = 'registry' | 'platform' | 'image'

export type EnvVar = {
  key: string
  value: string
  secret: boolean
  origin: EnvOrigin
  note?: string | null
}

/**
 * Names whose VALUES are withheld until explicitly revealed.
 *
 * Matched on the name, not the value: a heuristic on content would both miss
 * things and mangle innocent ones. Deliberately broad — a false positive costs
 * one click, a false negative prints a database password into a screenshot.
 */
const SECRET_RE =
  /(SECRET|PASSWORD|PASSWD|_PASS$|TOKEN|API_?KEY|_KEY$|^KEY$|PEPPER|CREDENTIAL|DATABASE_URL|CONNECTION_STRING|DSN)/i

/** Baked into the base image or set by podman — context, not configuration. */
const IMAGE_KEYS = new Set([
  'PATH',
  'HOME',
  'HOSTNAME',
  'HOST',
  'TERM',
  'container',
  'NODE_VERSION',
  'NODE_ENV',
  'YARN_VERSION',
  'COREPACK_HOME',
  'LANG',
  'SHLVL',
  'PWD',
])

export function isSecret(key: string): boolean {
  return SECRET_RE.test(key)
}

export type EnvSnapshot = {
  vars: EnvVar[]
  /** When the snapshot was taken; the UI shows this so nobody reads a stale env as current. */
  takenAt: string | null
  available: boolean
}

/**
 * @param declared keys the registry declares for this app, used only to label
 *        origin — the VALUES always come from the container.
 */
export async function readEnvSnapshot(
  app: string,
  declared: Map<string, string | null>,
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

    const origin: EnvOrigin =
      declared.has(key) ? 'registry'
      : IMAGE_KEYS.has(key) ? 'image'
      : 'platform'

    return {
      key,
      value,
      secret: isSecret(key),
      origin,
      note: declared.get(key) ?? null,
    }
  })

  vars.sort((a, b) => a.key.localeCompare(b.key))
  return { vars, takenAt, available: true }
}
