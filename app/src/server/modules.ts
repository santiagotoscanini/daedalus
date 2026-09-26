import {
  arrayOf,
  asValidator,
  bool,
  nullable,
  obj,
  optional,
  str,
  withMessage,
} from '../lib/contract/decode'
import { moduleIdField } from '../lib/contract/fields'
import type { ModuleManifest } from '../lib/modules/manifest'
import { MODULES, resolveModuleTab } from '../lib/modules/registry'
import { adminFn, readFn } from './fn'

// The server functions behind the module pages.
//
// One module and one tab per request, for the reason server/category.ts
// gives: loading everything and letting the client pick would be ~90
// upstream calls to render a page showing a fifth of them. The manifest
// registry is client-safe and imported statically; the loaders are behind
// `await import`, like every value the seam reaches.

/** What one boards request answers: the module it is for, and its resolved tab's data — or `off` (host/modules.ts). */
export type ModulePayload = { kind: string; data: { tab: string }; off?: true }

export const fetchModuleBoards = readFn
  .validator(
    asValidator(
      withMessage(
        obj({ module: moduleIdField, tab: withMessage(str, 'expected a tab') }),
        'expected a module',
      ),
    ),
  )
  .handler(async ({ data, context }): Promise<ModulePayload> => {
    const { loadModule } = await import('../host/modules')
    return loadModule(data.module, resolveModuleTab(data.module, data.tab), await context.ctx())
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
export const fetchActiveModules = readFn.handler(async ({ context }): Promise<ModuleManifest[]> => {
  const { activeModules } = await import('../lib/modules/active')
  return activeModules(MODULES, (await context.ctx()).modules.state)
})

/* ── switching a module off, and on ───────────────────────────────────── */

/** Every switch the box declares, with what a move would take (core/site/switches.ts). */
export const fetchModuleSwitches = readFn.handler(async ({ context }) => {
  const { moduleSwitches } = await import('../core/site/switches')
  return moduleSwitches(await context.ctx())
})

/** The switches a page's tab fronts, by nix module id. */
export const fetchModuleSwitchFn = readFn
  .validator(asValidator(withMessage(obj({ ids: arrayOf(str) }), 'expected { ids: string[] }')))
  .handler(async ({ data, context }) => {
    const { moduleSwitches } = await import('../core/site/switches')
    const all = await moduleSwitches(await context.ctx())
    return all.filter((m) => data.ids.includes(m.id))
  })

export const setModuleEnabledFn = adminFn
  .validator(asValidator(withMessage(obj({ id: str, enabled: bool }), 'expected { id, enabled }')))
  .handler(async ({ data, context }) => {
    const { setModuleEnabled } = await import('../core/site/switches')
    return setModuleEnabled(await context.ctx(), data.id, data.enabled)
  })

/** An absent field is `undefined` — "leave it" — and null clears the override. */
const webPatch = withMessage(
  obj({
    id: str,
    name: str,
    label: withMessage(
      optional<string | null | undefined>(nullable(str), undefined),
      'label must be text or null',
    ),
    public: withMessage(
      optional<boolean | null | undefined>(nullable(bool), undefined),
      'public must be true, false or null',
    ),
  }),
  'expected { id, name, label?, public? }',
)

export const setModuleWebFn = adminFn
  .validator(asValidator(webPatch))
  .handler(async ({ data, context }) => {
    const { setModuleWeb } = await import('../core/site/switches')
    const { id, name, ...patch } = data
    return setModuleWeb(await context.ctx(), id, name, patch)
  })
