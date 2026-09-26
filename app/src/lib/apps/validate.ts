import type { ManifestTask } from '../../host/nix-manifest'
import type { apps } from '../../host/schema'
import { APP_STAGES, isAppStage, stageExposed } from '../stage'
import { taskCommandError, taskIdError, taskScheduleError, taskTimeoutError } from '../tasks'
import { type EnvVar, validateEnvVars } from './env-vars'

// The runtime half of the registry's write boundary: a request body into a
// NewApp or an AppPatch, and the rules an edit must satisfy before it may
// reach the database.
//
// Pure — no database, no disk, no environment — so every rule here is
// testable without a fake. The checks that need the machine (a hostname
// already published, a variable that is also a secret) stay in
// lib/repo/apps.ts beside the write they guard. It lives under lib/apps/, a
// server region, beside env-vars.ts and secret-keys.ts which are pure in the
// same way; nothing here reaches the host, only its types.

/**
 * What a new app is born with.
 *
 * Everything absent from this shape is a platform default, and every default
 * is the conservative one: no ingress beyond the LAN, no auth, no database, no
 * scrape, no caps. Those are all editable afterwards from the app's own page —
 * the create form asks only for what cannot be sensibly defaulted, plus the
 * toggles somebody adding an app already knows the answer to.
 *
 * `authMode` and `egress` are not here: a new app arrives ungated and gets its
 * gate in a second, deliberate step, and egress needs a gluetun instance to
 * exist before anything can join its netns. Operator secrets are not a field at
 * all any more — a tracked `stacks/apps/<name>-env.sops` is the whole switch.
 *
 * `stage` is not here either, and that one is not a default but a fact: a new
 * app is born `declared` (see createApp). There is nothing to choose yet.
 */
export type NewApp = {
  name: string
  description: string
  postgres: boolean
  storage: boolean
  litellm: boolean
  prometheus: boolean
  /** null = <registry host>/<name>:latest, the platform default. */
  image: string | null
  /** null = <name>.<base domain>. */
  hostname: string | null
}

/** Runtime validation of a create request — same rationale as validateAppPatch. */
export function validateNewApp(input: Record<string, unknown>): NewApp {
  const str = (k: 'name' | 'description'): string => {
    const v = input[k]
    if (typeof v !== 'string') throw new Error(`${k} must be a string`)
    return v
  }
  const bool = (k: 'postgres' | 'storage' | 'litellm' | 'prometheus'): boolean => {
    const v = input[k]
    if (typeof v !== 'boolean') throw new Error(`${k} must be a boolean`)
    return v
  }
  const strOrNull = (k: 'image' | 'hostname'): string | null => {
    const v = input[k] ?? null
    if (v !== null && typeof v !== 'string') throw new Error(`${k} must be a string or null`)
    return v
  }
  // Refused rather than ignored. A caller that asks for `live` here has the
  // old model in mind — create it exposed, then apply — and that model is what
  // deadlocked: the image does not exist yet, so the Apply would fail the
  // switch and revert the very row it was shipping. Saying so beats silently
  // creating something other than what was asked for.
  if (input.stage !== undefined && input.stage !== 'declared') {
    throw new Error(
      'stage cannot be chosen at create: a new app is declared — the row, its database and its ' +
        'secrets, and nothing running. Promote it once its first build has published an image.',
    )
  }
  return {
    name: str('name'),
    description: str('description'),
    postgres: bool('postgres'),
    storage: bool('storage'),
    litellm: bool('litellm'),
    prometheus: bool('prometheus'),
    image: strOrNull('image'),
    hostname: strOrNull('hostname'),
  }
}

/**
 * Fields daedalus may change today.
 *
 * Every one of them is a pure data change the existing Nix modules already know
 * how to act on, with no state anybody has to author first. `authMode` included:
 * its Pocket ID client secret is generated on the box the first time the client
 * is declared (see stacks/pocket-id/clients.nix), the same way an app's database
 * password and AUTH_SECRET are.
 *
 * The omissions are deliberate, not unfinished. `egress` needs a gluetun
 * instance to exist first. `sourceMode` and `name` rewrite paths across the
 * whole platform. `operatorSecrets` is gone entirely rather than omitted — the
 * presence of a tracked `stacks/apps/<name>-env.sops` is the setting, and the
 * page reports it from the Nix manifest.
 */
