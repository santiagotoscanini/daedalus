import type { Ctx } from '../core/ctx'
import { nixModulesOf } from '../lib/modules/manifest'
import { moduleById } from '../lib/modules/registry'
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

/**
 * What a module's server function answers with. `off` is a tab whose every
 * nix module is switched off on this box: no loader ran — the boards would
 * only say "not answering" of a service that was told not to — and the page
 * draws the switch in their place (components/modules/boards.tsx).
 */
export type ModulePayload = { kind: string; data: { tab: string }; off?: true }

/** One module, one tab, loaded with the capability set and nothing else. */
export async function loadModule(id: string, tab: string, ctx: Ctx): Promise<ModulePayload> {
  const thunk = LOADERS[pathOf(id)]
  if (thunk === undefined) throw new Error(`no data module for ${id}`)
  const spec = moduleById(id)?.tabs.find((t) => t.id === tab)
  const nix = spec === undefined ? [] : nixModulesOf(spec)
  if (nix.length > 0 && !nix.some((n) => ctx.modules.state(n) === 'on')) {
    return { kind: id, data: { tab }, off: true }
  }
  const load = await thunk()
  return { kind: id, data: await load(tab, ctx) }
}
