import { createFileRoute, notFound } from '@tanstack/react-router'

import { StateDot } from '../components/controls'
import { GuardedAwait } from '../components/error'
import { ModuleBoards } from '../components/modules/boards'
import { PageHead } from '../components/page'
import { BoardsSkeleton, ServiceHeadSkeleton } from '../components/skeleton'
import { TabBar } from '../components/tabs'
import { isDotted, type PageSpec, resolveTabOf } from '../lib/modules/manifest'
import { moduleById } from '../lib/modules/registry'
import { fetchModuleBoards } from '../server/modules'
import { fetchTabStatus, type TabStatus } from '../server/tab-status'

// One page per module, and a tab per subject inside it.
//
// The split is by *subject*, not by service: someone opening Media wants to
// know what is playing and what is downloading, and does not care that those
// two facts come from six containers.
//
// The URL segment is still `/c/<id>` — the modules were categories before
// they were directories, and every bookmark and rail link says `c`.
//
// ── nothing here blocks the navigation ────────────────────────────────────
//
// The loader returns UNAWAITED promises. That is the whole design: the page
// frame — title, lede, sub-tabs — comes from the module's manifest and is on
// screen the instant you click, while the boards stream in behind their own
// skeleton.
//
// The router still caches a resolved loader result for `defaultStaleTime`, so
// coming back to a page you just left renders complete, with no skeleton
// flash — the placeholders appear only when something is actually being
// fetched.

export const Route = createFileRoute('/c/$category')({
  // Same reasoning as the app detail page: the sub-tab is in the URL so it
  // survives a refresh, can be linked, and renders on the server.
  validateSearch: (search: Record<string, unknown>): { tab?: string } => ({
    tab: typeof search.tab === 'string' ? search.tab : undefined,
  }),
  loaderDeps: ({ search }) => ({ tab: search.tab }),
  loader: ({ params, deps }) => {
    const spec = moduleById(params.category)
    // An unknown module is a 404, not an empty page: the rail cannot produce
    // one, so anything else got here by hand-editing the URL.
    if (spec === undefined) throw notFound()

    const tab = resolveTabOf(spec, deps.tab)

    return {
      spec,
      tab,
      boards: fetchModuleBoards({ data: { module: spec.id, tab } }),
      // Only where a tab actually wears a dot. All three ways of declaring one
      // count; testing `probe` alone would skip the request for a module whose
      // tabs each hold several services, and then draw grey dots over health
      // it had chosen not to fetch.
      tabStatus: spec.tabs.some(isDotted) ? fetchTabStatus({ data: { module: spec.id } }) : null,
    }
  },
  component: CategoryPage,
})

function CategoryPage() {
  const { spec, tab, boards, tabStatus } = Route.useLoaderData()
  const { category } = Route.useParams()
  // Switching module or tab clears a caught failure; staying put does not,
  // so a section that failed stays failed until its loader is re-run.
  const sectionKey = `${category}/${tab}`

  return (
    <>
      <PageHead title={spec.label}>{spec.lede}</PageHead>

      {spec.tabs.length > 0 &&
        (tabStatus === null ? (
          <TabNav spec={spec} category={category} tab={tab} status={null} />
        ) : (
          // The tabs are drawn immediately either way — navigation is the one
          // thing on this page that must never wait. The dot arrives in its
          // reserved slot, grey until it is known, so nothing moves.
          //
          // Guarded, like the boards below: this is the single render path for
          // every module and every tab, and it fans out over a dozen
          // upstreams. An unguarded rejection here throws past the Suspense
          // fallback and blanks the whole dashboard — one dead upstream must
          // cost its own row of dots, not the page.
          <GuardedAwait
            resetKey={sectionKey}
            promise={tabStatus}
            fallback={<TabNav spec={spec} category={category} tab={tab} status={null} />}
          >
            {(status) => <TabNav spec={spec} category={category} tab={tab} status={status} />}
          </GuardedAwait>
        ))}

      <GuardedAwait
        resetKey={sectionKey}
        promise={boards}
        fallback={<BoardsPlaceholder spec={spec} tab={tab} />}
      >
        {(payload) => <ModuleBoards payload={payload} />}
      </GuardedAwait>
    </>
  )
}

/**
 * The sub-tab row, optionally wearing each tab's status.
 *
 * `status === null` covers both "this module has no probes" and "they have
 * not landed yet". The dot is drawn in the second case and not the first,
 * which is why the caller decides rather than this component: a grey dot is a
 * claim ("nothing is probing this"), and a module that never had one should
 * not appear to be making it.
 */
function TabNav({
  spec,
  category,
  tab,
  status,
}: {
  spec: PageSpec
  category: string
  tab: string
  status: TabStatus | null
}) {
  // `probes` counts as much as `probe`. A module whose tabs all hold several
  // services would otherwise render no dots at all — the tab knows its health
  // and silently declines to show it.
  const dotted = spec.tabs.some(isDotted)

  return (
    <TabBar
      tabs={spec.tabs.map((t) => {
        const up = status?.[t.id] ?? null
        return {
          id: t.id,
          label: t.label,
          dividerBefore: t.dividerBefore,
          extra: dotted ? (
            <StateDot
              state={up === null ? 'unknown' : up ? 'running' : 'attention'}
              label={up === null ? 'status unknown' : up ? 'up' : 'not answering'}
              title={
                !isDotted(t)
                  ? 'nothing probes this yet'
                  : up === null
                    ? 'no reading from gatus'
                    : up
                      ? 'answering'
                      : 'nothing has answered in the last few minutes'
              }
            />
          ) : undefined,
        }
      })}
      active={tab}
      linkTo={(id) => ({ to: '/c/$category', params: { category }, search: { tab: id } })}
    />
  )
}

/**
 * The service header and the grid, sized to the page that is arriving.
 *
 * Sized per TAB where a tab says so: the module's own spans describe its
 * default tab, and a sibling laid out differently would reflow on arrival.
 *
 * The header is the same argument one level up. Almost every tab opens with
 * one, and without a placeholder for it the boards render at the top of the
 * page and are then pushed down by its height the instant the loader resolves.
 * `head: false` is the honest opt-out for the tabs whose subject is not a
 * service — see `TabSpec.head`.
 */
function BoardsPlaceholder({ spec, tab }: { spec: PageSpec; tab: string }) {
  const t = spec.tabs.find((x) => x.id === tab)

  return (
    <>
      {t?.head !== false && <ServiceHeadSkeleton />}
      <BoardsSkeleton spans={t?.boardSpans ?? spec.boardSpans} />
    </>
  )
}
