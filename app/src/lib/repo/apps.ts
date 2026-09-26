import { asc, eq } from 'drizzle-orm'
import { db, type Tx } from '../../host/db'
import type { ManifestEnvVar, ManifestTask } from '../../host/nix-manifest'
import { appEnvVars, apps, appTasks } from '../../host/schema'
import { readSite } from '../../host/site'
import type { EnvVar } from '../apps/env-vars'
import {
  type AppColumns,
  type AppPatch,
  assertAuthRules,
  EDITABLE_FIELDS,
  type NewApp,
  normalizeAuthHealthPath,
} from '../apps/validate'
import { appNameError, effectiveHostname, hostnameError } from '../hostname'

// Reads and writes over the app registry.
//
// The pure halves live beside it and are re-exported from here, so every
// importer and every test mock keeps its one path: the request validation in
// lib/apps/validate.ts, and the manifest ↔ row ↔ export mapping plus the drift
// comparison against what Nix actually built in lib/apps/manifest-map.ts.

export { driftOf, toRegistryExport, toRow } from '../apps/manifest-map'
export {
  type AppPatch,
  EDITABLE_FIELDS,
  type EditableField,
  type NewApp,
  validateAppPatch,
  validateNewApp,
} from '../apps/validate'

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
 * Replace an app's env var rows with `env`, in authored order.
 *
 * Delete-then-insert rather than a diff: a small ordered list owned entirely
 * by whoever wrote it, where a partial merge would silently keep a var
 * somebody deleted. Always called inside a transaction, because a failure
 * between the two statements would leave the app stripped of every variable
 * it had — which the next Apply would ship.
 */
async function replaceEnvVars(tx: Tx, appId: string, env: ManifestEnvVar[]): Promise<void> {
  await tx.delete(appEnvVars).where(eq(appEnvVars.appId, appId))
  if (env.length > 0) {
    await tx.insert(appEnvVars).values(
      env.map((e, i) => ({
        appId,
        key: e.key,
        value: e.value,
        note: e.note ?? null,
        position: i,
      })),
    )
  }
}

/**
 * Replace an app's task rows with `tasks`, in authored order.
 *
 * Tasks the same way as env vars, and for the same reason: a small ordered
 * list owned outright, where a partial merge would silently keep a task
 * somebody deleted — and a kept task is a timer that keeps firing. Inside a
 * transaction for the same reason too: stripped of its tasks, the app's next
 * Apply would delete the timers.
 */
async function replaceTasks(tx: Tx, appId: string, tasks: ManifestTask[]): Promise<void> {
  await tx.delete(appTasks).where(eq(appTasks.appId, appId))
  if (tasks.length > 0) {
    // `position` is the authored order, exactly as env vars carry theirs:
    // the export turns this list into JSON that nix reads into an attrset,
    // which has no order at all, so the index written here is the only
    // thing that survives an export → import round trip.
    await tx.insert(appTasks).values(
      tasks.map((t, i) => ({
        appId,
        taskId: t.id,
        schedule: t.schedule,
        command: t.command,
        timeoutSec: t.timeoutSec,
        position: i,
      })),
    )
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

/** The app `updateApp` may edit: a registry row, not one declared by hand in Nix. */
async function editableApp(name: string): Promise<AppRecord> {
  const record = await getApp(name)
  if (!record) throw new Error(`no app named ${name}`)
  if (record.managedInNix) {
    throw new Error(
      `${name} is declared by hand in Nix and is read-only here — edit stacks/daedalus/daedalus.nix`,
    )
  }
  return record
}

/**
 * A patch into its three writes: the column set, the task list, the env list.
 *
 * Whitelist rather than trust the caller's keys: `clean` is written straight
 * into an UPDATE, and the server function boundary is the only thing between
 * it and the request body. Typed WITHOUT `tasks` or `env`: what this half
 * becomes is the `SET` of an UPDATE on `apps`, and neither is a column there.
 * The task and env rows are their own writes, so they are pulled out of the
 * column set rather than left in it — `tasks` is not a column on `apps` and an
 * UPDATE carrying it would be a SQL error, not a no-op.
 */
function splitPatch(patch: AppPatch): {
  clean: AppColumns
  tasks: ManifestTask[] | undefined
  env: EnvVar[] | undefined
} {
  const clean: AppColumns = {}
  for (const k of EDITABLE_FIELDS) {
    if (k in patch) (clean as Record<string, unknown>)[k] = patch[k]
  }
  return { clean, tasks: patch.tasks, env: patch.env }
}

const nothingToWrite = (
  clean: AppColumns,
  tasks: ManifestTask[] | undefined,
  env: EnvVar[] | undefined,
): boolean => Object.keys(clean).length === 0 && tasks === undefined && env === undefined

/**
 * The one rule a variable's name has that the pure validator cannot check:
 * the app's sops file is on disk. Same placement and the same reasoning as
 * the hostname collision in `normalizeHostname` — cheaper to refuse here than
 * inside the rebuild an Apply has already committed.
 */
async function refuseSecretClash(name: string, env: EnvVar[]): Promise<void> {
  const { loadAppSecrets } = await import('../apps/secrets')
  const secretKeys = (await loadAppSecrets(name)).map((s) => s.key)
  const clash = env.find((e) => secretKeys.includes(e.key))
  if (clash !== undefined) {
    throw new Error(
      `${clash.key} is a secret of this app — remove it there first, or it would sit in the clear beside its encrypted value`,
    )
  }
}

/**
 * A new hostname, checked and then stored lowercased, `''` meaning the default.
 *
 * Checked on the way in, not just in the form. The form is not a boundary,
 * and an invalid hostname does not fail here — it fails inside
 * `nixos-rebuild` during an Apply, after the commit, which costs a revert.
 */
async function normalizeHostname(
  name: string,
  record: AppRecord,
  hostname: string,
): Promise<string | null> {
  const { hostnamesTakenBy } = await import('../../host/nix-manifest')
  const site = readSite()
  const own = effectiveHostname(site, name, record.hostname)
  const err = hostnameError(site, hostname, await hostnamesTakenBy(own))
  if (err) throw new Error(`hostname ${err}`)
  return hostname.trim().toLowerCase() || null
}

export async function updateApp(name: string, patch: AppPatch): Promise<void> {
  const record = await editableApp(name)
  const { clean, tasks, env } = splitPatch(patch)
  if (nothingToWrite(clean, tasks, env)) return

  if (env !== undefined) await refuseSecretClash(name, env)
  if (typeof clean.hostname === 'string') {
    clean.hostname = await normalizeHostname(name, record, clean.hostname)
  }
  if (typeof clean.authHealthPath === 'string') {
    clean.authHealthPath = normalizeAuthHealthPath(clean.authHealthPath)
  }
  assertAuthRules(clean, record)

  // One transaction, for the reason replaceEnvVars states: the task write is a
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

    if (env !== undefined) await replaceEnvVars(tx, record.id, env)
    if (tasks !== undefined) await replaceTasks(tx, record.id, tasks)
  })
}
