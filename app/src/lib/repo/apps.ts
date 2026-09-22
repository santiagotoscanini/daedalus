import { asc, eq } from 'drizzle-orm'
import { db } from '../../host/db'
import {
  type AppStage,
  type ManifestApp,
  type ManifestEntry,
  type ManifestTask,
  manifestEntries,
} from '../../host/nix-manifest'
import { appEnvVars, apps, appTasks } from '../../host/schema'
import { readSite } from '../../host/site'
import { REGISTRY_SCHEMA_VERSION } from '../contract/version'
import { appNameError, effectiveHostname, hostnameError } from '../hostname'
import { APP_STAGES, isAppStage, stageExposed } from '../stage'
import { taskCommandError, taskIdError, taskScheduleError, taskTimeoutError } from '../tasks'

// Reads and writes over the app registry, plus the drift comparison against
// what Nix actually built.

export type AppRecord = typeof apps.$inferSelect & {
  envVars: (typeof appEnvVars.$inferSelect)[]
  tasks: (typeof appTasks.$inferSelect)[]
}

/**
 * Both ordered children, by their authored position. Spelled once, because
 * every read of an app needs both and a query that forgot one would hand back
 * a record whose type says the list is there.
 *
 * Not `as const`: drizzle's query config wants a mutable `orderBy` array.
 */
const WITH_CHILDREN = {
  envVars: { orderBy: [asc(appEnvVars.position)] },
  tasks: { orderBy: [asc(appTasks.position)] },
}

export async function listApps(): Promise<AppRecord[]> {
  return db.query.apps.findMany({
    with: WITH_CHILDREN,
    orderBy: [asc(apps.name)],
  })
}

export async function getApp(name: string): Promise<AppRecord | undefined> {
  return db.query.apps.findFirst({
    where: eq(apps.name, name),
    with: WITH_CHILDREN,
  })
}

/**
 * Load the registry from what Nix currently has. Idempotent — this is both the
 * one-time seed and the "re-sync from Nix" direction of the Apply flow, so it
 * upserts rather than inserting.
 *
 * Env vars are replaced wholesale rather than diffed: they are a small ordered
 * list owned entirely by the manifest, and a partial merge would silently keep
 * a var somebody deleted in Nix.
 */
export async function importFromNix(): Promise<{ imported: string[] }> {
  const entries = await manifestEntries()
  const imported: string[] = []

  // One transaction for the whole sync: the per-app shape is delete-then-insert
  // on env vars, and a failure between the two would leave an app stripped of
  // its vars — a partial re-sync the next Apply would then ship.
  await db.transaction(async (tx) => {
    for (const entry of entries) {
      const row = toRow(entry)

      const [saved] = await tx
        .insert(apps)
        .values(row)
        .onConflictDoUpdate({ target: apps.name, set: { ...row, updatedAt: new Date() } })
        .returning({ id: apps.id })

      if (!saved) continue

      await tx.delete(appEnvVars).where(eq(appEnvVars.appId, saved.id))
      if (entry.env.length > 0) {
        await tx.insert(appEnvVars).values(
          entry.env.map((e, i) => ({
            appId: saved.id,
            key: e.key,
            value: e.value,
            note: e.note ?? null,
            position: i,
          })),
        )
      }

      // Tasks the same way, and for the same reason: a small ordered list the
      // manifest owns outright, where a partial merge would silently keep a
      // task somebody deleted in the file — and a kept task is a timer that
      // keeps firing.
      await tx.delete(appTasks).where(eq(appTasks.appId, saved.id))
      const tasks = entry.tasks ?? []
      if (tasks.length > 0) {
        await tx.insert(appTasks).values(
          tasks.map((t, i) => ({
            appId: saved.id,
            taskId: t.id,
            schedule: t.schedule,
            command: t.command,
            timeoutSec: t.timeoutSec,
            position: i,
          })),
        )
      }

      imported.push(entry.name)
    }
  })

  return { imported }
}

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
 * Create a registry entry. The row only — no repo, no image, no rebuild.
 *
 * Always at `declared`, the bottom rung: the row, its postgres role and
 * database, its data dir and its AUTH_SECRET, and nothing running. That is not
 * a conservative default, it is the only value that can be applied — an entry
 * whose image does not exist yet declares a container that cannot pull, which
 * fails the switch, which makes the Apply revert itself. And being in
 * site/apps.json is exactly what earns the app its first build, so `declared`
 * is the rung that ends the deadlock rather than one that waits it out.
 *
 * Exposure is chosen on the app's own page after that first build, where it is
 * one click and cannot fail.
 *
 * What is enforced HERE is only what would corrupt the registry itself — a
 * duplicate name, a name Nix already owns, a colliding hostname.
 */
