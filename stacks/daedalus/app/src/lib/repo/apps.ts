import { asc, eq } from 'drizzle-orm'
import { db } from '../db'
import { BASE_DOMAIN, hostnameError } from '../hostname'
import { appEnvVars, apps } from '../schema'
import {
  manifestEntries,
  type AppStage,
  type ManifestApp,
  type ManifestEntry,
} from '../nix-manifest'

// Reads and writes over the app registry, plus the drift comparison against
// what Nix actually built.

export type AppRecord = typeof apps.$inferSelect & {
  envVars: (typeof appEnvVars.$inferSelect)[]
}

export async function listApps(): Promise<AppRecord[]> {
  return db.query.apps.findMany({
    with: { envVars: { orderBy: [asc(appEnvVars.position)] } },
    orderBy: [asc(apps.name)],
  })
}

export async function getApp(name: string): Promise<AppRecord | undefined> {
  return db.query.apps.findFirst({
    where: eq(apps.name, name),
    with: { envVars: { orderBy: [asc(appEnvVars.position)] } },
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

  for (const entry of entries) {
    const row = toRow(entry)

    const [saved] = await db
      .insert(apps)
      .values(row)
      .onConflictDoUpdate({ target: apps.name, set: { ...row, updatedAt: new Date() } })
      .returning({ id: apps.id })

    if (!saved) continue

    await db.delete(appEnvVars).where(eq(appEnvVars.appId, saved.id))
    if (entry.env.length > 0) {
      await db.insert(appEnvVars).values(
        entry.env.map((e, i) => ({
          appId: saved.id,
          key: e.key,
          value: e.value,
          note: e.note ?? null,
          position: i,
        })),
      )
    }

    imported.push(entry.name)
  }

  return { imported }
}

/**
 * Fields daedalus may change today.
 *
 * The omissions are deliberate, not unfinished. `auth.*` cannot move without
 * provisioning an SSO_SECRET_<NAME> into stacks/pocket-id/clients.sops —
 * writing encrypted state is its own design problem, and a half-applied auth
 * change locks you out of the app. `egress` needs a gluetun instance to exist
 * first. `operatorSecrets` needs a <name>-env.sops authored by hand.
 * `sourceMode` and `name` rewrite paths across the whole platform.
 *
 * Everything here, by contrast, is a pure data change that the existing
 * modules already know how to act on.
 */
export const EDITABLE_FIELDS = [
  'stage',
  'image',
  'hostname',
  'homepageDescription',
  'homepageIcon',
  'postgres',
  'storage',
  'litellm',
  'prometheus',
  'limitCpus',
  'limitMemoryMb',
  'limitPids',
] as const

export type EditableField = (typeof EDITABLE_FIELDS)[number]
export type AppPatch = Partial<Pick<typeof apps.$inferInsert, EditableField>>

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
  const clean: AppPatch = {}
  for (const k of EDITABLE_FIELDS) {
    if (k in patch) (clean as Record<string, unknown>)[k] = patch[k]
  }
  if (Object.keys(clean).length === 0) return

  // Checked on the way in, not just in the form. The form is not a boundary,
  // and an invalid hostname does not fail here — it fails inside
  // `nixos-rebuild` during an Apply, after the commit, which costs a revert.
  if (typeof clean.hostname === 'string') {
    const { hostnamesTakenBy } = await import('../nix-manifest')
    const own = record.hostname ?? `${name}.${BASE_DOMAIN}`
    const err = hostnameError(clean.hostname, await hostnamesTakenBy(own))
    if (err) throw new Error(`hostname ${err}`)
    clean.hostname = clean.hostname.trim().toLowerCase() || null
  }

  await db
    .update(apps)
    .set({ ...clean, updatedAt: new Date() })
    .where(eq(apps.name, name))
}

export async function setEnvVar(
  name: string,
  key: string,
  value: string,
  note: string | null,
): Promise<void> {
  const record = await getApp(name)
  if (!record) throw new Error(`no app named ${name}`)
  if (record.managedInNix) throw new Error(`${name} is read-only here`)

  const existing = record.envVars.find((e) => e.key === key)
  if (existing) {
    await db
      .update(appEnvVars)
      .set({ value, note })
      .where(eq(appEnvVars.id, existing.id))
  } else {
    await db.insert(appEnvVars).values({
      appId: record.id,
      key,
      value,
      note,
      position: record.envVars.length,
    })
  }
  await db.update(apps).set({ updatedAt: new Date() }).where(eq(apps.id, record.id))
}

export async function deleteEnvVar(name: string, key: string): Promise<void> {
  const record = await getApp(name)
  if (!record) throw new Error(`no app named ${name}`)
  if (record.managedInNix) throw new Error(`${name} is read-only here`)

  const existing = record.envVars.find((e) => e.key === key)
  if (!existing) return

  await db.delete(appEnvVars).where(eq(appEnvVars.id, existing.id))
  await db.update(apps).set({ updatedAt: new Date() }).where(eq(apps.id, record.id))
}

function toRow(entry: ManifestEntry) {
  return {
    name: entry.name,
    stage: entry.stage,
    managedInNix: entry.managedInNix,
    sourceMode: entry.sourceMode ?? 'registry',
    image: entry.image,
    hostname: entry.hostname ?? null,
    postgres: entry.postgres,
    storage: entry.storage,
    litellm: entry.litellm,
    prometheus: entry.prometheus,
    operatorSecrets: entry.operatorSecrets,
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
    homepageDescription: entry.homepage.description,
    homepageIcon: entry.homepage.icon,
    notes: entry.notes ?? {},
  }
}

/**
 * Does the database still describe what Nix built?
 *
 * Compared field by field on the normalised shape, so ordering and formatting
 * differences don't register as changes. An app present in one and not the
 * other counts as drifted — that is a create or a delete waiting to be applied.
 */
export function driftOf(record: AppRecord, manifest: ManifestEntry | undefined): string[] {
  if (!manifest) return ['not in the last Nix build']

  const fromDb = {
    stage: record.stage,
    sourceMode: record.sourceMode,
    image: record.image,
    hostname: record.hostname,
    postgres: record.postgres,
    storage: record.storage,
    litellm: record.litellm,
    prometheus: record.prometheus,
    operatorSecrets: record.operatorSecrets,
    authMode: record.authMode,
    authHealthPath: record.authHealthPath,
    authIsolated: record.authIsolated,
    egressContainer: record.egressContainer,
    egressHostPort: record.egressHostPort,
    limitCpus: record.limitCpus,
    limitMemoryMb: record.limitMemoryMb,
    limitPids: record.limitPids,
    homepageDescription: record.homepageDescription,
    homepageIcon: record.homepageIcon,
    env: record.envVars.map((e) => `${e.key}=${e.value}`).join('\n'),
  }

  const fromNix = {
    stage: manifest.stage,
    sourceMode: manifest.sourceMode ?? 'registry',
    image: manifest.image,
    hostname: manifest.hostname ?? null,
    postgres: manifest.postgres,
    storage: manifest.storage,
    litellm: manifest.litellm,
    prometheus: manifest.prometheus,
    operatorSecrets: manifest.operatorSecrets,
    authMode: manifest.auth.mode,
    authHealthPath: manifest.auth.healthPath ?? null,
    authIsolated: manifest.auth.isolated ?? false,
    egressContainer: manifest.egress?.container ?? null,
    egressHostPort: manifest.egress?.hostPort ?? null,
    limitCpus: manifest.resources?.cpus ?? null,
    limitMemoryMb: manifest.resources?.memoryMb ?? null,
    limitPids: manifest.resources?.pids ?? null,
    homepageDescription: manifest.homepage.description,
    homepageIcon: manifest.homepage.icon,
    env: manifest.env.map((e) => `${e.key}=${e.value}`).join('\n'),
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
    schemaVersion: 1,
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
            operatorSecrets: r.operatorSecrets,
            image: r.image,
            hostname: r.hostname,
            egress:
              r.egressContainer && r.egressHostPort !== null
                ? { container: r.egressContainer, hostPort: r.egressHostPort }
                : null,
            env: r.envVars.map((e) => ({ key: e.key, value: e.value, note: e.note })),
            auth: {
              mode: r.authMode as 'none' | 'proxy' | 'native',
              ...(r.authHealthPath ? { healthPath: r.authHealthPath } : {}),
              ...(r.authIsolated ? { isolated: true } : {}),
              ...(r.authAllowedGroups ? { allowedGroups: r.authAllowedGroups } : {}),
              ...(r.authBypassRule ? { bypassRule: r.authBypassRule } : {}),
            },
            homepage: { description: r.homepageDescription, icon: r.homepageIcon },
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
