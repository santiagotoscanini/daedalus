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

export type ManifestApp = {
  stage: AppStage
  sourceMode?: 'registry' | 'local'
  postgres: boolean
  storage: boolean
  litellm: boolean
  prometheus: boolean
  operatorSecrets: boolean
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
  homepage: { description: string; icon: string }
  notes?: Record<string, string>
}

export type NixManifest = {
  schemaVersion: number
  registry: { schemaVersion: number; apps: Record<string, ManifestApp> }
  nixManaged: Record<string, ManifestApp>
}

/** Every app Nix knows about, tagged with whether daedalus may edit it. */
export type ManifestEntry = ManifestApp & { name: string; managedInNix: boolean }

let cachedManaged: NixManifest['nixManaged'] | null = null

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
  cachedManaged ??= (JSON.parse(await readFile(managedPath, 'utf8')) as NixManifest).nixManaged

  // The committed registry is NOT cached. It lives at a fixed path that
  // daedalus-registry-snapshot rewrites on every rebuild — which is precisely
  // what lets an Apply update it without restarting this app. Caching it would
  // reintroduce the restart by another name: the UI would keep reporting drift
  // against a registry that had already been applied.
  const registry = JSON.parse(await readFile(registryPath, 'utf8')) as NixManifest['registry']

  return { schemaVersion: 1, registry, nixManaged: cachedManaged }
}

export async function manifestEntries(): Promise<ManifestEntry[]> {
  const m = await readNixManifest()
  return [
    ...Object.entries(m.registry.apps).map(([name, a]) => ({ ...a, name, managedInNix: false })),
    ...Object.entries(m.nixManaged).map(([name, a]) => ({ ...a, name, managedInNix: true })),
  ].sort((a, b) => a.name.localeCompare(b.name))
}
