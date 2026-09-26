import { createFileRoute } from '@tanstack/react-router'
import { AppCrumbs, BuildDetail } from '../components/build/detail'
import { PageHead } from '../components/page'
import { isAppName } from '../lib/hostname'
import { fetchBuild, fetchBuildApp, fetchBuildCommit } from '../server/builds'

// One build on the box: what was built, how it went phase by phase, what
// Railpack made of the repo, and the log. GitHub's check run links here
// (core/builds/report.ts `details_url`). The page itself is
// components/build/detail.tsx; this file loads it.
//
// Trailing `_` on `apps`: apps.$name.tsx renders no <Outlet/>, so this path
// must not nest under it. The rail still treats it as part of the app
// (components/shell/app-rail.tsx useAppRailContext).

export const Route = createFileRoute('/apps_/$name/builds/$id')({
  loader: async ({ params }) => {
    // The server functions refuse a name that is not an app's (lib/hostname
    // isAppName), and a hand-edited URL deserves this page's own "no such
    // build", not an error boundary.
    if (!isAppName(params.name)) return { app: null, build: null, commit: null }
    const [app, build] = await Promise.all([
      fetchBuildApp({ data: { app: params.name } }),
      fetchBuild({ data: { app: params.name, id: params.id } }),
    ])
    return {
      app,
      build,
      // Asks GitHub, so it streams in behind the page.
      commit:
        build === null ? null : fetchBuildCommit({ data: { app: params.name, sha: build.sha } }),
    }
  },
  component: BuildPage,
})

function BuildPage() {
  const { app, build, commit } = Route.useLoaderData()
  const { name } = Route.useParams()
  if (build === null) return <NoSuchBuild name={name} known={app !== null} />
  return <BuildDetail key={build.id} name={name} app={app} initial={build} commit={commit} />
}

function NoSuchBuild({ name, known }: { name: string; known: boolean }) {
  return (
    <>
      <AppCrumbs name={name} known={known} />
      <PageHead title="No such build">
        {known
          ? `${name} has no build with that id. Its recent builds are on the Deployments tab.`
          : 'No app by that name is in the registry.'}
      </PageHead>
    </>
  )
}
