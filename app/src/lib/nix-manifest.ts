import { readFile } from 'node:fs/promises'

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
  presentation: { description: string; icon: string }
  /** Optional so an apps.json predating the field still parses. */
  resources?: ManifestResources
  notes?: Record<string, string>
}

export type NixManifest = {
  schemaVersion: number
  registry: { schemaVersion: number; apps: Record<string, ManifestApp> }
  nixManaged: Record<string, ManifestApp>
  /** Every hostname published on the box — apps and every other stack. */
  takenHostnames: string[]
  /**
   * webApp name → its published hostname. The same set as `takenHostnames`,
   * keyed rather than flattened: that one answers "is this name free", this one
   * answers "where do I dial `jellyfin`". The dashboard's tile catalogue names
   * webApps and resolves URLs through here, so a hostname edit moves the tile
   * with it instead of stranding a literal in TypeScript.
   */
  webAppHosts: Record<string, string>
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

let cachedManaged: NixManifest['nixManaged'] | null = null
let cachedTaken: string[] | null = null
let cachedHosts: Record<string, string> | null = null
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
  if (
    cachedManaged === null ||
    cachedTaken === null ||
    cachedHosts === null ||
    cachedSecretApps === null
  ) {
    const parsed = JSON.parse(await readFile(managedPath, 'utf8')) as NixManifest
    cachedManaged = parsed.nixManaged
    cachedTaken = parsed.takenHostnames
    cachedHosts = parsed.webAppHosts
    cachedSecretApps = parsed.operatorSecretApps ?? []
  }

  // The committed registry is NOT cached. It lives at a fixed path that
  // daedalus-registry-snapshot rewrites on every rebuild — which is precisely
  // what lets an Apply update it without restarting this app. Caching it would
  // reintroduce the restart by another name: the UI would keep reporting drift
  // against a registry that had already been applied.
  const registry = JSON.parse(await readFile(registryPath, 'utf8')) as NixManifest['registry']

  return {
    schemaVersion: 1,
    registry,
    nixManaged: cachedManaged,
    takenHostnames: cachedTaken,
    webAppHosts: cachedHosts,
    operatorSecretApps: cachedSecretApps,
  }
}

/** Apps with a tracked operator-secrets file. See `NixManifest.operatorSecretApps`. */
export async function operatorSecretApps(): Promise<string[]> {
  return (await readNixManifest()).operatorSecretApps
}

/** Published hostnames, keyed by webApp name. See `NixManifest.webAppHosts`. */
export async function webAppHosts(): Promise<Record<string, string>> {
  return (await readNixManifest()).webAppHosts
}

/**
 * Hostnames already published, minus the one this app currently holds — so an
 * app does not collide with itself.
 */
export async function hostnamesTakenBy(others: string): Promise<string[]> {
  const m = await readNixManifest()
  return m.takenHostnames.filter((h) => h !== others)
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