export async function createApp(input: NewApp): Promise<{ name: string }> {
  const name = input.name.trim().toLowerCase()

  const { manifestEntries, hostnamesTakenBy } = await import('../../host/nix-manifest')
  const existing = await listApps()
  const taken = [
    ...existing.map((a) => a.name),
    // Hand-written entries (daedalus itself) are not rows here but absolutely
    // are names on the box — creating a second `daedalus` would collide on the
    // container name and the hostname, and Nix would find out mid-Apply.
    ...(await manifestEntries()).map((m) => m.name),
  ]

  const nameErr = appNameError(name, taken)
  if (nameErr) throw new Error(`name ${nameErr}`)

  const hostname = input.hostname?.trim().toLowerCase() || null
  const site = readSite()
  const hostErr = hostnameError(
    site,
    hostname ?? effectiveHostname(site, name, null),
    await hostnamesTakenBy(''),
  )
  if (hostErr) throw new Error(`hostname ${hostErr}`)

  await db.insert(apps).values({
    name,
    stage: 'declared',
    managedInNix: false,
    sourceMode: 'registry',
    image: input.image?.trim() || null,
    hostname,
    postgres: input.postgres,
    storage: input.storage,
    litellm: input.litellm,
    prometheus: input.prometheus,
    authMode: 'none',
    description: input.description.trim(),
    notes: {},
  })

  return { name }
}

/**
 * Drop a registry entry.
 *
 * Deliberately narrow: this removes the DECLARATION, and the next Apply
 * removes the container, the route, the DNS record, the probe and the
 * Cloudflare CNAME (route-sync prunes what is no longer declared); pushes to
 * its repo stop building, because nothing declares the app any more.
 * It does NOT reclaim state, and nothing here pretends otherwise — the
 * postgres role and database, <stateRoot>/apps/<name>/data, the
 * per-app secrets dir and any <name>-env.sops all survive, because deleting
 * data is not something a UI button should do on the strength of one click.
 * The caller shows that list before confirming.
 */
