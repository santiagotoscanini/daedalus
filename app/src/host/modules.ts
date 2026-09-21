import type { Ctx } from '../core/ctx'
import type { ModuleLoader } from '../lib/modules/tabs'

// The server half of the module registry: one lazy import per module's
// `data/index.ts`, keyed by the directory the glob found it in.
//
// Lazy, because each module's data tree drags its whole upstream graph with
// it — every client it dials, every decoder it needs — and one request should
// load exactly one. Under `src/host/` because the thunks resolve to modules
// that need the machine; a client chunk must never hold this map.

const LOADERS = import.meta.glob<ModuleLoader>('../modules/*/data/index.ts', { import: 'load' })

const pathOf = (id: string) => `../modules/${id}/data/index.ts`

/** Whether a module ships a data half at all. */
export function hasModuleLoader(id: string): boolean {
  return pathOf(id) in LOADERS
}

/** One module, one tab, loaded with the capability set and nothing else. */
export async function loadModule(
  id: string,
  tab: string,
  ctx: Ctx,
): Promise<{ kind: string; data: { tab: string } }> {
  const thunk = LOADERS[pathOf(id)]
  if (thunk === undefined) throw new Error(`no data module for ${id}`)
  const load = await thunk()
  return { kind: id, data: await load(tab, ctx) }
}
