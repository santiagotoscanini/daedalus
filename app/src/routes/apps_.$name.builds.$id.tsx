import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { BuildNowButton, BuildStateChip, requesterLabel } from '../components/apps/builds'
import { BOARD_FOOT, GHOST_BTN, VIZ_EMPTY } from '../components/apps/shared'
import { GuardedAwait } from '../components/error'
import { Crumbs, PageHead } from '../components/page'
import { useNow, usePoll } from '../components/poll'
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert'
import { Button } from '../components/ui/button'
import { BarList, Board, BoardGrid, Chip, Facts, Pulse } from '../components/viz'
import { railpackSpoke } from '../lib/build-detect'
import {
  type BuildCommit,
  type BuildView,
  buildDurationMs,
  buildQueuedMs,
  buildTimeline,
  type DeployOutcome,
  frameworkName,
  isOpenBuild,
  pushedTags,
  reportFailureText,
  sha7,
  type TimelineStep,
} from '../lib/build-display'
import { cacheHitRatio } from '../lib/build-facts'
import { isActiveBuildState } from '../lib/builds'
import { bytes, DASH, ms, pct } from '../lib/format'
import { OWNER, REGISTRY_HOST } from '../lib/site'
import type { Tone } from '../lib/tone'
import {
  type BuildPageApp,
  cancelBuildFn,
  fetchBuild,
  fetchBuildApp,
  fetchBuildCommit,
  retryReportFn,
} from '../server/builds'

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

  usePoll(
    async () => {
      const b = await fetchBuild({ data: { app: name, id: build.id } }).catch(() => null)
      if (b !== null) setBuild(b)
    },
    3000,
    open,
  )

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
  const waited = buildQueuedMs(build)
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
              // Two numbers, not one "took": one build runs on this box at a
              // time, so a build can wait longer than it runs, and the wall
              // clock from hand-off hides exactly that.
              { k: 'waited in queue', v: waited === null ? DASH : ms(waited) },
              { k: 'ran for', v: took === null ? DASH : ms(took) },
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
                tagsRow(build),
                // Not "size": it is the manifest's compressed layers plus its
                // config, which is what a pull moves — an unpacked image on
                // disk is a different, larger number.
                { k: 'pull size', v: bytes(build.sizeBytes) },
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

        <Board title="Resolved tools" span={6}>
          <Tools build={build} />
        </Board>

        <Board title="Image" span={6}>
          <ImageBoard build={build} />
        </Board>

        <Board title="Railpack said" span={12}>
          <RailpackSaid build={build} />
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

/**
 * Ask the host to stop this build. One press, one confirmation — a build is
 * minutes of work and the button sits beside "Build again", which is the pair
 * that gets misclicked.
 *
 * Pressing it twice is harmless (the server re-asks for the same thing and
 * finds the row already terminal), so the busy flag is a courtesy rather than
 * a guard.
 */
