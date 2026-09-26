import type { AppStage, ManifestApp, ManifestEntry, ManifestTask } from '../../host/nix-manifest'
import type { appTasks } from '../../host/schema'
import { REGISTRY_SCHEMA_VERSION } from '../contract/version'
import type { AppRecord } from '../repo/apps'

// The registry's two translations and the comparison between them: a Nix
// manifest entry into a database row (`toRow`), database records into the
// site/apps.json export (`toRegistryExport`), and whether a record still
// describes what Nix built (`driftOf`).
//
// Pure — types only from host/ and lib/repo — so the round trip
// export → render → parse → toRow → export is testable without a database
// (lib/repo/apps.test.ts, today `toRow`'s only caller). Kept in one file
// because the three must agree field for field: a field exported but not
// compared is an edit that never ships.

/**
 * The platform default for `deploy.enable`, approximating the option default
 * in nix/platform/apps-options.nix (`!source.dev`): registry apps
 * auto-deploy, local-source ones have no registry image to poll. Applied
 * where a manifest entry omits `deploy` (hand-written entries like daedalus's
 * self.json).
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
 * Rebuild the export that nix/modules/apps/declarations.nix reads. Not written
 * to disk here — the Apply flow (host/apply-flow.ts) owns that, along with the
 * git commit and the rebuild — so the UI can show exactly what Apply WOULD
 * write.
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
