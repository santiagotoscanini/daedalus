import { createFileRoute, Link } from '@tanstack/react-router'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { BuildNowButton, BuildStateChip, requesterLabel, useNow } from '../components/apps/builds'
import { BOARD_FOOT, VIZ_EMPTY } from '../components/apps/shared'
import { GuardedAwait } from '../components/error'
import { Crumbs, PageHead } from '../components/page'
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert'
import { Button } from '../components/ui/button'
import { Board, BoardGrid, Chip, Facts, Pulse } from '../components/viz'
import {
  type BuildCommit,
  type BuildView,
  buildDurationMs,
  buildTags,
  buildTimeline,
  type DeployOutcome,
  frameworkName,
  isOpenBuild,
  sha7,
  type TimelineStep,
} from '../lib/build-display'
import { bytes, DASH, ms } from '../lib/format'
import { OWNER, REGISTRY_HOST } from '../lib/site'
import type { Tone } from '../lib/tone'
import { type BuildPageApp, fetchBuild, fetchBuildApp, fetchBuildCommit } from '../server/builds'

// One build on the box: what was built, how it went phase by phase, what
// Railpack made of the repo, and the log. GitHub's check run links here
// (core/builds/report.ts `details_url`).
//
// Trailing `_` on `apps`: apps.$name.tsx renders no <Outlet/>, so this path
// must not nest under it. The rail still treats it as part of the app
// (__root.tsx useAppRailContext).

const APP_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/

