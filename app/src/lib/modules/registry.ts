import { type ModuleManifest, type PageSpec, resolveTabOf } from './manifest'

// Every module on this dashboard, found rather than listed.
//
// `import.meta.glob` over the manifests is the registry: a directory under
// `src/modules/` with a `manifest.ts` is a module, and one without is not.
// Eager, because the rail draws every manifest on every page and a manifest
// is data — the server and browser halves of a module are globbed lazily by
// their own registries (host/modules.ts, components/modules/boards.tsx) and
// never from here.
//
// CLIENT-SAFE, and the boundary test holds it so: only manifests are reached.

const MANIFEST_GLOB = /^\.\.\/\.\.\/modules\/([^/]+)\/manifest\.ts$/

const found = import.meta.glob<ModuleManifest>('../../modules/*/manifest.ts', {
  eager: true,
  import: 'manifest',
})

/** The modules, in rail order. */
export const MODULES: readonly ModuleManifest[] = Object.entries(found)
  .map(([path, manifest]) => {
    // The directory IS the id. A manifest that disagrees with its directory
    // would be reachable under one name and rendered under another; refuse
    // it at load, where the author sees it, not at the first click.
    const dir = MANIFEST_GLOB.exec(path)?.[1]
    if (dir !== manifest.id) {
      throw new Error(`src/modules/${dir}/manifest.ts declares id ${JSON.stringify(manifest.id)}`)
    }
    return manifest
  })
  .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))

export function moduleById(id: string): ModuleManifest | undefined {
  return MODULES.find((m) => m.id === id)
}

export function isModuleId(id: unknown): id is string {
  return typeof id === 'string' && MODULES.some((m) => m.id === id)
}

/** The tab a request for this module resolves to. '' for an unknown module. */
export function resolveModuleTab(id: string, tab: string | undefined): string {
  const spec: PageSpec | undefined = moduleById(id)
  return spec === undefined ? '' : resolveTabOf(spec, tab)
}
