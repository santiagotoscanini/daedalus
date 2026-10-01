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
// a deploy timer. An entry whose image was never published restart-loops from
// the moment it is applied, which fails the switch and reverts the Apply —
// but gating creation on an image is a deadlock, because the box only builds
// apps already in site/apps.json. The `declared` stage breaks it: an entry
// that materializes the app's database, data dir and secrets and runs
// NOTHING. So this form writes the row, always declared, and the order is
//
//   create (declared) → Apply → build → promote to internal/external → Apply
//
// with the promotion offered on the app's own page once the build lands.
// Step 3 below reports what the box will find when it builds the repo. It
// gates nothing: no fact about a repository is a reason to refuse a row that
// starts nothing.
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
