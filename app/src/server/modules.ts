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

/** What one boards request answers: the module it is for, and its resolved tab's data — or `off` (host/modules.ts). */
export type ModulePayload = { kind: string; data: { tab: string }; off?: true }

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
  return activeModules(MODULES, (await makeCtx()).modules.state)
})

/* ── switching a module off, and on ───────────────────────────────────── */

/** Every switch the box declares, with what a move would take (core/site/switches.ts). */
export const fetchModuleSwitches = createServerFn().handler(async () => {
  const { makeCtx } = await import('../core/ctx')
  const { moduleSwitches } = await import('../core/site/switches')
  return moduleSwitches(await makeCtx())
})

/** The switches a page's tab fronts, by nix module id. */
export const fetchModuleSwitchFn = createServerFn()
  .validator((data: unknown): { ids: string[] } => {
    const ids = (data as { ids?: unknown })?.ids
    if (!Array.isArray(ids) || !ids.every((i) => typeof i === 'string')) {
      throw new Error('expected { ids: string[] }')
    }
    return { ids: ids as string[] }
  })
  .handler(async ({ data }) => {
    const { makeCtx } = await import('../core/ctx')
    const { moduleSwitches } = await import('../core/site/switches')
    const all = await moduleSwitches(await makeCtx())
    return all.filter((m) => data.ids.includes(m.id))
  })

export const setModuleEnabledFn = createServerFn({ method: 'POST' })
  .validator((data: unknown): { id: string; enabled: boolean } => {
    const d = data as { id?: unknown; enabled?: unknown } | null
    if (d === null || typeof d.id !== 'string' || typeof d.enabled !== 'boolean') {
      throw new Error('expected { id, enabled }')
    }
    return { id: d.id, enabled: d.enabled }
  })
  .handler(async ({ data }) => {
    const { assertAdmin } = await import('../core/authz')
    await assertAdmin()
    const { makeCtx } = await import('../core/ctx')
    const { setModuleEnabled } = await import('../core/site/switches')
    return setModuleEnabled(await makeCtx(), data.id, data.enabled)
  })

export const setModuleWebFn = createServerFn({ method: 'POST' })
  .validator(
    (
      data: unknown,
    ): { id: string; name: string; label?: string | null; public?: boolean | null } => {
      const d = data as Record<string, unknown> | null
      if (d === null || typeof d.id !== 'string' || typeof d.name !== 'string') {
        throw new Error('expected { id, name, label?, public? }')
      }
      const out: { id: string; name: string; label?: string | null; public?: boolean | null } = {
        id: d.id,
        name: d.name,
      }
      if (d.label !== undefined) {
        if (d.label !== null && typeof d.label !== 'string')
          throw new Error('label must be text or null')
        out.label = d.label
      }
      if (d.public !== undefined) {
        if (d.public !== null && typeof d.public !== 'boolean') {
          throw new Error('public must be true, false or null')
        }
        out.public = d.public
      }
      return out
    },
  )
  .handler(async ({ data }) => {
    const { assertAdmin } = await import('../core/authz')
    await assertAdmin()
    const { makeCtx } = await import('../core/ctx')
    const { setModuleWeb } = await import('../core/site/switches')
    const { id, name, ...patch } = data
    return setModuleWeb(await makeCtx(), id, name, patch)
  })