export const EDITABLE_FIELDS = [
  'stage',
  'image',
  'hostname',
  'description',
  'postgres',
  'storage',
  'litellm',
  'prometheus',
  'deployEnable',
  'authMode',
  'authHealthPath',
  'limitCpus',
  'limitMemoryMb',
  'limitPids',
] as const

export type EditableField = (typeof EDITABLE_FIELDS)[number]

/**
 * An edit to one app.
 *
 * `tasks` is deliberately not one of EDITABLE_FIELDS and cannot be: those are
 * columns on `apps`, set by one UPDATE, while the tasks are rows in a child
 * table this patch replaces wholesale. It rides the same patch anyway so the
 * Tasks tab needs no server function of its own — `saveApp` already carries
 * the `assertAdmin()` gate and this validator.
 */
export type AppPatch = Partial<Pick<typeof apps.$inferInsert, EditableField>> & {
  /** The whole list, in authored order. Absent = leave the task rows alone. */
  tasks?: ManifestTask[]
  /** The whole list, in authored order. Absent = leave the variable rows alone. */
  env?: EnvVar[]
}

/** The column half of an AppPatch: what becomes the `SET` of an UPDATE on `apps`. */
export type AppColumns = Omit<AppPatch, 'tasks' | 'env'>

/**
 * The `tasks` of a patch, or an error naming the task and the rule it broke.
 *
 * Every rule here mirrors an assertion in stacks/apps/apps.nix, and that is
 * the point rather than duplication for its own sake: the nix assertion fires
 * INSIDE the rebuild an Apply has already committed, so reaching it costs a
 * revert. Catching it here is the cheap path to the same answer — the same
 * reasoning the hostname collision check in `updateApp` already uses.
 *
 * The sentences come from lib/tasks.ts, which is also what the editor shows as
 * you type: one definition, so a form and its boundary cannot come to disagree
 * about what is allowed.
 */
function validateTasks(v: unknown): ManifestTask[] {
  if (!Array.isArray(v)) throw new Error('tasks must be an array of scheduled tasks')

  const seen: string[] = []
  return v.map((raw, i): ManifestTask => {
    const where = `tasks[${String(i)}]`
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`${where} must be an object with id, schedule, command and timeoutSec`)
    }
    const t = raw as Record<string, unknown>

    if (typeof t.id !== 'string') throw new Error(`${where}.id must be a string`)
    const id = t.id.trim().toLowerCase()
    // `seen` as the taken list, so a repeated id is refused by the same
    // function the form uses: two tasks sharing one id would define ONE unit
    // twice, and the module system would merge them into whichever ExecStart
    // won — one task in daedalus, another on the box.
    const idErr = taskIdError(id, seen)
    if (idErr) throw new Error(`task id “${t.id}” ${idErr}`)
    seen.push(id)

    if (typeof t.schedule !== 'string') throw new Error(`task “${id}”: schedule must be a string`)
    const schedule = t.schedule.trim()
    const scheduleErr = taskScheduleError(schedule)
    if (scheduleErr) throw new Error(`task “${id}”: schedule ${scheduleErr}`)

    if (!Array.isArray(t.command) || t.command.some((a) => typeof a !== 'string')) {
      throw new Error(`task “${id}”: command must be an array of strings — argv, not a shell line`)
    }
    const command = t.command as string[]
    const commandErr = taskCommandError(command)
    if (commandErr) throw new Error(`task “${id}”: command ${commandErr}`)

    if (typeof t.timeoutSec !== 'number') {
      throw new Error(`task “${id}”: timeoutSec must be a number of seconds`)
    }
    const timeoutErr = taskTimeoutError(t.timeoutSec)
    if (timeoutErr) throw new Error(`task “${id}”: timeoutSec ${timeoutErr}`)

    return { id, schedule, command: [...command], timeoutSec: t.timeoutSec }
  })
}

