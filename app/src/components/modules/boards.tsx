import type React from 'react'
import type { ReactNode } from 'react'
import { ModuleSwitchFoot } from '../module-switch'

// The browser half of the module registry: every module's `views` record,
// keyed by the directory the glob found it in.
//
// Eager and static, where the loaders are lazy: these are React components
// with no server-only reach, and the category route bundles them anyway.
// What must NOT appear in a `view/` tree is a value import of anything under
// the module's `data/` tree — that is the node-builtin graph the client/
// server split keeps out of browser chunks, and host/boundary.test.ts walks
// every view to make sure.

/**
 * A module's views as this file sees them. Each module types its own record
 * precisely (lib/modules/tabs.ts `TabViews`); here the per-tab payload is
 * erased to `never`, which every concrete prop type is assignable FROM, so a
 * precisely-typed record fits without a cast at the export.
 */
type ViewsRecord = Record<string, (props: { data: never }) => ReactNode>

const VIEWS = import.meta.glob<ViewsRecord>('../../modules/*/view/index.tsx', {
  eager: true,
  import: 'views',
})

/** What a module's server function answers with, as the route holds it. */
export type ModulePayload = { kind: string; data: { tab: string } }

export function hasModuleViews(id: string): boolean {
  return `../../modules/${id}/view/index.tsx` in VIEWS
}

export function ModuleBoards({ payload }: { payload: ModulePayload }) {
  const views = VIEWS[`../../modules/${payload.kind}/view/index.tsx`]
  const View = views?.[payload.data.tab] as React.ComponentType<{ data: unknown }> | undefined
  // A payload names a tab the loader resolved from this module's own
  // manifest, so a missing view is a module that shipped a loader without
  // its pair — a bug, and one the tab records should have refused to compile.
  if (View === undefined) {
    throw new Error(`module ${payload.kind} has no view for tab ${payload.data.tab}`)
  }
  // Rendered as an element, not called: a view is a component and may hold
  // hooks. The switch for the stack this tab fronts follows the boards: one
  // footer for every module page, so no view has to know it exists.
  return (
    <>
      <View data={payload.data} />
      <ModuleSwitchFoot module={payload.kind} tab={payload.data.tab} />
    </>
  )
}
