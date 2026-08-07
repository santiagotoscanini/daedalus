import { asc, eq } from 'drizzle-orm'
import { db } from '../db'
import { appNameError, BASE_DOMAIN, effectiveHostname, hostnameError } from '../hostname'
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
 */
export type NewApp = {
  name: string
  description: string
  icon: string
  stage: 'off' | 'lab' | 'live'
  postgres: boolean
  storage: boolean
  litellm: boolean
  prometheus: boolean
  /** null = registry.toscanini.me/<name>:latest, the platform default. */
  image: string | null
  /** null = <name>.toscanini.me. */
  hostname: string | null
}

/**
 * Create a registry entry. The row only — no repo, no image, no rebuild.
 *
 * This is a database write that the NEXT Apply ships, which is the whole
 * reason the create form checks the repo first: an entry whose image does not
 * exist yet builds fine and then restart-loops on `podman run`, and it would
 * ride out on somebody else's unrelated Apply. The checks live in the UI (and
 * in server/registry.ts, which cannot be bypassed by a hand-made request);
 * what is enforced HERE is only what would corrupt the registry itself —
 * a duplicate name, a name Nix already owns, a colliding hostname.
 */
export async function createApp(input: NewApp): Promise<{ name: string }> {
  const name = input.name.trim().toLowerCase()

  const { manifestEntries, hostnamesTakenBy } = await import('../nix-manifest')
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
  const hostErr = hostnameError(
    hostname ?? effectiveHostname(name, null),
    await hostnamesTakenBy(''),
  )
  if (hostErr) throw new Error(`hostname ${hostErr}`)

  await db.insert(apps).values({
    name,
    stage: input.stage,
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
    icon: input.icon.trim() || 'mdi-cube-outline-#94a3b8',
    notes: {},
  })

  return { name }
}

/**
 * Drop a registry entry.
 *
 * Deliberately narrow: this removes the DECLARATION, and the next Apply
 * removes the container, the route, the DNS record, the probe, the Cloudflare
 * CNAME (route-sync prunes what is no longer declared) and the app's runner.
 * It does NOT reclaim state, and nothing here pretends otherwise — the
 * postgres role and database, /home/santiago/selfhost/apps/<name>/data, the
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
  'icon',
  'postgres',
  'storage',
  'litellm',
  'prometheus',
  'authMode',
  'authHealthPath',
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
  if (mode === 'proxy' && stage === 'off') {
    throw new Error('forward-auth (proxy) needs an ingress to gate; this app is not exposed')
  }

  await db
    .update(apps)
    .set({ ...clean, updatedAt: new Date() })
    .where(eq(apps.name, name))
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
    icon: entry.presentation.icon,
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
    authMode: record.authMode,
    authHealthPath: record.authHealthPath,
    authIsolated: record.authIsolated,
    egressContainer: record.egressContainer,
    egressHostPort: record.egressHostPort,
    limitCpus: record.limitCpus,
    limitMemoryMb: record.limitMemoryMb,
    limitPids: record.limitPids,
    description: record.description,
    icon: record.icon,
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
    authMode: manifest.auth.mode,
    authHealthPath: manifest.auth.healthPath ?? null,
    authIsolated: manifest.auth.isolated ?? false,
    egressContainer: manifest.egress?.container ?? null,
    egressHostPort: manifest.egress?.hostPort ?? null,
    limitCpus: manifest.resources?.cpus ?? null,
    limitMemoryMb: manifest.resources?.memoryMb ?? null,
    limitPids: manifest.resources?.pids ?? null,
    description: manifest.presentation.description,
    icon: manifest.presentation.icon,
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
            presentation: { description: r.description, icon: r.icon },
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
