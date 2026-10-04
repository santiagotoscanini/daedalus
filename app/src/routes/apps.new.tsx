import { createFileRoute, Link } from '@tanstack/react-router'
import { Wizard } from '../components/apps/new-wizard'
import { GuardedAwait } from '../components/error'
import { Crumbs, PageHead } from '../components/page'
import { NewAppSkeleton } from '../components/skeleton'
import { useSite } from '../lib/site-context'
import { fetchNewAppOptions } from '../server/registry'

// Adding an app.
//
// The platform half of this is one entry: nix/modules/apps turns a
// `fleet.apps.<name>` into a container, a route, DNS, a probe, a database and
// a deploy timer. An entry whose image was never published would fail the
// switch, so a new app is born awaiting its first image: committed to
// site/apps.json without a rebuild (nix makes nothing for it, and the builder
// builds it), its first build queued at once, and set up by ONE Apply when
// that build has published (lib/apps/setup.ts). The form asks where it runs,
// Lab or Public, and the app's page shows the way there.
// Step 3 below reports what the box will find when it builds the repo. It
// gates nothing: no fact about a repository is a reason to refuse a row that
// starts nothing yet.
//
// What this page deliberately cannot do: create the repo or push to it.
// Daedalus reads a repository's contents and never writes them; all it posts
// to a repo is a build's check run and Deployment (core/builds/report.ts).

export const Route = createFileRoute('/apps/new')({
  loader: () => ({ options: fetchNewAppOptions() }),
  component: NewAppPage,
})

function NewAppPage() {
  const site = useSite()
  const { options } = Route.useLoaderData()

  return (
    <>
      <Crumbs>
        <Link to="/apps" className="hover:text-foreground">
          Apps
        </Link>{' '}
        <span aria-hidden="true">›</span> new
      </Crumbs>
      <PageHead title="Add an app">
        One repository under <code>github.com/{site.owner}</code> — one the box’s GitHub App is
        installed on — becomes one entry in the registry. The container, hostname, TLS, DNS, probe,
        builds and deploy timer are all derived from it.
      </PageHead>

      <GuardedAwait resetKey="options" promise={options} fallback={<NewAppSkeleton />}>
        {(data) => <Wizard options={data} />}
      </GuardedAwait>
    </>
  )
}
