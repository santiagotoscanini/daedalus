import type { ReactNode } from 'react'
import type { Ctx } from '../../core/ctx'
import type { ModuleManifest } from './manifest'

// The per-tab contract a module's two halves agree on.
//
// A module's `data/index.ts` builds its loader with `defineLoader`, handing a
// record with one entry per tab id; its `view/index.tsx` exports `views`, a
// record of the same keys. The keys come from the manifest's `as const` tab
// list, so a tab declared without a loader, or a loader without a view, is a
// compile error in the module that forgot it — where the `switch (tab)` this
// replaced fell through to a default case and quietly rendered the wrong
// page.
//
// The two records are typed against ONE map, `D`, of tab id → that tab's
// data. The data half declares it and the view half imports it with `import
// type`, which `verbatimModuleSyntax` erases, so a browser chunk never learns
// the data module's path (host/boundary.test.ts holds that line).

/** The tab ids of a manifest declared `as const`. */
type TabId<M extends ModuleManifest> = M['tabs'][number]['id']

/** What a module's tabs answer with: one shape per tab id. */
export type TabDataMap<M extends ModuleManifest> = { [K in TabId<M>]: object }

/** One loader per tab. Each receives the capability set and nothing else. */
export type TabLoaders<M extends ModuleManifest, D extends TabDataMap<M>> = {
  [K in TabId<M>]: (ctx: Ctx) => Promise<D[K]>
}

/** What one boards request answers: the tab it resolved to, and that tab's data. */
export type TabPayload<M extends ModuleManifest, D extends TabDataMap<M>> = {
  [K in TabId<M>]: { tab: K } & D[K]
}[TabId<M>]

/** One view per tab, each typed to exactly the payload its loader produces. */
export type TabViews<M extends ModuleManifest, D extends TabDataMap<M>> = {
  [K in TabId<M>]: (props: { data: { tab: K } & D[K] }) => ReactNode
}

/** The loader a module exports as `load` — what the registry calls. */
export type ModuleLoader = (tab: string, ctx: Ctx) => Promise<{ tab: string }>

/**
 * A module's loader, from its manifest and one loader per tab.
 *
 * Resolves an unknown tab to the first one rather than failing: the URL is
 * where the tab lives, and a bookmark from before a rename must still open
 * the module.
 */
export function defineLoader<const M extends ModuleManifest, D extends TabDataMap<M>>(
  manifest: M,
  loaders: TabLoaders<M, D>,
): (tab: string, ctx: Ctx) => Promise<TabPayload<M, D>> {
  return async (tab, ctx) => {
    const id = (
      manifest.tabs.some((t) => t.id === tab) ? tab : (manifest.tabs[0]?.id ?? '')
    ) as TabId<M>
    const load = loaders[id]
    if (load === undefined) throw new Error(`module ${manifest.id} has no loader for tab ${id}`)
    return { tab: id, ...(await load(ctx)) } as TabPayload<M, D>
  }
}

/**
 * The views record, checked against the manifest. Identity at runtime; the
 * point is the constraint, which makes a missing tab a compile error at the
 * one call site that names both.
 */
export function defineViews<const M extends ModuleManifest, D extends TabDataMap<M>>(
  _manifest: M,
  views: TabViews<M, D>,
): TabViews<M, D> {
  return views
}
