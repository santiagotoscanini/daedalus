import {
  BUILD_ENV_ENTRIES_MAX,
  BUILD_ENV_RAILPACK_RE,
  BUILD_ENV_VALUE_MAX,
  BUILD_PUBLISH_MODES,
  BUILD_STRATEGIES,
  type BuildPublish,
  type BuildStrategy,
  buildEnvNameRefusal,
  railpackValueRefusal,
} from './builds'
import { isAppName } from './hostname'

// Apps › <name> › Settings › Builds: what a request may change. Engine-only
// columns (host/schema.ts): nix never reads them, so a save here ships nothing
// and lights no Apply bar. Client-safe, so the editors show the same verdicts
// the server enforces. The name and value rules themselves are lib/builds.ts's,
// shared with the request decoder, so a setting that saves is one the host
// takes.

const RAILPACK_KEY_SAYS =
  'RAILPACK_ followed by capital letters, digits and underscores, 64 at most'
export const ENV_ENTRIES_MAX = BUILD_ENV_ENTRIES_MAX
// A value reaches the build as one env line; a newline in it would be a second.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
const CONTROL = /[\x00-\x1f\x7f]/

export type BuildSettingsPatch = {
  buildOnBox?: boolean
  buildStrategy?: BuildStrategy
  buildPublish?: BuildPublish
  railpackEnv?: Record<string, string>
}

/**
 * Why this app may not turn on Build on this box, or null. The builder
 * namespaces cache mounts as `<app>-…`, so a `-` in the name could reach
 * another app's caches, and the host's build.sh refuses the build.
 */
export function boxBuildRefusal(app: string): string | null {
  return app.includes('-')
    ? `${app} cannot build on this box: the builder names each app's caches <app>-…, so an app name containing '-' could share another app's. Rename the app to build it here.`
    : null
}

/** Why one Railpack switch would be refused, or null. */
export function envEntryError(key: string, value: string): string | null {
  if (key === '') return 'Every entry needs a name.'
  if (!BUILD_ENV_RAILPACK_RE.test(key)) return `${key} is not a valid name: ${RAILPACK_KEY_SAYS}.`
  const refused = buildEnvNameRefusal(key)
  if (refused !== null) return `${key} is ${refused}.`
  if (value.length > BUILD_ENV_VALUE_MAX) {
    return `${key} is longer than ${String(BUILD_ENV_VALUE_MAX)} characters.`
  }
  if (CONTROL.test(value)) return `${key} holds a line break or control character.`
  const shape = railpackValueRefusal(key, value)
  if (shape !== null) return `${key} must be ${shape}.`
  return null
}

/** Why the whole map would be refused, or null. Entries are checked in order. */
export function envMapError(entries: [string, string][]): string | null {
  if (entries.length > ENV_ENTRIES_MAX) {
    return `At most ${String(ENV_ENTRIES_MAX)} entries.`
  }
  const seen = new Set<string>()
  for (const [k, v] of entries) {
    const e = envEntryError(k, v)
    if (e !== null) return e
    if (seen.has(k)) return `${k} is listed twice.`
    seen.add(k)
  }
  return null
}

function envMap(field: string, v: unknown): Record<string, string> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    throw new Error(`${field} must be an object of names to values`)
  }
  const strings: [string, string][] = []
  for (const [k, value] of Object.entries(v as Record<string, unknown>)) {
    if (typeof value !== 'string') throw new Error(`${field}.${k} must be a string`)
    strings.push([k, value])
  }
  const err = envMapError(strings)
  if (err !== null) throw new Error(`${field}: ${err}`)
  return Object.fromEntries(strings)
}

/**
 * A request body into an app name and a patch, or an error naming what was
 * wrong. Unknown keys are refused rather than dropped: a typo that saves
 * nothing would look like a save.
 */
export function validateBuildSettings(input: unknown): { app: string; patch: BuildSettingsPatch } {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('expected build settings')
  }
  const { app, ...rest } = input as Record<string, unknown>
  if (!isAppName(app)) throw new Error('expected an app name')

  const patch: BuildSettingsPatch = {}
  for (const [k, v] of Object.entries(rest)) {
    switch (k) {
      case 'buildOnBox':
        if (typeof v !== 'boolean') throw new Error('buildOnBox must be true or false')
        patch.buildOnBox = v
        break
      case 'buildStrategy':
        if (!BUILD_STRATEGIES.includes(v as BuildStrategy)) {
          throw new Error(`buildStrategy must be ${BUILD_STRATEGIES.join(' | ')}`)
        }
        patch.buildStrategy = v as BuildStrategy
        break
      case 'buildPublish':
        if (!BUILD_PUBLISH_MODES.includes(v as BuildPublish)) {
          throw new Error(`buildPublish must be ${BUILD_PUBLISH_MODES.join(' | ')}`)
        }
        patch.buildPublish = v as BuildPublish
        break
      case 'railpackEnv':
        patch.railpackEnv = envMap(k, v)
        break
      default:
        throw new Error(`${k} is not a build setting`)
    }
  }
  if (Object.keys(patch).length === 0) throw new Error('nothing to change')
  if (patch.buildOnBox === true) {
    const refused = boxBuildRefusal(app)
    if (refused !== null) throw new Error(refused)
  }
  return { app, patch }
}
