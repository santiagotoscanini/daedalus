import { Await, createFileRoute, notFound } from '@tanstack/react-router'

import { CategoryBoards } from '../components/category/registry'
import { BoardsSkeleton, ServiceHeadSkeleton, StatBandSkeleton } from '../components/skeleton'
import { TabBar } from '../components/tabs'
import { CATEGORIES, type CategoryName, type CategorySpec, resolveTab } from '../lib/dashboard/nav'
import { fetchCategoryBoards, fetchTabStatus, type TabStatus } from '../server/category'

// One page per category, and a tab per subject inside it.
//
// The split is by *subject*, not by service: someone opening Media wants to
// know what is playing and what is downloading, and does not care that those
// two facts come from six containers.
//
// There was a directory of per-service cards under every page until the last
// of it went with Monitoring. It made sense while a category was one long page
// and the cards were how you reached a service at all — but every service has
// its own tab now, so a card was three of that page's numbers and its link,
// one scroll below the page itself.
//
// ── nothing here blocks the navigation ────────────────────────────────────
//
// The loader returns UNAWAITED promises. That is the whole design: the page
// frame — title, lede, sub-tabs — comes from the static CATEGORIES table and
// is on screen the instant you click, while the boards stream in behind their
// own skeleton.
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
    const spec = CATEGORIES.find((c) => c.id === params.category)
    // An unknown category is a 404, not an empty page: the rail cannot produce
    // one, so anything else got here by hand-editing the URL.
    if (spec === undefined) throw notFound()

    const category = params.category as CategoryName
    const tab = resolveTab(category, deps.tab)

    return {
      spec,
      tab,
      boards: fetchCategoryBoards({ data: { category, tab } }),
      // Only where a tab actually wears a dot — see CategorySpec.tabs. All
      // three ways of declaring one count; testing `probe` alone would skip
      // the request for a category whose tabs each hold several services, and
      // then draw grey dots over health it had chosen not to fetch.
      tabStatus: spec.tabs.some(
        (t) => t.probe !== undefined || t.probes !== undefined || t.health !== undefined,
      )
        ? fetchTabStatus({ data: { category } })
        : null,
    }
  },
  component: CategoryPage,
})

function CategoryPage() {
  const { spec, tab, boards, tabStatus } = Route.useLoaderData()
  const { category } = Route.useParams()

  return (
    <>
      <header className="page-head">
        <h1>{spec.label}</h1>
      </header>
      <p className="lede cat-lede">{spec.lede}</p>

      {spec.tabs.length > 0 &&
        (tabStatus === null ? (
          <TabNav spec={spec} category={category} tab={tab} status={null} />
        ) : (
          // The tabs are drawn immediately either way — navigation is the one
          // thing on this page that must never wait. The dot arrives in its
          // reserved slot, grey until it is known, so nothing moves.
          <Await
            promise={tabStatus}
            fallback={<TabNav spec={spec} category={category} tab={tab} status={null} />}
          >
            {(status) => <TabNav spec={spec} category={category} tab={tab} status={status} />}
          </Await>
        ))}

      <Await promise={boards} fallback={<BoardsPlaceholder spec={spec} tab={tab} />}>
        {(payload) => <CategoryBoards payload={payload} />}
      </Await>
    </>
  )
}

/**
 * The sub-tab row, optionally wearing each tab's status.
 *
 * `status === null` covers both "this category has no probes" and "they have
 * not landed yet". The dot is drawn in the second case and not the first,
 * which is why the caller decides rather than this component: a grey dot is a
 * claim ("nothing is probing this"), and a category that never had one should
 * not appear to be making it.
 */
function TabNav({
  spec,
  category,
  tab,
  status,
}: {
  spec: CategorySpec
  category: string
  tab: string
  status: TabStatus | null
}) {
  // `probes` counts as much as `probe`. A category whose tabs all hold several
  // services would otherwise render no dots at all — the tab knows its health
  // and silently declines to show it.
  const dotted = spec.tabs.some(
    (t) => t.probe !== undefined || t.probes !== undefined || t.health !== undefined,
  )

  return (
    <TabBar
      tabs={spec.tabs.map((t) => {
        const up = status?.[t.id] ?? null
        return {
          id: t.id,
          label: t.label,
          dividerBefore: t.dividerBefore,
          extra: dotted ? (
            <span
              className={`dot dot-${up === null ? 'unknown' : up ? 'running' : 'attention'}`}
              role="img"
              aria-label={up === null ? 'status unknown' : up ? 'up' : 'not answering'}
              title={
                t.probe === undefined && t.probes === undefined && t.health === undefined
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
 * The service header, the headline band and the grid, sized to the page that
 * is arriving.
 *
 * Sized per TAB where a tab says so: the category's own spans describe its
 * default tab, and a sibling laid out differently would reflow on arrival —
 * worst of all a band of stat cards that the page turns out not to have.
 *
 * The header is the same argument one level up. Almost every tab opens with
 * one, and without a placeholder for it the boards render at the top of the
 * page and are then pushed down by its height the instant the loader resolves.
 * `head: false` is the honest opt-out for the tabs whose subject is not a
 * service — see `CategorySpec.tabs[].head`.
 */
function BoardsPlaceholder({ spec, tab }: { spec: CategorySpec; tab: string }) {
  const t = spec.tabs.find((x) => x.id === tab)

  return (
    <>
      {t?.head !== false && <ServiceHeadSkeleton />}
      {t?.statBand !== false && <StatBandSkeleton />}
      <BoardsSkeleton spans={t?.boardSpans ?? spec.boardSpans} />
    </>
  )
}
