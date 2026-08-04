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

let cached: NixManifest | null = null

export async function readNixManifest(): Promise<NixManifest> {
  // Cached for the life of the process. Safe precisely because the path is
  // immutable: a changed manifest means a changed store path means a new
  // container. Under `vite dev` the module reloads on edit anyway.
  if (cached) return cached

  const path = process.env.NIX_MANIFEST_PATH
  if (!path) {
    throw new Error(
      'NIX_MANIFEST_PATH is not set. It is injected by stacks/daedalus/daedalus.nix — ' +
        'check the container env.',
    )
  }

  cached = JSON.parse(await readFile(path, 'utf8')) as NixManifest
  return cached
}

export async function manifestEntries(): Promise<ManifestEntry[]> {
  const m = await readNixManifest()
  return [
    ...Object.entries(m.registry.apps).map(([name, a]) => ({ ...a, name, managedInNix: false })),
    ...Object.entries(m.nixManaged).map(([name, a]) => ({ ...a, name, managedInNix: true })),
  ].sort((a, b) => a.name.localeCompare(b.name))
}
