import { type ComponentType, type LazyExoticComponent, lazy, type ReactNode, Suspense } from 'react'
import { nixModulesOf } from '../../lib/modules/manifest'
import { moduleById } from '../../lib/modules/registry'
import { ServiceSettingsButton } from '../service-settings'
import { EMPTY, MONO } from '../tokens'

// The browser half of the module registry: every module's `views` record,
// keyed by the directory the glob found it in.
//
// Lazy, one chunk per module, like the loaders (host/modules.ts): a page
// downloads the views of the module it shows and no other. The chunk loads
// behind the same placeholder the boards' data waits behind, so a first
// visit shows one skeleton for both and a second visit none. What must NOT
// appear in a `view/` tree is a value import of anything under the module's
// `data/` tree — that is the node-builtin graph the client/server split keeps
// out of browser chunks, and host/boundary.test.ts walks every view to make
// sure.

/**
 * A module's views as this file sees them. Each module types its own record
 * precisely (lib/modules/tabs.ts `TabViews`); here the per-tab payload is
 * erased to `never`, which every concrete prop type is assignable FROM, so a
 * precisely-typed record fits without a cast at the export.
 */
type ViewsRecord = Record<string, (props: { data: never }) => ReactNode>

const LOADERS = import.meta.glob<ViewsRecord>('../../modules/*/view/index.tsx', {
  import: 'views',
})

type TabProps = { tab: string; data: { tab: string } }

/** One lazy component per module, made once: a fresh one per render would remount it. */
const LAZY = new Map<string, LazyExoticComponent<ComponentType<TabProps>>>()

function moduleView(kind: string): LazyExoticComponent<ComponentType<TabProps>> {
  const made = LAZY.get(kind)
  if (made !== undefined) return made
  const load = LOADERS[`../../modules/${kind}/view/index.tsx`]
  if (load === undefined) throw new Error(`module ${kind} has no views`)
  const view = lazy(async () => {
    const views = await load()
    return {
      default: function ModuleTab({ tab, data }: TabProps) {
        const View = views[tab] as ComponentType<{ data: unknown }> | undefined
        // A payload names a tab the loader resolved from this module's own
        // manifest, so a missing view is a module that shipped a loader without
        // its pair — a bug, and one the tab records should have refused to compile.
        if (View === undefined) throw new Error(`module ${kind} has no view for tab ${tab}`)
        // Rendered as an element, not called: a view is a component and may hold hooks.
        return <View data={data} />
      },
    }
  })
  LAZY.set(kind, view)
  return view
}

/** What a module's server function answers with, as the route holds it. */
export type ModulePayload = { kind: string; data: { tab: string }; off?: true }

export function ModuleBoards({
  payload,
  fallback,
}: {
  payload: ModulePayload
  /** What shows while the module's views are on their way: the boards' own placeholder. */
  fallback: ReactNode
}) {
  if (payload.off === true) return <OffPanel module={payload.kind} tab={payload.data.tab} />
  const View = moduleView(payload.kind)
  return (
    <Suspense fallback={fallback}>
      <View tab={payload.data.tab} data={payload.data} />
    </Suspense>
  )
}

/**
 * A tab whose stack is switched off. No loader ran (host/modules.ts), so
 * there are no boards to draw; what the page owes the operator is the fact,
 * and the one control that changes it — the same cog every service wears.
 */
function OffPanel({ module, tab }: { module: string; tab: string }) {
  const spec = moduleById(module)?.tabs.find((t) => t.id === tab)
  const ids = spec === undefined ? [] : nixModulesOf(spec)
  return (
    <div className={`${EMPTY} flex flex-wrap items-center justify-center gap-[0.6rem]`}>
      <span>
        {ids.map((id, i) => (
          <span key={id}>
            {i > 0 && ', '}
            <span className={MONO}>{id}</span>
          </span>
        ))}{' '}
        {ids.length === 1 ? 'is' : 'are'} switched off on this box: nothing runs, nothing answers,
        and the data stays where it is. Switch it on from the cog, then Apply.
      </span>
      <ServiceSettingsButton ids={ids} />
    </div>
  )
}