function CancelBuildButton({ app, id }: { app: string; id: string }) {
  const router = useRouter()
  const [armed, setArmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = () => {
    setBusy(true)
    setError(null)
    void cancelBuildFn({ data: { app, id } })
      .then(async (r) => {
        if (!r.ok) setError(r.reason)
        await router.invalidate()
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        setBusy(false)
        setArmed(false)
      })
  }

  return (
    <span className="inline-flex flex-wrap items-center justify-end gap-[0.6rem] text-[0.76rem]">
      {error !== null && <span className="max-w-[28rem] text-right text-danger">{error}</span>}
      {armed && <span className="text-(--text-muted)">Stop it where it is?</span>}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className={GHOST_BTN}
        disabled={busy}
        title="Stops the host builder. The build ends as cancelled; nothing is published."
        onClick={() => {
          if (armed) run()
          else setArmed(true)
        }}
      >
        {busy ? 'Stopping…' : armed ? 'Yes, cancel' : 'Cancel build'}
      </Button>
    </span>
  )
}

/** Send a failed GitHub report again now; the page reloads to show what GitHub said. */
function RetryReportButton({ app, id }: { app: string; id: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = () => {
    setBusy(true)
    setError(null)
    void retryReportFn({ data: { app, id } })
      .then(async (r) => {
        if (!r.ok) setError(r.reason)
        await router.invalidate()
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        setBusy(false)
      })
  }

  return (
    <span className="mt-2 inline-flex flex-wrap items-center gap-[0.6rem] text-[0.76rem]">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className={GHOST_BTN}
        disabled={busy}
        onClick={run}
      >
        {busy ? 'Sending…' : 'Retry report'}
      </Button>
      {error !== null && <span className="text-danger">{error}</span>}
    </span>
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
  skipped: 'muted',
}

// What the right-hand column says when there is no duration to put there. A
// skipped phase says so in words: "—" beside a green build read as "passed,
// too fast to time", which is how checks that never ran came to look like
// checks that passed.
const STEP_NOTE: Partial<Record<TimelineStep['status'], string>> = {
  failed: 'failed',
  skipped: 'did not run',
}

function Step({ step }: { step: TimelineStep }) {
  return (
    <li className="flex items-center gap-[0.6rem] border-t border-(--border-soft) py-[0.4rem] text-[0.84rem] first:border-t-0 first:pt-0">
      <Pulse on={step.status === 'running'} tone={STEP_TONE[step.status]} />
      <span
        className={
          step.status === 'pending' || step.status === 'skipped'
            ? 'text-(--dim)'
            : step.status === 'failed'
              ? 'text-danger'
              : undefined
        }
      >
        {step.phase}
      </span>
      <span className="ml-auto font-mono text-[0.78rem] text-(--dim)">
        {STEP_NOTE[step.status] ?? (step.ms === null ? DASH : ms(step.ms))}
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
  const warnings = build.warnings
  return (
    <>
      <Facts
        rows={[
          // Every provider, not only the one that won: a repo Railpack read as
          // both a Node app and a static site is worth seeing as both.
          { k: 'providers', v: d.providers.length === 0 ? DASH : d.providers.join(', ') },
          { k: 'framework', v: d.framework === null ? DASH : frameworkName(d.framework) },
          { k: 'Node', v: pin(d.node) },
          { k: 'pnpm', v: pin(d.pnpm) },
          { k: 'start', v: d.startCommand === null ? DASH : <code>{d.startCommand}</code> },
          {
            k: 'apt packages',
            v: d.aptPackages.length === 0 ? 'none' : <code>{d.aptPackages.join(' ')}</code>,
          },
          {
            // Names only. A value never leaves the host, and nothing on this
            // page has ever held one.
            k: 'build secrets',
            v: d.secrets.length === 0 ? 'none' : <code>{d.secrets.join(' ')}</code>,
          },
          { k: 'Railpack', v: d.railpackVersion ?? DASH },
          { k: 'served as', v: d.spa ? 'static single-page app' : 'server' },
        ]}
      />
      {/* Only when it failed: a successful prepare is what every other row on
          this card already says, and a green "succeeded" row would be noise. */}
      {!d.success && (
        <Alert variant="destructive">
          <AlertTitle>Railpack’s detection did not succeed</AlertTitle>
          <AlertDescription>
            <p className="m-0">
              `railpack prepare` reported failure. Its own lines are under “Railpack said”.
            </p>
          </AlertDescription>
        </Alert>
      )}
      {warnings === null ? (
        // Never "no warnings": this build was judged by nobody. Every row from
        // before the engine learned to compute them reads this way, and so
        // does one whose detection is not Railpack's at all.
        <p className={BOARD_FOOT}>
          No warnings were computed for this build — it predates the checks, so this is not a clean
          bill of health.
        </p>
      ) : warnings.length > 0 ? (
        <Alert variant="warning">
          <AlertTitle>
            {warnings.length === 1 ? 'One warning' : `${String(warnings.length)} warnings`}
          </AlertTitle>
          <AlertDescription>
            <ul className="m-0 flex list-disc flex-col gap-1 pl-4">
              {warnings.map((w) => (
                <li key={`${w.code}:${w.message}`}>{w.message}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : (
        <p className={BOARD_FOOT}>Checked; no warnings.</p>
      )}
    </>
  )
}

/**
 * The `tags` row of the Result board. The agent reads back what the push left
 * on the registry; without it the tags are derived from the publish mode and
 * the sha, and the row says so rather than passing a guess off as a reading.
 */
function tagsRow(build: BuildView): { k: string; v: ReactNode } {
  const t = pushedTags(build.publish, build.sha, build.facts?.image?.tags)
  return {
    k: t.actual ? 'tags' : 'tags (expected)',
    v: (
      <span className="inline-flex flex-wrap justify-end gap-1">
        {t.tags.map((tag) => (
          <code key={tag} className="text-[0.76rem]" title={tag}>
            {tag.length > 20 ? `${tag.slice(0, tag.indexOf('-') + 8)}…` : tag}
          </code>
        ))}
      </span>
    ),
  }
}

/**
 * Every tool mise resolved and who chose its version. The source column is the
 * one that earns the board: "railpack default" and "package.json > engines"
 * look identical in a build log and mean entirely different things the next
 * time the image is rebuilt.
 */
function Tools({ build }: { build: BuildView }) {
  const packages = build.detection?.packages ?? []
  if (packages.length === 0) {
    return <p className={VIZ_EMPTY}>Railpack resolved no tools for this build.</p>
  }
  return (
    <ul className="m-0 list-none p-0">
      {packages.map((p) => (
        <li
          key={p.name}
          className="grid grid-cols-[7rem_1fr] items-baseline gap-x-3 gap-y-[0.1rem] border-t border-(--border-soft) py-[0.45rem] text-[0.84rem] first:border-t-0 first:pt-0"
        >
          <code className="truncate" title={p.name}>
            {p.name}
          </code>
          <span className="min-w-0">
            <code>{p.version}</code>
            {p.requested !== null && p.requested !== p.version && (
              <span className="text-(--dim)"> asked for {p.requested}</span>
            )}
          </span>
          <span />
          <span className="min-w-0 text-[0.78rem] text-(--dim) [overflow-wrap:anywhere]">
            from {p.source}
          </span>
        </li>
      ))}
    </ul>
  )
}

/**
 * What the push produced, as the agent read it back off the manifest: how many
 * layers, how big each one is compressed, and what the cache did. A layer list
 * is the fastest way to see a build that started shipping node_modules.
 */
function ImageBoard({ build }: { build: BuildView }) {
  const image = build.facts?.image ?? null
  const run = build.facts?.run ?? null
  if (image === null && run === null) {
    return (
      <p className={VIZ_EMPTY}>
        {build.digest === null
          ? 'No image was published.'
          : 'The host agent recorded no image facts for this build.'}
      </p>
    )
  }
  const ratio = cacheHitRatio(run)
  const rows: { k: string; v: ReactNode }[] = []
  if (image !== null) {
    if (image.layers !== null) rows.push({ k: 'layers', v: String(image.layers) })
    if (image.configSize !== null) rows.push({ k: 'config', v: bytes(image.configSize) })
    if (image.mediaType !== null) {
      rows.push({ k: 'media type', v: <code className="text-[0.72rem]">{image.mediaType}</code> })
    }
  }
  if (run !== null) {
    if (run.runner !== null) rows.push({ k: 'runner', v: <code>{run.runner}</code> })
    if (run.stepsTotal !== null) {
      rows.push({
        k: 'steps cached',
        v: `${String(run.stepsCached ?? 0)} of ${String(run.stepsTotal)}${
          ratio === null ? '' : ` (${pct(ratio * 100)})`
        }`,
      })
    }
    if (run.cacheImported !== null || run.cacheExported !== null) {
      rows.push({
        k: 'cache',
        v: [
          run.cacheImported === null ? null : run.cacheImported ? 'imported' : 'cold',
          run.cacheExported === null ? null : run.cacheExported ? 'exported' : 'not exported',
        ]
          .filter((s): s is string => s !== null)
          .join(', '),
      })
    }
    if (run.secretsHash !== null) {
      // The fingerprint, never a value: it is here so two builds can be told
      // apart by whether their secrets changed.
      rows.push({
        k: 'secrets hash',
        v: <code title={run.secretsHash}>{run.secretsHash.slice(0, 12)}</code>,
      })
    }
  }
  const layers = image?.layerSizes ?? []
  return (
    <>
      {rows.length > 0 && <Facts list rows={rows} />}
      {layers.length > 0 && (
        <BarList
          items={layers.map((size, i) => ({
            label: `layer ${String(i + 1)}`,
            value: size,
            display: bytes(size),
          }))}
          tone="info"
        />
      )}
      {layers.length > 0 && (
        <p className={BOARD_FOOT}>
          Compressed sizes from the manifest — these plus the config are the pull size above.
        </p>
      )}
    </>
  )
}

/**
 * Railpack's own lines, verbatim. Deliberately overlapping the warnings above:
 * this is the transcript, warnings and errors and the standing config-format
 * notice included, while the warnings list is the judgement made of it.
 */
function RailpackSaid({ build }: { build: BuildView }) {
  const d = build.detection
  const spoken = d === null ? [] : railpackSpoke(d)
  if (spoken.length === 0) {
    return (
      <p className={VIZ_EMPTY}>
        {d === null
          ? 'Railpack did not look at this build.'
          : 'Railpack logged nothing above info level.'}
      </p>
    )
  }
  return (
    <ul className="m-0 list-none p-0">
      {spoken.map((l) => (
        <li
          key={`${l.level}:${l.message}`}
          className="flex flex-wrap items-baseline gap-x-[0.6rem] gap-y-[0.15rem] border-t border-(--border-soft) py-[0.45rem] text-[0.84rem] first:border-t-0 first:pt-0"
        >
          <Chip tone={LOG_TONE[l.level.toLowerCase()] ?? 'muted'}>{l.level.toLowerCase()}</Chip>
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{l.message}</span>
          {l.docsPath !== null && (
            <a
              href={docsUrl(l.docsPath)}
              target="_blank"
              rel="noreferrer"
              className="text-[0.78rem]"
            >
              docs ↗
            </a>
          )}
        </li>
      ))}
    </ul>
  )
}

const LOG_TONE: Record<string, Tone> = {
  error: 'bad',
  warn: 'warn',
  deprecation: 'warn',
  suggestion: 'info',
}

/**
 * Railpack names its documentation by path (`/config/…`), against its own site.
 * An absolute URL is passed through, so a version that starts writing one does
 * not turn into `https://railpack.com/https://…`.
 */
const docsUrl = (path: string): string =>
  /^https?:\/\//i.test(path)
    ? path
    : `https://railpack.com${path.startsWith('/') ? '' : '/'}${path}`
