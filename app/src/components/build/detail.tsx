import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { type BuildCommit, type BuildView, reportFailureText, sha7 } from '../../lib/build-display'
import { isActiveBuildState } from '../../lib/builds'
import { appRepo } from '../../lib/site'
import { useSite } from '../../lib/site-context'
import type { BuildPageApp } from '../../server/builds'
import { BuildNowButton, BuildStateChip, requesterLabel } from '../apps/builds'
import { Crumbs, PageHead } from '../page'
import { Alert, AlertDescription, AlertTitle } from '../ui/alert'
import { Button } from '../ui/button'
import { Board, BoardGrid } from '../viz'
import { CancelBuildButton, RetryReportButton } from './actions'
import {
  at,
  Checks,
  CommitBoard,
  Detection,
  ImageBoard,
  LogBoard,
  PhasesBoard,
  RailpackSaid,
  ResultBoard,
  Tools,
} from './boards'
import { useLiveBuild } from './use-live-build'

// One build, as the build page draws it: the crumbs and head, the row of links
// and buttons, the two alerts (the build failed; GitHub was not told), and the
// boards. The route (routes/apps_.$name.builds.$id.tsx) loads the data and
// mounts this keyed by the build's id.

export function AppCrumbs({
  name,
  known,
  children,
}: {
  name: string
  known: boolean
  children?: ReactNode
}) {
  return (
    <Crumbs>
      <Link to="/apps" className="hover:text-foreground">
        Apps
      </Link>
      {known && (
        <>
          {' '}
          <span aria-hidden="true">›</span>{' '}
          <Link
            to="/apps/$name"
            params={{ name }}
            search={{ tab: 'deployments' }}
            className="hover:text-foreground"
          >
            {name}
          </Link>
        </>
      )}
      {children !== undefined && (
        <>
          {' '}
          <span aria-hidden="true">›</span> {children}
        </>
      )}
    </Crumbs>
  )
}

export function BuildDetail({
  name,
  app,
  initial,
  commit,
}: {
  name: string
  app: BuildPageApp | null
  initial: BuildView
  commit: Promise<BuildCommit | null> | null
}) {
  const site = useSite()
  const { build, open, now } = useLiveBuild(name, initial)
  const repo = appRepo(site, name)
  const commitUrl = `https://github.com/${repo}/commit/${build.sha}`

  return (
    <>
      <AppCrumbs name={name} known={app !== null}>
        build {sha7(build.sha)}
      </AppCrumbs>
      <BuildHead build={build} open={open} />
      <BuildActions name={name} app={app} build={build} repo={repo} commitUrl={commitUrl} />
      <BuildAlerts name={name} build={build} open={open} />

      <BoardGrid>
        <CommitBoard build={build} commit={commit} commitUrl={commitUrl} open={open} now={now} />
        <ResultBoard name={name} app={app} build={build} open={open} />
        <PhasesBoard build={build} open={open} />

        <Board title="Checks" span={6}>
          <Checks build={build} />
        </Board>

        <Board title="Detection" span={12}>
          <Detection build={build} />
        </Board>

        <Board title="Resolved tools" span={6}>
          <Tools build={build} />
        </Board>

        <Board title="Image" span={6}>
          <ImageBoard build={build} />
        </Board>

        <Board title="Railpack said" span={12}>
          <RailpackSaid build={build} />
        </Board>

        <LogBoard build={build} open={open} />
      </BoardGrid>
    </>
  )
}

function BuildHead({ build, open }: { build: BuildView; open: boolean }) {
  return (
    <PageHead
      title={
        <>
          Build <code className="font-semibold">{sha7(build.sha)}</code>
        </>
      }
      aside={
        <span className="inline-flex items-baseline gap-2">
          <BuildStateChip state={build.state} />
          {open && build.phase !== '' && (
            <span className="text-(--dim) text-sm">{build.phase}</span>
          )}
        </span>
      }
    >
      Asked for by {requesterLabel(build)} at {at(build.createdAt)}.
      {build.publish === 'candidate' && ' A candidate: pushed, never deployed.'}
    </PageHead>
  )
}

/** The links out to GitHub on the left; stop and build again on the right. */
function BuildActions({
  name,
  app,
  build,
  repo,
  commitUrl,
}: {
  name: string
  app: BuildPageApp | null
  build: BuildView
  repo: string
  commitUrl: string
}) {
  const running = isActiveBuildState(build.state)
  const refusal =
    app === null
      ? 'No app by that name.'
      : !app.buildOnBox
        ? 'Box builds are off for this app.'
        : !app.linked
          ? 'Waiting for the sweep to link the repo.'
          : undefined

  return (
    <div className="mb-5 flex flex-wrap items-center gap-2">
      <Button asChild variant="outline" size="sm">
        <a href={commitUrl} target="_blank" rel="noreferrer">
          Commit ↗
        </a>
      </Button>
      {build.checkRunId !== null && (
        <Button asChild variant="outline" size="sm">
          <a
            href={`https://github.com/${repo}/runs/${String(build.checkRunId)}`}
            target="_blank"
            rel="noreferrer"
          >
            Check run ↗
          </a>
        </Button>
      )}
      {build.deploymentId !== null && (
        <Button asChild variant="outline" size="sm">
          <a href={`https://github.com/${repo}/deployments`} target="_blank" rel="noreferrer">
            Deployment ↗
          </a>
        </Button>
      )}
      <span className="ml-auto inline-flex flex-wrap items-center justify-end gap-2">
        {/* Only while the host actually has it: a queued build has nothing
            running to stop, and a finished one has nothing to stop at all. */}
        {running && <CancelBuildButton app={name} id={build.id} />}
        <BuildNowButton
          app={name}
          label="Build again"
          disabled={refusal !== undefined}
          reason={refusal ?? 'Builds the default branch’s tip, even if it has built before.'}
        />
      </span>
    </div>
  )
}

/** Why the build did not succeed, and whether GitHub has heard about it. */
function BuildAlerts({ name, build, open }: { name: string; build: BuildView; open: boolean }) {
  return (
    <>
      {build.error !== null && (
        <Alert variant="destructive" className="mb-4">
          <AlertTitle>
            {build.state === 'failed' ? 'The build failed' : `The build is ${build.state}`}
          </AlertTitle>
          <AlertDescription>
            <p className="m-0 font-mono text-[0.8rem] [overflow-wrap:anywhere]">{build.error}</p>
          </AlertDescription>
        </Alert>
      )}

      {build.reportFailure !== null && (
        <Alert variant="warning" className="mb-4">
          <AlertTitle>
            {open ? 'GitHub has not heard about this build' : 'GitHub has not heard how it ended'}
          </AlertTitle>
          <AlertDescription>
            <p className="m-0">{reportFailureText(build.reportFailure)}</p>
            <RetryReportButton app={name} id={build.id} />
          </AlertDescription>
        </Alert>
      )}
    </>
  )
}
