import { readFile } from 'node:fs/promises'
import {
  arrayOf,
  bool,
  type Decoder,
  decode,
  literal,
  nullable,
  num,
  obj,
  optional,
  recordOf,
  str,
} from './contract/decode'
import { REGISTRY_SCHEMA_VERSION } from './contract/version'

// What Nix last built, as handed to this container by stacks/daedalus/daedalus.nix.
//
// This is NOT a second source of truth — it is the *comparison* target. The
// database is authoritative for everything the UI edits; this file is what the
// running system was actually built from. Where they differ, the app has
// pending changes that no Apply has shipped yet, and the UI says so rather
// than pretending the DB is live.
//
// It is a /nix/store path, so it can only change via a rebuild, and a rebuild
// restarts this container with the new one. There is no cache to invalidate.

export type AppStage = 'off' | 'lab' | 'live'

export type ManifestEnvVar = { key: string; value: string; note?: string | null }

/**
 * cgroup v2 caps. null on any field = uncapped, which is the platform default
 * — see the `resources` option in stacks/apps/apps.nix for what each one
 * actually enforces and where the flag names lie about it.
 */
export type ManifestResources = {
  cpus: number | null
  memoryMb: number | null
  pids: number | null
}

export const NO_RESOURCES: ManifestResources = { cpus: null, memoryMb: null, pids: null }

export type ManifestApp = {
  stage: AppStage
  sourceMode?: 'registry' | 'local'
  postgres: boolean
  storage: boolean
  litellm: boolean
  prometheus: boolean
  /** null = `<name>.<baseDomain>`. Exactly one label under it — see apps.nix. */
  hostname?: string | null
  /**
   * The freeze switch. Absent (hand-written entries like daedalus's
   * self.json) = the platform default, `sourceMode === 'registry'` — the
   * same rule stacks/apps/apps.nix applies to `deploy.enable`.
   */
  deploy?: { enable: boolean } | null
  image: string | null
  egress: { container: string; hostPort: number } | null
  env: ManifestEnvVar[]
  auth: {
    mode: 'none' | 'proxy' | 'native'
    healthPath?: string | null
    isolated?: boolean
    allowedGroups?: string[] | null
    bypassRule?: string | null
  }
  presentation: { description: string }
  /** Optional so an apps.json predating the field still parses. */
  resources?: ManifestResources
  notes?: Record<string, string>
}

// The publish/network/jobs registries moved to the /export domains
// (src/lib/contract/domains/); the accessors below keep their names and
// delegate. What remains OF the manifest is the app-registry contract:
export type NixManifest = {
  schemaVersion: number
  registry: { schemaVersion: number; apps: Record<string, ManifestApp> }
  nixManaged: Record<string, ManifestApp>
  /**
   * Apps with a tracked `stacks/apps/<name>-env.sops`.
   *
   * A fact, not a setting — the file existing is the only thing that decides
   * whether an app gets operator secrets, so there is nothing for the database
   * to hold an opinion about and nothing to drift. It arrives here rather than
   * through the registry export for exactly that reason: `apps.json` carries
   * what daedalus decides, this manifest carries what Nix found.
   */
  operatorSecretApps: string[]
}

/**
 * Every app Nix knows about, tagged with whether daedalus may edit it.
 *
 * `operatorSecrets` is resolved here from `operatorSecretApps` so callers see
 * one shape per app instead of having to remember which facts live in which
 * half of the manifest.
 */
export type ManifestEntry = ManifestApp & {
  name: string
  managedInNix: boolean
  operatorSecrets: boolean
}

// The runtime shape of one registry entry. Optional keys decode to the same
// normalised defaults every consumer already applied by hand (`?? null`,
// `?? {}`), so a file from an older writer parses and a malformed one names
// its broken path instead of surfacing as a crash three renders later.
const ns = optional(nullable(str), null)
const nn = optional(nullable(num), null)

const manifestApp: Decoder<ManifestApp> = obj({
  stage: literal('off', 'lab', 'live'),
  sourceMode: optional(literal('registry', 'local'), 'registry'),
  postgres: bool,
  storage: bool,
  litellm: bool,
  prometheus: bool,
  hostname: ns,
  deploy: optional(nullable(obj({ enable: bool })), null),
  image: ns,
  egress: optional(nullable(obj({ container: str, hostPort: num })), null),
  env: optional(arrayOf(obj({ key: str, value: str, note: ns })), []),
  auth: obj({
    mode: literal('none', 'proxy', 'native'),
    healthPath: ns,
    isolated: optional(bool, false),
    allowedGroups: optional(nullable(arrayOf(str)), null),
    bypassRule: ns,
  }),
  presentation: obj({ description: str }),
  resources: optional(obj({ cpus: nn, memoryMb: nn, pids: nn }), NO_RESOURCES),
  notes: optional(recordOf(str), {}),
})