export async function deleteApp(name: string): Promise<void> {
  const record = await getApp(name)
  if (!record) throw new Error(`no app named ${name}`)
  if (record.managedInNix) {
    throw new Error(`${name} is declared by hand in Nix — remove it there, not here`)
  }
  // Env vars and deployment history are `onDelete: cascade`.
  await db.delete(apps).where(eq(apps.id, record.id))
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
}

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
    switch (k as EditableField | 'tasks') {
      case 'tasks':
        clean.tasks = validateTasks(v)
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

export async function updateApp(name: string, patch: AppPatch): Promise<void> {
  const record = await getApp(name)
  if (!record) throw new Error(`no app named ${name}`)
  if (record.managedInNix) {
    throw new Error(
      `${name} is declared by hand in Nix and is read-only here — edit stacks/daedalus/daedalus.nix`,
    )
  }

  // Whitelist rather than trust the caller's keys: this object is written
  // straight into an UPDATE, and the server function boundary is the only
  // thing between it and the request body.
  // Typed WITHOUT `tasks`: what this half becomes is the `SET` of an UPDATE on
  // `apps`, and `tasks` is not a column there.
  const clean: Omit<AppPatch, 'tasks'> = {}
  for (const k of EDITABLE_FIELDS) {
    if (k in patch) (clean as Record<string, unknown>)[k] = patch[k]
  }
  // The task rows are their own write, so they are pulled out of the column
  // set rather than left in it — `tasks` is not a column on `apps` and an
  // UPDATE carrying it would be a SQL error, not a no-op.
  const tasks = patch.tasks
  if (Object.keys(clean).length === 0 && tasks === undefined) return

  // Checked on the way in, not just in the form. The form is not a boundary,
  // and an invalid hostname does not fail here — it fails inside
  // `nixos-rebuild` during an Apply, after the commit, which costs a revert.
  if (typeof clean.hostname === 'string') {
    const { hostnamesTakenBy } = await import('../../host/nix-manifest')
    const site = readSite()
    const own = effectiveHostname(site, name, record.hostname)
    const err = hostnameError(site, clean.hostname, await hostnamesTakenBy(own))
    if (err) throw new Error(`hostname ${err}`)
    clean.hostname = clean.hostname.trim().toLowerCase() || null
  }

  if (typeof clean.authHealthPath === 'string') {
    const p = clean.authHealthPath.trim()
    if (p !== '' && !p.startsWith('/')) throw new Error('health path must start with /')
    clean.authHealthPath = p || null
  }

  // The same two rules stacks/apps/apps.nix asserts, checked before the write
  // rather than during the rebuild an Apply has already committed.
  //
  // `proxy` gates the router with the generated forward-auth middleware, and
  // the health path is what that middleware is told to let through — without
  // one, gatus and the deploy check would both be answered by a 302 to the IdP
  // and would certify the gate instead of the app. `proxy` also needs an
  // ingress at all, which `stage = "off"` does not emit.
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

  // One transaction, for the reason importFromNix states: the task write is a
  // delete-then-insert, and a failure between the two would leave the app
  // stripped of every task it had — which the next Apply would ship, deleting
  // the timers. The column UPDATE joins it so an edit that moves both lands
  // whole or not at all.
  await db.transaction(async (tx) => {
    // Still an UPDATE when only the tasks moved: `updatedAt` is when this
    // RECORD last changed, and the tasks are part of the record.
    await tx
      .update(apps)
      .set({ ...clean, updatedAt: new Date() })
      .where(eq(apps.name, name))

    if (tasks === undefined) return
    await tx.delete(appTasks).where(eq(appTasks.appId, record.id))
    if (tasks.length > 0) {
      // `position` is the authored order, exactly as env vars carry theirs:
      // the export turns this list into JSON that nix reads into an attrset,
      // which has no order at all, so the index written here is the only
      // thing that survives an export → import round trip.
      await tx.insert(appTasks).values(
        tasks.map((t, i) => ({
          appId: record.id,
          taskId: t.id,
          schedule: t.schedule,
          command: t.command,
          timeoutSec: t.timeoutSec,
          position: i,
        })),
      )
    }
  })
}

/**
 * The platform default for `deploy.enable`, mirrored from the option default
 * in stacks/apps/apps.nix: registry apps auto-deploy, local-source ones have
 * no registry image to poll. Applied where a manifest entry omits `deploy`
 * (hand-written entries like daedalus's self.json).
 */
const deployDefault = (sourceMode: string | undefined): boolean =>
  (sourceMode ?? 'registry') === 'registry'

export function toRow(entry: ManifestEntry) {
  return {
    name: entry.name,
    stage: entry.stage,
    managedInNix: entry.managedInNix,
    sourceMode: entry.sourceMode ?? 'registry',
    deployEnable: entry.deploy?.enable ?? deployDefault(entry.sourceMode),
    image: entry.image,
    hostname: entry.hostname ?? null,
    postgres: entry.postgres,
    storage: entry.storage,
    litellm: entry.litellm,
    prometheus: entry.prometheus,
    authMode: entry.auth.mode,
    authHealthPath: entry.auth.healthPath ?? null,
    authIsolated: entry.auth.isolated ?? false,
    authAllowedGroups: entry.auth.allowedGroups ?? null,
    authBypassRule: entry.auth.bypassRule ?? null,
    egressContainer: entry.egress?.container ?? null,
    egressHostPort: entry.egress?.hostPort ?? null,
    limitCpus: entry.resources?.cpus ?? null,
    limitMemoryMb: entry.resources?.memoryMb ?? null,
    limitPids: entry.resources?.pids ?? null,
    description: entry.presentation.description,
    notes: entry.notes ?? {},
  }
}

/**
 * jsonb neither preserves key order nor cares about it, so notes from the
 * database and notes from the JSON file can hold the same pairs in different
 * orders. Compared on sorted entries or a reordering reads as drift.
 */
const stableNotes = (notes: Record<string, string>): string =>
  JSON.stringify(Object.entries(notes).sort(([a], [b]) => a.localeCompare(b)))

/**
 * One env var as a comparable line. JSON-encoded rather than `k=v` glued with
 * separators: a value is free text, so any separator it could contain would
 * make two different (value, note) pairs collapse into the same string.
 */
const envLine = (e: { key: string; value: string; note?: string | null }): string =>
  JSON.stringify([e.key, e.value, e.note ?? null])

/**
 * One task as a comparable line, same rationale as `envLine` — and with one
 * extra: `command` is an array, so it is carried as one rather than joined.
 * Joining argv on a space would make `["echo", "a b"]` and `["echo","a","b"]`
 * compare equal, and those are two different commands.
 *
 * The database calls the contract's id `taskId` (`id` there is the row's
 * uuid), so the caller normalises before this sees it.
 */
const taskLine = (t: ManifestTask): string =>
  JSON.stringify([t.id, t.schedule, t.command, t.timeoutSec])

/** A task row as the contract shape, which is what both sides compare in. */
const taskOf = (t: typeof appTasks.$inferSelect): ManifestTask => ({
  id: t.taskId,
  schedule: t.schedule,
  command: t.command,
  timeoutSec: t.timeoutSec,
})

/**
 * Does the database still describe what Nix built?
 *
 * Compared field by field on the normalised shape, so ordering and formatting
 * differences don't register as changes. An app present in one and not the
 * other counts as drifted — that is a create or a delete waiting to be applied.
 *
 * The invariant that keeps the Apply bar honest: every field
 * `toRegistryExport` emits must be compared here. A field exported but not
 * compared is an edit that never lights the bar and silently never ships —
 * asserted by the field-coverage test in apps.test.ts.
 */
export function driftOf(record: AppRecord, manifest: ManifestEntry | undefined): string[] {
  if (!manifest) return ['not in the last Nix build']

  const fromDb = {
    stage: record.stage,
    sourceMode: record.sourceMode,
    deployEnable: record.deployEnable,
    image: record.image,
    hostname: record.hostname,
    postgres: record.postgres,
    storage: record.storage,
    litellm: record.litellm,
    prometheus: record.prometheus,
    authMode: record.authMode,
    authHealthPath: record.authHealthPath,
    authIsolated: record.authIsolated,
    authAllowedGroups: record.authAllowedGroups,
    authBypassRule: record.authBypassRule,
    egressContainer: record.egressContainer,
    egressHostPort: record.egressHostPort,
    limitCpus: record.limitCpus,
    limitMemoryMb: record.limitMemoryMb,
    limitPids: record.limitPids,
    description: record.description,
    notes: stableNotes(record.notes),
    env: record.envVars.map(envLine).join('\n'),
    tasks: record.tasks.map(taskOf).map(taskLine).join('\n'),
  }

  const fromNix = {
    stage: manifest.stage,
    sourceMode: manifest.sourceMode ?? 'registry',
    deployEnable: manifest.deploy?.enable ?? deployDefault(manifest.sourceMode),
    image: manifest.image,
    hostname: manifest.hostname ?? null,
    postgres: manifest.postgres,
    storage: manifest.storage,
    litellm: manifest.litellm,
    prometheus: manifest.prometheus,
    authMode: manifest.auth.mode,
    authHealthPath: manifest.auth.healthPath ?? null,
    authIsolated: manifest.auth.isolated ?? false,
    authAllowedGroups: manifest.auth.allowedGroups ?? null,
    authBypassRule: manifest.auth.bypassRule ?? null,
    egressContainer: manifest.egress?.container ?? null,
    egressHostPort: manifest.egress?.hostPort ?? null,
    limitCpus: manifest.resources?.cpus ?? null,
    limitMemoryMb: manifest.resources?.memoryMb ?? null,
    limitPids: manifest.resources?.pids ?? null,
    description: manifest.presentation.description,
    notes: stableNotes(manifest.notes ?? {}),
    env: manifest.env.map(envLine).join('\n'),
    tasks: (manifest.tasks ?? []).map(taskLine).join('\n'),
  }

  return (Object.keys(fromNix) as (keyof typeof fromNix)[]).filter(
    (k) => JSON.stringify(fromDb[k]) !== JSON.stringify(fromNix[k]),
  )
}

/**
 * Rebuild the export that stacks/apps/declarations.nix reads. Not written to
 * disk here — the Apply flow (next iteration) owns that, along with the git
 * commit and the rebuild. Having it now keeps the round-trip honest: the UI
 * can show exactly what Apply WOULD write.
 */
export function toRegistryExport(records: AppRecord[]): {
  schemaVersion: number
  apps: Record<string, ManifestApp>
} {
  const editable = records.filter((r) => !r.managedInNix)

  return {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    apps: Object.fromEntries(
      editable
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((r) => [
          r.name,
          {
            stage: r.stage as AppStage,
            postgres: r.postgres,
            storage: r.storage,
            litellm: r.litellm,
            prometheus: r.prometheus,
            // Always emitted (schema v2): every registry entry is explicit
            // about whether it auto-deploys, so a freeze is visible in the
            // committed file rather than inferred from a default.
            deploy: { enable: r.deployEnable },
            image: r.image,
            hostname: r.hostname,
            egress:
              r.egressContainer && r.egressHostPort !== null
                ? { container: r.egressContainer, hostPort: r.egressHostPort }
                : null,
            env: r.envVars.map((e) => ({ key: e.key, value: e.value, note: e.note })),
            // Always emitted, `[]` included, like `env` above: the file is
            // what a person reads to see what this app runs on a clock, and
            // an absent key reads as "this writer did not know about tasks"
            // where an explicit empty list reads as "none". declarations.nix
            // tolerates either (`a.tasks or [ ]`).
            tasks: r.tasks.map(taskOf),
            auth: {
              mode: r.authMode as 'none' | 'proxy' | 'native',
              ...(r.authHealthPath ? { healthPath: r.authHealthPath } : {}),
              ...(r.authIsolated ? { isolated: true } : {}),
              ...(r.authAllowedGroups ? { allowedGroups: r.authAllowedGroups } : {}),
              ...(r.authBypassRule ? { bypassRule: r.authBypassRule } : {}),
            },
            presentation: { description: r.description },
            // Always emitted in full, nulls included, rather than omitted when
            // uncapped: the exported file is what a human reads to see what a
            // container is allowed to use, and an absent key reads as "nobody
            // considered it" where an explicit null reads as "deliberately
            // uncapped". declarations.nix tolerates either.
            resources: {
              cpus: r.limitCpus,
              memoryMb: r.limitMemoryMb,
              pids: r.limitPids,
            },
            notes: r.notes,
          },
        ]),
    ),
  }
}
