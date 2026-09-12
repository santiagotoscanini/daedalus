import { useRouter } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { rollUp } from '../../lib/ci-lines'
import type { CiRequestStatus } from '../../lib/ci-request'
import { cn } from '../../lib/cn'
import { logTime, ms, when } from '../../lib/format'
import { OWNER } from '../../lib/site'
import { toneStyle } from '../../lib/tone'
import { type AppTabData, fetchCiRequestStatus, runCiFn } from '../../server/registry'
import { usePolledStatus } from '../status'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Board, BoardGrid, Chip, Progress } from '../viz'
import { BuildsBoard } from './builds'
import {
  type AppRecord,
  BOARD_FOOT,
  CHIP,
  GHOST_BTN,
  LEDE,
  SECTION_HEAD,
  SECTION_HEAD_SMALL,
  VIZ_EMPTY,
} from './shared'

type CiData = Extract<AppTabData, { kind: 'deployments' }>['ci']
type ActivityData = Extract<AppTabData, { kind: 'deployments' }>['activity']

export function Deployments({
  app,
  td,
}: {
  app: AppRecord
  td: Extract<AppTabData, { kind: 'deployments' }>
}) {
  return (
    <>
      {/* Three items of very different widths — a repo link, a sentence, a
          button. Without wrapping, flex's default `flex-shrink: 1` squeezes
          each of them below its content instead, which is what broke the glyph
          away from the repo name onto its own line. `shrink-0` on the children
          makes them wrap as whole units. */}
      <p className="mt-0 mr-0 mb-[1.2rem] ml-0 flex flex-wrap items-center gap-x-[1.1rem] gap-y-[0.6rem] font-mono text-[0.82rem] [&>*]:shrink-0">
        {app.sourceMode === 'local' ? (
          <>
            <span className="text-(--text-muted)">⎇ stacks/{app.name}/app</span>
            <span className="text-(--text-muted)">source is live, nothing to deploy</span>
          </>
        ) : (
          <>
            <a href={`https://github.com/${OWNER}/${app.name}`} target="_blank" rel="noreferrer">
              ⎇ {OWNER}/{app.name}
            </a>
            <span className="text-(--text-muted)">
              {app.buildOnBox ? 'builds run on this box' : 'builds run on self-hosted runners'}
            </span>
            <span className="ml-auto">
              <RunCiButton repo={app.name} publish={td.publish} />
              <Button asChild variant="outline" size="sm" className={GHOST_BTN}>
                <a
                  href={`https://github.com/${OWNER}/${app.name}/actions`}
                  target="_blank"
                  rel="noreferrer"
                  className="hover:no-underline"
                >
                  ↗ GitHub Actions
                </a>
              </Button>
            </span>
          </>
        )}
      </p>

      {app.sourceMode !== 'local' && (
        <div className="mb-[0.8rem]">
          <BoardGrid>
            <BuildsBoard
              app={app.name}
              initial={td.builds}
              buildOnBox={app.buildOnBox}
              linked={app.githubRepoId !== null}
            />
          </BoardGrid>
        </div>
      )}

      {app.sourceMode !== 'local' && <Runners ci={td.ci} activity={td.activity} />}

      {td.deployments.length === 0 ? (
        <p className={LEDE}>
          {app.sourceMode === 'local'
            ? 'Local-source apps have no deploy history. The running code is the working tree.'
            : 'No deploys recorded yet. History starts from the first deploy where the image digest actually moved.'}
        </p>
      ) : (
        <>
          <h2 className={SECTION_HEAD}>
            Deploy history
            <small className={SECTION_HEAD_SMALL}>
              only the runs where the digest actually moved
            </small>
          </h2>
          {/* The rail is the list's own ::before, inset top and bottom so it
              starts and ends at the first and last node rather than running
              past them. */}
          <ol className="relative m-0 list-none p-0 pl-6 before:absolute before:top-3 before:bottom-3 before:left-[5px] before:w-px before:bg-border before:content-['']">
            {td.deployments.map((d) => (
              <li key={d.id} className="relative mb-[0.6rem]">
                <span
                  className={cn(
                    'absolute top-[1.15rem] -left-6 size-[11px] rounded-full border-2 border-background bg-background shadow-[0_0_0_1.5px_var(--tone)]',
                    d.isCurrent && 'bg-(--tone)',
                  )}
                  style={toneStyle(
                    d.isCurrent
                      ? 'accent'
                      : d.result === 'ok'
                        ? 'ok'
                        : d.result === 'failed'
                          ? 'bad'
                          : 'muted',
                  )}
                />
                <div
                  className={cn(
                    'rounded-lg border border-(--border-soft) bg-(--panel) px-[1.05rem] py-[0.8rem]',
                    d.isCurrent &&
                      'border-primary/40 bg-[color-mix(in_srgb,var(--brand)_6%,var(--panel))]',
                  )}
                >
                  <div className="flex flex-wrap items-center gap-x-[0.85rem] gap-y-[0.4rem]">
                    <code className="text-[0.95rem] font-semibold">
                      {d.shortRevision ?? d.digest.slice(0, 12)}
                    </code>
                    {d.isCurrent ? (
                      <Badge variant="warning" className={cn(CHIP, 'ml-auto')}>
                        current
                      </Badge>
                    ) : d.result === 'ok' ? (
                      <Badge variant="success" className={cn(CHIP, 'ml-auto')}>
                        success
                      </Badge>
                    ) : (
                      <Badge
                        variant="outline"
                        className={cn(CHIP, 'ml-auto border-danger/45 text-danger')}
                      >
                        failed
                      </Badge>
                    )}
                    {d.commitUrl ? (
                      <a href={d.commitUrl} target="_blank" rel="noreferrer">
                        view commit ↗
                      </a>
                    ) : (
                      <span className="text-(--text-muted)">
                        {d.shortRevision ? 'no source link' : 'image labels unavailable'}
                      </span>
                    )}
                  </div>
                  <div className="mt-[0.4rem] flex flex-wrap gap-[1.1rem] text-[0.78rem] text-(--dim)">
                    <span>{when(d.startedAt)}</span>
                    <span>{ms(d.durationMs)}</span>
                    <code>{d.digest.slice(0, 12)}</code>
                    {d.httpCode && <span>HTTP {d.httpCode}</span>}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </>
      )}
    </>
  )
}

/**
 * The self-hosted runner for this app, and what it is doing.
 *
 * One runner per app and it is EPHEMERAL — it takes a single job, de-registers
 * and a fresh container replaces it. So the runner name changes every build,
 * and a brief absence between two jobs is the design working, not a fault.
 * That is why idle is drawn as the resting state rather than coloured red.
 *
 * The page re-fetches while a job is in flight. The underlying snapshot is
 * rewritten every 30s by gha-ci-snapshot, so polling faster than that would
 * only re-read the same file.
 */
function Runners({ ci, activity }: { ci: CiData; activity: ActivityData }) {
  const router = useRouter()
  const job = ci.activeJobs[0] ?? null
  const busy = job !== null || ci.runners.some((r) => r.busy)

  useEffect(() => {
    if (!busy) return
    const t = setInterval(() => {
      void router.invalidate()
    }, 15_000)
    return () => {
      clearInterval(t)
    }
  }, [busy, router])

  const rolled = rollUp(activity)

  return (
    <BoardGrid>
      <Board
        title="Runner"
        icon="⚙"
        span={4}
        aside={
          busy ? (
            <Chip tone="warn">busy</Chip>
          ) : ci.available && ci.ok ? (
            <Chip tone="muted">idle</Chip>
          ) : null
        }
      >
        {!ci.available ? (
          <p className={VIZ_EMPTY}>
            No CI snapshot yet. <code>gha-ci-snapshot</code> has not run since boot.
          </p>
        ) : !ci.ok ? (
          <p className={cn(VIZ_EMPTY, 'text-danger')}>
            Could not reach the GitHub API on the last sweep. This is the snapshot from{' '}
            {ci.takenAt ? when(ci.takenAt) : 'an earlier run'}, not a statement about the runners.
          </p>
        ) : ci.runners.length === 0 ? (
          <p className={VIZ_EMPTY}>
            None registered. Ephemeral runners de-register between jobs, so this is normal for a few
            seconds after a build finishes.
          </p>
        ) : (
          // No card around the runner: it is the only thing in its board, so a
          // second border inside the first was drawing a box around a box. Only
          // the busy one gets a rule — idle is the resting state of an ephemeral
          // runner, and colouring it would make the normal case look like an event.
          ci.runners.map((r) => (
            <div
              key={r.name}
              className={cn(
                'min-w-0',
                r.busy && '-ml-[0.1rem] border-l-2 border-l-primary pl-[0.6rem]',
              )}
            >
              <code className="block text-[0.82rem] text-(--text-muted) [overflow-wrap:anywhere]">
                {r.name}
              </code>
              <div className="mt-2 flex flex-wrap gap-[0.3rem]">
                {r.labels.map((l) => (
                  <Badge key={l} variant="outline" className={cn(CHIP, 'text-(--dim) opacity-80')}>
                    {l}
                  </Badge>
                ))}
              </div>
              {job && job.runnerName === r.name && <JobProgress job={job} />}
            </div>
          ))
        )}

        {job && !ci.runners.some((r) => r.name === job.runnerName) && <JobProgress job={job} />}

        <p className={BOARD_FOOT}>
          One job per runner, then a fresh container replaces it. The name changes on every build,
          and a gap between two jobs is the design working.
        </p>
      </Board>

      <Board
        title="Build &amp; deploy activity"
        icon="logs"
        span={8}
        aside={<span className="text-[0.73rem] text-(--dim)">last 6 hours</span>}
      >
        {rolled.length === 0 ? (
          <p className={VIZ_EMPTY}>Nothing in the last 6 hours.</p>
        ) : (
          // Scrolls inside its own bordered box, and takes no negative margins
          // to bleed to the board's edges: a caption follows it, and margins
          // that pulled outward would pull that caption up over the last rows.
          <div className="max-h-80 overflow-auto overscroll-contain rounded-[9px] border border-(--border-soft) bg-background font-mono text-[0.75rem]">
            {rolled.map((l) => (
              <div
                key={l.key}
                className="grid grid-cols-[6.5rem_3.6rem_1fr_auto] items-baseline gap-[0.7rem] border-t border-t-(--border-soft) px-[0.7rem] py-[0.26rem] first:border-t-0"
              >
                <time className="whitespace-nowrap text-(--dim)">{logTime(l.ts)}</time>
                {/* The two halves of the pipeline read differently, so they
                    look different. */}
                <span className={l.source === 'build' ? 'text-info' : 'text-(--dim)'}>
                  {l.source}
                </span>
                <span className="min-w-0 text-(--text-muted) [overflow-wrap:anywhere]">
                  {l.line}
                </span>
                {l.count > 1 && (
                  // The repeat count for a folded run. Right-aligned in its own
                  // column so the messages stay on one left edge.
                  <span
                    className="rounded-[5px] bg-(--panel-2) px-1 tabular-nums whitespace-nowrap text-(--dim)"
                    title={`Repeated ${String(l.count)} times, most recently at ${logTime(l.lastTs)}`}
                  >
                    ×{l.count}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
        <p className={BOARD_FOOT}>
          The deploy half is the journal: pull, restart, health-check. The build half is only the
          runner announcing a job starting and finishing — it streams step output to GitHub and
          never writes it to its own stdout, so the full build log lives behind the link above.
        </p>
      </Board>
    </BoardGrid>
  )
}

/** Which step of the job is executing, and how far along it is. */
function JobProgress({ job }: { job: NonNullable<CiData['activeJobs'][number]> }) {
  const total = job.steps.length
  const done = job.steps.filter((s) => s.status === 'completed').length
  const running = job.steps.find((s) => s.status === 'in_progress')
  const pct = total > 0 ? (done / total) * 100 : 0

  return (
    <div className="mt-3 rounded-[9px] border bg-(--panel) px-3 py-[0.65rem]">
      <div className="flex flex-wrap items-baseline justify-between gap-x-[0.7rem] gap-y-[0.3rem]">
        <span className="text-[0.88rem] [font-weight:550]">⚙ {job.name}</span>
        {job.startedAt && (
          <span className="font-mono text-[0.76rem] text-(--dim)">{fmtElapsed(job.startedAt)}</span>
        )}
      </div>
      <div className="mt-[0.3rem] font-mono text-[0.8rem] text-(--text-muted) [overflow-wrap:anywhere]">
        {job.status === 'queued'
          ? 'queued, no runner has picked it up yet'
          : running
            ? `step ${String(done + 1)}/${String(total)} · ${running.name}`
            : `${String(done)}/${String(total)} steps`}
      </div>
      {total > 0 && <Progress pct={pct} tone="accent" active={running !== undefined} />}
    </div>
  )
}

/** "1m 12s" since an ISO timestamp. */
function fmtElapsed(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000))
  return s < 60 ? `${String(s)}s` : `${String(Math.floor(s / 60))}m ${String(s % 60)}s`
}

/**
 * Build and publish, from here.
 *
 * Dispatches the repo's publishing workflow — the same run a push to the
 * default branch would trigger, on the same self-hosted runner, so its progress
 * shows up in the Actions runners panel below and its image goes through the
 * normal deploy path. It is not a second way to deploy: what it does is put a
 * build on a runner, and everything after that is unchanged.
 *
 * Useful on an app that already exists (rebuild without an empty commit, and
 * watch the job), and load-bearing on one that does not yet — see the create
 * page, where it is the only way to get a first image.
 */
const CI_IDLE: CiRequestStatus = {
  id: null,
  action: null,
  repo: null,
  state: 'idle',
  detail: '',
  error: '',
  startedAt: null,
  finishedAt: null,
}

function RunCiButton({
  repo,
  publish,
}: {
  repo: string
  publish: { workflow: string | null; dispatchable: boolean }
}) {
  const router = useRouter()
  // A dispatch that never reached the host (the server function threw) —
  // distinct from a request the host took and then failed.
  const [submitError, setSubmitError] = useState<string | null>(null)
  const { status, running, start } = usePolledStatus({
    initial: CI_IDLE,
    fetch: () => fetchCiRequestStatus(),
    intervalMs: 1500,
    onSettle: () => {
      void router.invalidate()
    },
  })
  const failed = submitError !== null || status.state === 'failed'
  const message = submitError ?? (status.state === 'failed' ? status.error : status.detail)

  if (publish.workflow === null) {
    return (
      <span
        className="text-(--text-muted)"
        title="No workflow in this repo pushes to the box's registry."
      >
        no publishing workflow
      </span>
    )
  }
  if (!publish.dispatchable) {
    return (
      <span
        className="text-(--text-muted)"
        title={`${publish.workflow} has no workflow_dispatch trigger, so it can only be started by a push.`}
      >
        {publish.workflow} is not dispatchable
      </span>
    )
  }

  return (
    <span className="inline-flex items-center gap-[0.6rem] text-[0.76rem]">
      {failed && !running && (
        <span className="text-danger" title={message}>
          dispatch failed
        </span>
      )}
      {status.state === 'done' && <span className="text-success">dispatched</span>}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className={GHOST_BTN}
        disabled={running}
        title={`Dispatch ${publish.workflow}`}
        onClick={() => {
          setSubmitError(null)
          start(async () => {
            try {
              const r = await runCiFn({ data: { repo, workflow: publish.workflow ?? '' } })
              return r.id
            } catch (e: unknown) {
              setSubmitError(e instanceof Error ? e.message : String(e))
              return null
            }
          })
        }}
      >
        {running ? '⚙ dispatching…' : '⚙ Run CI'}
      </Button>
    </span>
  )
}
