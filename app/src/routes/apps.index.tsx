import { createFileRoute, Link } from '@tanstack/react-router'
import { AppsList } from '../components/apps/apps-list'
import { BuilderView } from '../components/apps/builder'
import { GuardedAwait } from '../components/error'
import { PageHead } from '../components/page'
import { ImagesView, PackagesView } from '../components/registries'
import { BoardsSkeleton, RowsSkeleton } from '../components/skeleton'
import { TabBar } from '../components/tabs'
import { Button } from '../components/ui/button'
import { siteBarFields } from '../lib/module-switch'
import { fetchBuilderTab } from '../server/builds'
import { fetchNodesChangeFn } from '../server/nodes'
import { fetchApps, fetchImagesTab, fetchPackagesTab } from '../server/registry'
import { fetchSiteEdit } from '../server/site'

// The app list. Every row joins three sources: the registry (Postgres — what
// daedalus believes), the Nix manifest (what the box was actually built from,
// hence drift), and Prometheus (what is happening right now).

// Four tabs, the same shape every category page uses: what this box runs, the
// two registries it is built out of, and the builder that fills the first of
// them. The registries are services — containers with release cycles, logs and
// neighbours — so each gets a tab with the header, version verdict and
// changelog every other service here has, rather than a few numbers at the
// foot of the app list. The builder is the box's own machinery, so its tab
// opens straight into its boards.
const TABS = [
  { id: 'apps', label: 'Apps' },
  { id: 'images', label: 'Container registry' },
  { id: 'packages', label: 'npm packages' },
  { id: 'builder', label: 'Builder' },
] as const

type Tab = (typeof TABS)[number]['id']

export const Route = createFileRoute('/apps/')({
  validateSearch: (search: Record<string, unknown>): { tab?: Tab } => ({
    tab: TABS.some((t) => t.id === search.tab) ? (search.tab as Tab) : undefined,
  }),
  loaderDeps: ({ search }) => ({ tab: search.tab ?? ('apps' as const) }),
  // Only the open tab's data is fetched. Each registry tab is its service
  // through traefik, a handful of Prometheus queries and a GitHub release
  // lookup (lib/apps/registries.ts), and the app list is mostly a Postgres
  // read — pairing them would cost the fast one every time.
  loader: ({ deps }) => ({
    tab: deps.tab,
    list: deps.tab === 'apps' ? fetchAppsTab() : null,
    images: deps.tab === 'images' ? fetchImagesTab() : null,
    packages: deps.tab === 'packages' ? fetchPackagesTab() : null,
    builder: deps.tab === 'builder' ? fetchBuilderTab() : null,
  }),
  component: AppsPage,
})

/**
 * The app list plus the site document's pending fields and the machines'.
 * One Apply writes every file and rebuilds once, so the bar at the foot of
 * this page has to say everything that Apply will do — not just the apps'
 * half of it.
 */
export async function fetchAppsTab() {
  const [list, site, nodesChanges] = await Promise.all([
    fetchApps(),
    fetchSiteEdit(),
    fetchNodesChangeFn(),
  ])
  return {
    ...list,
    siteChanges: siteBarFields(site.changes, site.moduleChanges),
    nodesChanges,
  }
}

function AppsPage() {
  const { tab, list, images, packages, builder } = Route.useLoaderData()

  return (
    <>
      <PageHead
        fold
        title="Apps"
        // The create flow is a page rather than a dialog: it makes a GitHub
        // round trip per repo it checks, and a checklist you can leave open
        // in a tab while you fix the repo is worth more than one that closes
        // when you click outside it. Only on the Apps tab — adding an app is
        // that tab's action, not the registries'.
        aside={
          tab === 'apps' ? (
            <Button asChild size="sm" className="ml-auto h-8">
              <Link to="/apps/new">Add an app</Link>
            </Button>
          ) : undefined
        }
      >
        What this box runs of its own, what lives on someone else's infrastructure, the two
        registries everything here is built out of, and the builder that makes the images.
      </PageHead>

      <TabBar tabs={TABS} active={tab} linkTo={(id) => ({ to: '/apps', search: { tab: id } })} />

      {list !== null && (
        <GuardedAwait
          resetKey={tab}
          slot="list"
          promise={list}
          fallback={<RowsSkeleton count={4} />}
        >
          {(data) => <AppsList data={data} />}
        </GuardedAwait>
      )}

      {images !== null && (
        <GuardedAwait
          resetKey={tab}
          slot="images"
          promise={images}
          fallback={<BoardsSkeleton spans={[8, 4, 8, 4]} />}
        >
          {(data) => <ImagesView d={data} />}
        </GuardedAwait>
      )}

      {packages !== null && (
        <GuardedAwait
          resetKey={tab}
          slot="packages"
          promise={packages}
          fallback={<BoardsSkeleton spans={[6, 6, 12]} />}
        >
          {(data) => <PackagesView d={data} />}
        </GuardedAwait>
      )}

      {builder !== null && (
        <GuardedAwait
          resetKey={tab}
          slot="builder"
          promise={builder}
          fallback={<BoardsSkeleton spans={[12, 8, 4, 12, 6, 6, 12]} />}
        >
          {(data) => <BuilderView d={data} />}
        </GuardedAwait>
      )}
    </>
  )
}