const managedManifestShape = obj({
  schemaVersion: optional(num, 1),
  nixManaged: recordOf(manifestApp),
  operatorSecretApps: optional(arrayOf(str), []),
})

const registryFileShape = obj({
  schemaVersion: optional(num, 1),
  apps: recordOf(manifestApp),
})

let cachedManaged: NixManifest['nixManaged'] | null = null
let cachedSecretApps: string[] | null = null

export async function readNixManifest(): Promise<NixManifest> {
  const managedPath = process.env.NIX_MANIFEST_PATH
  const registryPath = process.env.NIX_REGISTRY_PATH
  if (!managedPath || !registryPath) {
    throw new Error(
      'NIX_MANIFEST_PATH / NIX_REGISTRY_PATH are not set. Both are injected by ' +
        'stacks/daedalus/daedalus.nix — check the container env.',
    )
  }

  // The hand-written entries are a /nix/store path: immutable, and a change to
  // them restarts this container anyway, so caching for the process lifetime
  // is safe.
  if (cachedManaged === null || cachedSecretApps === null) {
    // decode() throws with the failing path. Loud on purpose: this file is
    // the app's core contract with nix, and a silently-empty manifest would
    // report every app as "not in the last Nix build".
    const parsed = decode(managedManifestShape, JSON.parse(await readFile(managedPath, 'utf8')))
    cachedManaged = parsed.nixManaged
    cachedSecretApps = parsed.operatorSecretApps
  }

  // The committed registry is NOT cached. It lives at a fixed path that
  // daedalus-registry-snapshot rewrites on every rebuild — which is precisely
  // what lets an Apply update it without restarting this app. Caching it would
  // reintroduce the restart by another name: the UI would keep reporting drift
  // against a registry that had already been applied.
  const registry = decode(registryFileShape, JSON.parse(await readFile(registryPath, 'utf8')))
  if (registry.schemaVersion !== REGISTRY_SCHEMA_VERSION) {
    // Finally read rather than assumed. The declarations.nix assertion guards
    // the rebuild; this guards the importer and the drift comparison.
    throw new Error(
      `applied registry declares schemaVersion ${String(registry.schemaVersion)}; this reader understands ${String(REGISTRY_SCHEMA_VERSION)}`,
    )
  }

  return {
    schemaVersion: registry.schemaVersion,
    registry,
    nixManaged: cachedManaged,
    operatorSecretApps: cachedSecretApps,
  }
}

/** Scheduled jobs and how each is watched — from /export/jobs.json. */
export async function monitoredJobs(): Promise<
  { unit: string; email: boolean; slug: string | null }[]
> {
  const { monitoredJobsList } = await import('./contract/domains/jobs')
  return monitoredJobsList()
}

/** Apps with a tracked operator-secrets file. See `NixManifest.operatorSecretApps`. */
export async function operatorSecretApps(): Promise<string[]> {
  return (await readNixManifest()).operatorSecretApps
}

/** Published hostnames, keyed by webApp name. See `NixManifest.webAppHosts`. */
export async function webAppHosts(): Promise<Record<string, string>> {
  const { publishingFacts } = await import('./contract/domains/publishing')
  const { webApps } = await publishingFacts()
  return Object.fromEntries(Object.entries(webApps).map(([name, w]) => [name, w.hostname]))
}

/** Names pi-hole answers from its own hosts file — from /export/network.json. */
export async function lanHosts(): Promise<{ ip: string; host: string }[]> {
  const { networkFacts } = await import('./contract/domains/network')
  return (await networkFacts()).lanHosts
}

/**
 * Hostnames already published, minus the one this app currently holds — so an
 * app does not collide with itself. From /export/publishing.json.
 */
export async function hostnamesTakenBy(others: string): Promise<string[]> {
  const { publishingFacts } = await import('./contract/domains/publishing')
  return (await publishingFacts()).takenHostnames.filter((h) => h !== others)
}

export async function manifestEntries(): Promise<ManifestEntry[]> {
  const m = await readNixManifest()
  const hasSecrets = new Set(m.operatorSecretApps)
  return [
    ...Object.entries(m.registry.apps).map(([name, a]) => ({ ...a, name, managedInNix: false })),
    ...Object.entries(m.nixManaged).map(([name, a]) => ({ ...a, name, managedInNix: true })),
  ]
    .map((e) => ({ ...e, operatorSecrets: hasSecrets.has(e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name))
}
