import { IMAGE_KEYS, PLATFORM_KEYS } from '../env-groups'
import { secretKeyError } from './secret-keys'

// An app's plain variables: the half of its environment that is NOT a secret,
// and can therefore be read, edited and diffed in the open.
//
// Pure and browser-safe (the Variables tab imports values from it), and the
// one definition of what a variable may be named — the form shows these
// sentences as you type, `validateAppPatch` throws them at the boundary, and
// neither may invent its own rule. Same shape as lib/tasks.ts is for tasks.
//
// WHERE A VARIABLE GOES. A row in `app_env_vars`, exported into
// site/apps.json's `env` array by an Apply, read back by
// nix/platform/lib/registry-lib.nix into `fleet.apps.<name>.env`, merged into
// the container's `environment`. In the clear the whole way — in git, in the
// nix store, in `podman inspect`. That is the difference from a secret, and
// it is why `envKeyError` refuses a name that already exists as one: the same
// name in both places would put the secret's value in the clear beside it.

/** Long enough for a URL or a comma-joined list, short enough to be a bound. */
export const ENV_VALUE_MAX = 4096

/** A note is a sentence or two about WHY, not documentation. */
export const ENV_NOTE_MAX = 500

/**
 * The convention, on top of the security rule.
 *
 * `secretKeyError` decides what is SAFE (it is the same POSIX name rule the
 * sops agent enforces, and the reason a name cannot carry a quote or a
 * newline). This adds only what is CUSTOMARY: an environment variable is
 * upper case. Kept separate so the two never drift into one regex where a
 * loosened convention would quietly loosen the control.
 */
const CONVENTION_RE = /^[A-Z][A-Z0-9_]*$/

export type EnvVar = { key: string; value: string; note: string | null }

/**
 * Why `key` cannot be a variable of this app, or null.
 *
 * `taken` is the other variables' names — the caller passes the list without
 * the row being edited, so renaming a variable to its own name is not a
 * collision. `secretKeys` is the app's sops file's key names.
 */
export function envKeyError(
  key: unknown,
  taken: readonly string[],
  secretKeys: readonly string[],
): string | null {
  const unsafe = secretKeyError(key)
  if (unsafe !== null) return unsafe
  const k = key as string
  if (!CONVENTION_RE.test(k)) {
    return 'a variable name is upper case: a letter, then letters, digits and underscores'
  }
  if (taken.includes(k)) return `${k} is already a variable of this app`
  if (secretKeys.includes(k)) {
    return `${k} is a secret of this app — remove it there first, or it would sit in the clear beside its encrypted value`
  }
  // The platform sets these itself, per app, from the app's own flags. A
  // variable of the same name is merged into the same attrset, so which one
  // the container sees is a question about merge order rather than about
  // configuration — and the answer must never be "whichever was typed".
  if (k in PLATFORM_KEYS) {
    return `${k} is set by the platform (${PLATFORM_KEYS[k] ?? 'platform'}) — it cannot be overridden here`
  }
  if (IMAGE_KEYS.has(k)) return `${k} comes from the image or podman, not from configuration`
  return null
}

/** Why `value` cannot be a variable's value, or null. */
export function envValueError(value: unknown): string | null {
  if (typeof value !== 'string') return 'a value must be text'
  if (value.length > ENV_VALUE_MAX) {
    return `a value may be at most ${String(ENV_VALUE_MAX)} characters`
  }
  // A newline would end the line in every dotenv-shaped rendering of this
  // list, so the rest of the value would read as another variable.
  if (/[\r\n]/.test(value)) return 'a value is one line'
  return null
}

/** Why `note` cannot be a variable's note, or null. `null` and `''` are "no note". */
export function envNoteError(note: unknown): string | null {
  if (note === null || note === '') return null
  if (typeof note !== 'string') return 'a note must be text'
  if (note.length > ENV_NOTE_MAX) return `a note may be at most ${String(ENV_NOTE_MAX)} characters`
  return null
}

/**
 * The whole list, checked as a list — the shape `validateAppPatch` needs.
 * Throws the first sentence that applies, naming the variable.
 *
 * The secret-collision half is NOT here: it needs the app's sops file, which
 * is a disk read, and this module is browser-safe on purpose. `updateApp`
 * does that check the same way it does the hostname collision.
 */
export function validateEnvVars(v: unknown): EnvVar[] {
  if (!Array.isArray(v)) throw new Error('env must be an array of variables')
  const seen: string[] = []
  return v.map((raw, i): EnvVar => {
    const where = `env[${String(i)}]`
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`${where} must be an object with key, value and note`)
    }
    const e = raw as Record<string, unknown>
    const keyErr = envKeyError(e.key, seen, [])
    if (keyErr !== null) throw new Error(`${where}: ${keyErr}`)
    const key = e.key as string
    seen.push(key)

    const valueErr = envValueError(e.value)
    if (valueErr !== null) throw new Error(`${key}: ${valueErr}`)

    const note = e.note ?? null
    const noteErr = envNoteError(note)
    if (noteErr !== null) throw new Error(`${key}: ${noteErr}`)

    return {
      key,
      value: e.value as string,
      note: note === null || note === '' ? null : (note as string).trim(),
    }
  })
}
