import { asc, eq } from 'drizzle-orm'
import { REGISTRY_SCHEMA_VERSION } from '../contract/version'
import { db } from '../db'
import { appNameError, BASE_DOMAIN, effectiveHostname, hostnameError } from '../hostname'
import {
  type AppStage,
  type ManifestApp,
  type ManifestEntry,
  manifestEntries,
} from '../nix-manifest'
import { appEnvVars, apps } from '../schema'

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
 */
export type NewApp = {
  name: string
  description: string
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
  const stage = input.stage
  if (stage !== 'off' && stage !== 'lab' && stage !== 'live') {
    throw new Error('stage must be off | lab | live')
  }
  return {
    name: str('name'),
    description: str('description'),
    stage,
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
export type AppPatch = Partial<Pick<typeof apps.$inferInsert, EditableField>>

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
    switch (k as EditableField) {
      case 'stage':
        if (v !== 'off' && v !== 'lab' && v !== 'live') bad(k, 'off | lab | live')
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