/**
 * A request body into an AppPatch, or an error naming what was wrong.
 *
 * This is the runtime half of the server-function boundary: the TypeScript
 * types on createServerFn describe the request, they do not check it, so a
 * hand-made POST could put any JSON value in any field. updateApp whitelists
 * the keys; this validates the values before they reach the UPDATE.
 */
export function validateAppPatch(patch: Record<string, unknown>): AppPatch {
  const clean: AppPatch = {}
  const bad = (k: string, want: string): never => {
    throw new Error(`${k} must be ${want}`)
  }

  for (const [k, v] of Object.entries(patch)) {
    switch (k as EditableField | 'tasks' | 'env') {
      case 'tasks':
        clean.tasks = validateTasks(v)
        break
      // Shape and names here; the collision with the app's SECRETS is in
      // `updateApp`, where a disk read is allowed.
      case 'env':
        clean.env = validateEnvVars(v)
        break
      case 'stage':
        if (!isAppStage(v)) bad(k, APP_STAGES.join(' | '))
        clean.stage = v as AppPatch['stage']
        break
      case 'authMode':
        if (v !== 'none' && v !== 'proxy' && v !== 'native') bad(k, 'none | proxy | native')
        clean.authMode = v as AppPatch['authMode']
        break
      case 'image':
      case 'hostname':
      case 'description':
      case 'authHealthPath':
        if (v !== null && typeof v !== 'string') bad(k, 'a string or null')
        clean[k as 'image'] = v as string | null
        break
      case 'postgres':
      case 'storage':
      case 'litellm':
      case 'prometheus':
      case 'deployEnable':
        if (typeof v !== 'boolean') bad(k, 'a boolean')
        clean[k as 'postgres'] = v as boolean
        break
      case 'limitCpus':
        if (v !== null && (typeof v !== 'number' || !Number.isFinite(v) || v <= 0)) {
          bad(k, 'a positive number or null')
        }
        clean.limitCpus = v as number | null
        break
      case 'limitMemoryMb':
      case 'limitPids':
        if (v !== null && (typeof v !== 'number' || !Number.isInteger(v) || v <= 0)) {
          bad(k, 'a positive integer or null')
        }
        clean[k as 'limitMemoryMb'] = v as number | null
        break
      default:
        throw new Error(`${k} is not an editable field`)
    }
  }
  return clean
}

/** A health path as stored: trimmed, `''` meaning none, and rooted at `/`. */
export function normalizeAuthHealthPath(path: string): string | null {
  const p = path.trim()
  if (p !== '' && !p.startsWith('/')) throw new Error('health path must start with /')
  return p || null
}

/**
 * The same two rules stacks/apps/apps.nix asserts, checked before the write
 * rather than during the rebuild an Apply has already committed.
 *
 * `proxy` gates the router with the generated forward-auth middleware, and
 * the health path is what that middleware is told to let through — without
 * one, gatus and the deploy check would both be answered by a 302 to the IdP
 * and would certify the gate instead of the app. `proxy` also needs an
 * ingress at all, which `stage = "off"` does not emit.
 *
 * Judged on the app as it would be AFTER the edit: each value comes from the
 * patch when the patch carries it, from the stored record otherwise.
 */
export function assertAuthRules(
  clean: AppColumns,
  record: Pick<typeof apps.$inferSelect, 'authMode' | 'authHealthPath' | 'stage'>,
): void {
  const mode = clean.authMode ?? record.authMode
  const health = 'authHealthPath' in clean ? clean.authHealthPath : record.authHealthPath
  const stage = clean.stage ?? record.stage
  if (mode === 'proxy' && !health) {
    throw new Error(
      'forward-auth (proxy) needs a health path — an unauthenticated path the app itself serves, so the probe and the deploy check test the app rather than the login redirect',
    )
  }
  if (mode === 'proxy' && !stageExposed(stage)) {
    throw new Error(
      stage === 'declared'
        ? 'forward-auth (proxy) needs an ingress to gate, and a declared app has none — promote it first'
        : 'forward-auth (proxy) needs an ingress to gate; this app is not exposed',
    )
  }
}
