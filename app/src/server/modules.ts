import { createServerFn } from '@tanstack/react-start'
import { isRecord } from '../lib/is-record'
import type { ModuleManifest } from '../lib/modules/manifest'
import { isModuleId, MODULES, resolveModuleTab } from '../lib/modules/registry'

// The server functions behind the module pages.
//
// One module and one tab per request, for the reason server/category.ts
// gives: loading everything and letting the client pick would be ~90
// upstream calls to render a page showing a fifth of them. The manifest
// registry is client-safe and imported statically; the loaders are behind
// `await import`, like every value the seam reaches.

/** What one boards request answers: the module it is for, and its resolved tab's data. */
export type ModulePayload = { kind: string; data: { tab: string } }

export const fetchModuleBoards = createServerFn()
  .validator((data: unknown): { module: string; tab: string } => {
    if (!isRecord(data) || !isModuleId(data.module)) throw new Error('expected a module')
    if (typeof data.tab !== 'string') throw new Error('expected a tab')
    return { module: data.module, tab: data.tab }
  })
  .handler(async ({ data }): Promise<ModulePayload> => {
    const { makeCtx } = await import('../core/ctx')
    const { loadModule } = await import('../host/modules')
    return loadModule(data.module, resolveModuleTab(data.module, data.tab), await makeCtx())
  })

/**
 * The modules the rail should offer, with the tabs each one still has.
 *
 * A tab fronts nix modules (`TabSpec.nix`); when the box has every one of
 * them disabled the tab is not offered, and a module with no tabs left leaves
 * the rail. The decision is the server's because it reads the box's export —
 * the browser only ever sees the outcome. Until the export exists every
 * module is active, so this is a no-op on a box that has not published it.
 */
export const fetchActiveModules = createServerFn().handler(async (): Promise<ModuleManifest[]> => {
  const { makeCtx } = await import('../core/ctx')
  const { activeModules } = await import('../lib/modules/active')
  return activeModules(MODULES, (await makeCtx()).modules.enabled)
})