export const Route = createFileRoute('/apps_/$name/builds/$id')({
  loader: async ({ params }) => {
    if (!APP_NAME_RE.test(params.name)) return { app: null, build: null, commit: null }
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

function AppCrumbs({
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

/** A moment as UTC minutes: the same string on the server and in the browser. */
const at = (iso: string | null): string =>
  iso === null ? DASH : `${iso.slice(0, 16).replace('T', ' ')} UTC`

const LOG_BOX =
  'm-0 max-h-[36rem] overflow-auto overscroll-contain rounded-[9px] border border-(--border-soft) bg-background p-3 font-mono text-[0.74rem] leading-[1.5] whitespace-pre text-(--text-muted)'

function BuildDetail({
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
  const [build, setBuild] = useState(initial)
  useEffect(() => {
    setBuild(initial)
  }, [initial])

  const open = isOpenBuild(build.state)
  const now = useNow(open)

  useEffect(() => {
    if (!open) return
    const t = setInterval(() => {
      void fetchBuild({ data: { app: name, id: build.id } })
        .then((b) => {
          if (b !== null) setBuild(b)
        })
        .catch(() => {})
    }, 3000)
    return () => {
      clearInterval(t)
    }
  }, [open, name, build.id])

  // Follow the log's end while it grows, unless the reader has scrolled up.
  const logRef = useRef<HTMLPreElement>(null)
  const follow = useRef(true)
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the text changes, by design.
  useEffect(() => {
    const el = logRef.current
    if (el !== null && follow.current) el.scrollTop = el.scrollHeight
  }, [build.log.text])

  const repo = `${OWNER}/${name}`
  const commitUrl = `https://github.com/${repo}/commit/${build.sha}`
  const took = open && now === null ? null : buildDurationMs(build, now ?? 0)
  const refusal =
    app === null
      ? 'No app by that name.'
      : !app.buildOnBox
        ? 'Box builds are off for this app.'
        : !app.linked
          ? 'Waiting for the sweep to link the repo.'
          : undefined

  return (
    <>
      <AppCrumbs name={name} known={app !== null}>
        build {sha7(build.sha)}
      </AppCrumbs>
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
        <span className="ml-auto">
          <BuildNowButton
            app={name}
            label="Build again"
            disabled={refusal !== undefined}
            reason={refusal ?? 'Builds the default branch’s tip, even if it has built before.'}
          />
        </span>
      </div>

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

      <BoardGrid>
        <Board title="Commit" span={6}>
          <Facts
            list
            rows={[
              {
                k: 'commit',
                v: (
                  <a href={commitUrl} target="_blank" rel="noreferrer" className="font-mono">
                    {sha7(build.sha)} ↗
                  </a>
                ),
              },
              {
                k: 'message',
                v: <CommitField commit={commit} pick={(c) => c.message.split('\n')[0] ?? ''} />,
              },
              { k: 'author', v: <CommitField commit={commit} pick={(c) => c.author ?? ''} /> },
              {
                k: 'requested by',
                v: build.requestedBy === 'operator' ? requesterLabel(build) : build.requestedBy,
              },
              {
                k: 'strategy',
                v: (
                  <span className="font-mono">
                    {build.strategy}
                    {build.resolvedStrategy !== null && build.resolvedStrategy !== build.strategy
                      ? ` → ${build.resolvedStrategy}`
                      : ''}
                  </span>
                ),
              },
              { k: 'publish', v: build.publish },
              { k: 'queued', v: at(build.createdAt) },
              { k: 'started', v: at(build.startedAt) },
              { k: 'took', v: took === null ? DASH : ms(took) },
            ]}
          />
        </Board>

        <Board title="Result" span={6}>
          {build.digest === null ? (
            <p className={VIZ_EMPTY}>
              {open || build.state === 'queued'
                ? 'Nothing published yet.'
                : 'Nothing was published.'}
            </p>
          ) : (
            <Facts
              list
              rows={[
                {
                  k: 'digest',
                  v: (
                    <code title={build.digest}>
                      {build.digest.replace('sha256:', '').slice(0, 12)}
                    </code>
                  ),
                },
                {
                  k: 'image',
                  v: <code title={build.imageRef ?? undefined}>{`${REGISTRY_HOST}/${name}`}</code>,
                },
                {
                  k: 'tags',
                  v: (
                    <span className="inline-flex flex-wrap justify-end gap-1">
                      {buildTags(build.publish, build.sha).map((t) => (
                        <code key={t} className="text-[0.76rem]" title={t}>
                          {t.length > 20 ? `${t.slice(0, t.indexOf('-') + 8)}…` : t}
                        </code>
                      ))}
                    </span>
                  ),
                },
                { k: 'size', v: bytes(build.sizeBytes) },
              ]}
            />
          )}
          <Facts list rows={[{ k: 'deploy', v: <Outcome outcome={build.deploy} /> }]} />
          {app !== null && app.stage !== 'off' && build.deploy.kind === 'deployed' && (
            <p className="m-0 text-[0.82rem]">
              <a href={`https://${app.effectiveHostname}`} target="_blank" rel="noreferrer">
                ↗ {app.effectiveHostname}
              </a>
            </p>
          )}
        </Board>

        <Board title="Phases" span={6}>
          <ol className="m-0 list-none p-0">
            {buildTimeline(build.state, build.timings).map((s) => (
              <Step key={s.phase} step={s} />
            ))}
          </ol>
          {open && build.phase !== '' && <p className={BOARD_FOOT}>Now: {build.phase}</p>}
        </Board>

        <Board title="Checks" span={6}>
          <Checks build={build} />
        </Board>

        <Board title="Detection" span={12}>
          <Detection build={build} />
        </Board>

        <Board title="Log" span={12} aside={open ? <Chip tone="info">following</Chip> : undefined}>
          {build.log.available ? (
            <pre
              ref={logRef}
              className={LOG_BOX}
              onScroll={(e) => {
                const el = e.currentTarget
                follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
              }}
            >
              {build.log.text}
            </pre>
          ) : (
            <p className={VIZ_EMPTY}>
              {build.state === 'queued'
                ? 'Queued. The log starts when the host picks the build up.'
                : 'The host has no log for this build.'}
            </p>
          )}
          <p className={BOARD_FOOT}>
            {build.log.truncated ? `The last 64 KB of ${bytes(build.log.sizeBytes)}. ` : ''}
            Credentials are redacted twice: by the host as it writes the log, and here as it is
            read.
          </p>
        </Board>
      </BoardGrid>
    </>
  )
}

function CommitField({
  commit,
  pick,
}: {
  commit: Promise<BuildCommit | null> | null
  pick: (c: BuildCommit) => string
}) {
  const none = <span className="text-(--dim)">{DASH}</span>
  if (commit === null) return none
  return (
    <GuardedAwait resetKey="commit" promise={commit} fallback={none}>
      {(c) =>
        c === null || pick(c) === '' ? (
          none
        ) : (
          <span className="[overflow-wrap:anywhere]">{pick(c)}</span>
        )
      }
    </GuardedAwait>
  )
}

function Outcome({ outcome }: { outcome: DeployOutcome }) {
  switch (outcome.kind) {
    case 'none':
      return <span className="text-(--dim)">{DASH}</span>
    case 'candidate':
      return <span>candidate, not deployed</span>
    case 'pinned':
      return (
        <span>
          {outcome.why === 'frozen'
            ? 'built, not deployed: auto-deploy is off'
            : 'built, not deployed: the app is held on an image override'}
        </span>
      )
    case 'waiting':
      return <span className="text-(--text-muted)">waiting for the deploy</span>
    case 'deployed':
      return (
        <span className={outcome.result === 'ok' ? 'text-success' : 'text-danger'}>
          deployed, {outcome.result}
          {outcome.httpCode !== null ? ` (HTTP ${outcome.httpCode})` : ''} at {at(outcome.at)}
        </span>
      )
  }
}

const STEP_TONE: Record<TimelineStep['status'], Tone> = {
  done: 'ok',
  running: 'info',
  failed: 'bad',
  pending: 'muted',
}

function Step({ step }: { step: TimelineStep }) {
  return (
    <li className="flex items-center gap-[0.6rem] border-t border-(--border-soft) py-[0.4rem] text-[0.84rem] first:border-t-0 first:pt-0">
      <Pulse on={step.status === 'running'} tone={STEP_TONE[step.status]} />
      <span
        className={
          step.status === 'pending'
            ? 'text-(--dim)'
            : step.status === 'failed'
              ? 'text-danger'
              : undefined
        }
      >
        {step.phase}
      </span>
      <span className="ml-auto font-mono text-[0.78rem] text-(--dim)">
        {step.status === 'failed' ? 'failed' : step.ms === null ? DASH : ms(step.ms)}
      </span>
    </li>
  )
}

function Checks({ build }: { build: BuildView }) {
  const checks = build.checks
  if (checks === null || (checks.ran.length === 0 && checks.failed === null)) {
    return (
      <p className={VIZ_EMPTY}>
        {isOpenBuild(build.state) ? 'No checks have run yet.' : 'No checks ran.'}
      </p>
    )
  }
  const names =
    checks.failed !== null && !checks.ran.includes(checks.failed)
      ? [...checks.ran, checks.failed]
      : checks.ran
  return (
    <>
      <ol className="m-0 list-none p-0">
        {names.map((c) => {
          const failed = c === checks.failed
          return (
            <li
              key={c}
              className="flex items-center gap-[0.6rem] border-t border-(--border-soft) py-[0.4rem] text-[0.84rem] first:border-t-0 first:pt-0"
            >
              <span aria-hidden="true" className={failed ? 'text-danger' : 'text-success'}>
                {failed ? '✕' : '✓'}
              </span>
              <code className={failed ? 'text-danger' : undefined}>{c}</code>
              {failed && <span className="ml-auto text-[0.78rem] text-danger">failed</span>}
            </li>
          )
        })}
      </ol>
      <p className={BOARD_FOOT}>
        {checks.failed === null
          ? `${String(names.length)} ran, none failed.`
          : `${checks.failed} failed, so nothing was built past it.`}
      </p>
    </>
  )
}

function Detection({ build }: { build: BuildView }) {
  const d = build.detection
  if (d === null) {
    return (
      <p className={VIZ_EMPTY}>
        {build.resolvedStrategy === 'dockerfile'
          ? 'Built from the repo’s Dockerfile, so Railpack did not look at it.'
          : isOpenBuild(build.state) || build.state === 'queued'
            ? 'Railpack has not looked at the repo yet.'
            : 'No detection was recorded for this build.'}
      </p>
    )
  }
  const pin = (p: typeof d.node) =>
    p === null ? (
      DASH
    ) : (
      <span>
        <code>{p.version}</code> <span className="text-(--dim)">from {p.source}</span>
      </span>
    )
  return (
    <>
      <Facts
        rows={[
          { k: 'provider', v: d.provider ?? DASH },
          { k: 'framework', v: d.framework === null ? DASH : frameworkName(d.framework) },
          { k: 'Node', v: pin(d.node) },
          { k: 'pnpm', v: pin(d.pnpm) },
          { k: 'start', v: d.startCommand === null ? DASH : <code>{d.startCommand}</code> },
          {
            k: 'apt packages',
            v: d.aptPackages.length === 0 ? 'none' : <code>{d.aptPackages.join(' ')}</code>,
          },
          { k: 'Railpack', v: d.railpackVersion ?? DASH },
          { k: 'served as', v: d.spa ? 'static single-page app' : 'server' },
        ]}
      />
      {build.warnings.length > 0 ? (
        <Alert variant="warning">
          <AlertTitle>
            {build.warnings.length === 1
              ? 'One warning'
              : `${String(build.warnings.length)} warnings`}
          </AlertTitle>
          <AlertDescription>
            <ul className="m-0 flex list-disc flex-col gap-1 pl-4">
              {build.warnings.map((w) => (
                <li key={`${w.code}:${w.message}`}>{w.message}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : (
        <p className={BOARD_FOOT}>No warnings.</p>
      )}
    </>
  )
}
