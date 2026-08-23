import { useRouter } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { rollUp } from '../../lib/ci-lines'
import type { CiRequestStatus } from '../../lib/ci-request'
import { logTime, ms, when } from '../../lib/format'
import { OWNER } from '../../lib/site'
import { type AppTabData, fetchCiRequestStatus, runCiFn } from '../../server/registry'
import { usePolledStatus } from '../status'
import { Board, BoardGrid, Chip, Progress } from '../viz'
import type { AppRecord } from './shared'

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
      <p className="deploy-meta">
        {app.sourceMode === 'local' ? (
          <>
            <span className="muted">⎇ stacks/{app.name}/app</span>
            <span className="muted">source is live, nothing to deploy</span>
          </>
        ) : (
          <>
            <a href={`https://github.com/${OWNER}/${app.name}`} target="_blank" rel="noreferrer">
              ⎇ {OWNER}/{app.name}
            </a>
            <span className="muted">builds run on self-hosted runners</span>
            <span className="deploy-actions">
              <RunCiButton repo={app.name} publish={td.publish} />
              <a
                href={`https://github.com/santiagotoscanini/${app.name}/actions`}
                target="_blank"
                rel="noreferrer"
                className="btn btn-ghost"
              >
                ↗ GitHub Actions
              </a>
            </span>
          </>
        )}
      </p>

      {app.sourceMode !== 'local' && <Runners ci={td.ci} activity={td.activity} />}

      {td.deployments.length === 0 ? (
        <p className="lede">
          {app.sourceMode === 'local'
            ? 'Local-source apps have no deploy history. The running code is the working tree.'
            : 'No deploys recorded yet. History starts from the first deploy where the image digest actually moved.'}
        </p>
      ) : (
        <>
          <h2 className="section-head">
            Deploy history
            <small>only the runs where the digest actually moved</small>
          </h2>
          <ol className="timeline">
            {td.deployments.map((d) => (
              <li key={d.id} className={d.isCurrent ? 'current' : d.result}>
                <span className={`node node-${d.isCurrent ? 'current' : d.result}`} />
                <div className={d.isCurrent ? 'deploy-card is-current' : 'deploy-card'}>
                  <div className="deploy-head">
                    <code className="deploy-rev">{d.shortRevision ?? d.digest.slice(0, 12)}</code>
                    <span
                      className={
                        d.isCurrent
                          ? 'chip chip-warn'
                          : d.result === 'ok'
                            ? 'chip chip-live'
                            : 'chip chip-bad'
                      }
                    >
                      {d.isCurrent ? 'current' : d.result === 'ok' ? 'success' : 'failed'}
                    </span>
                    {d.commitUrl ? (
                      <a href={d.commitUrl} target="_blank" rel="noreferrer">
                        view commit ↗
                      </a>
                    ) : (
                      <span className="muted">
                        {d.shortRevision ? 'no source link' : 'image labels unavailable'}
                      </span>
                    )}
                  </div>
                  <div className="deploy-sub">
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
          <p className="viz-empty">
            No CI snapshot yet. <code>gha-ci-snapshot</code> has not run since boot.
          </p>
        ) : !ci.ok ? (
          <p className="viz-empty text-bad">
            Could not reach the GitHub API on the last sweep. This is the snapshot from{' '}
            {ci.takenAt ? when(ci.takenAt) : 'an earlier run'}, not a statement about the runners.
          </p>
        ) : ci.runners.length === 0 ? (
          <p className="viz-empty">
            None registered. Ephemeral runners de-register between jobs, so this is normal for a few
            seconds after a build finishes.
          </p>
        ) : (
          ci.runners.map((r) => (
            <div key={r.name} className={r.busy ? 'runner runner-busy' : 'runner'}>
              <code className="runner-name">{r.name}</code>
              <div className="runner-labels">
                {r.labels.map((l) => (
                  <span key={l} className="chip chip-muted">
                    {l}
                  </span>
                ))}
              </div>
              {job && job.runnerName === r.name && <JobProgress job={job} />}
            </div>
          ))
        )}

        {job && !ci.runners.some((r) => r.name === job.runnerName) && <JobProgress job={job} />}

        <p className="board-foot">
          One job per runner, then a fresh container replaces it. The name changes on every build,
          and a gap between two jobs is the design working.
        </p>
      </Board>

      <Board
        title="Build &amp; deploy activity"
        icon="logs"
        span={8}
        aside={<span className="board-note">last 6 hours</span>}
      >
        {rolled.length === 0 ? (
          <p className="viz-empty">Nothing in the last 6 hours.</p>
        ) : (
          <div className="acts">
            {rolled.map((l) => (
              <div key={l.key} className={`act act-${l.source}`}>
                <time>{logTime(l.ts)}</time>
                <span className="act-src">{l.source}</span>
                <span className="act-msg">{l.line}</span>
                {l.count > 1 && (
                  <span
                    className="act-n"
                    title={`Repeated ${String(l.count)} times, most recently at ${logTime(l.lastTs)}`}
                  >
                    ×{l.count}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
        <p className="board-foot">
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
    <div className="job">
      <div className="job-head">
        <span className="job-name">⚙ {job.name}</span>
        {job.startedAt && <span className="job-elapsed">{fmtElapsed(job.startedAt)}</span>}
      </div>
      <div className="job-step">
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
      <span className="muted" title="No workflow in this repo pushes to the box's registry.">
        no publishing workflow
      </span>
    )
  }
  if (!publish.dispatchable) {
    return (
      <span
        className="muted"
        title={`${publish.workflow} has no workflow_dispatch trigger, so it can only be started by a push.`}
      >
        {publish.workflow} is not dispatchable
      </span>
    )
  }

  return (
    <span className="redeploy">
      {failed && !running && (
        <span className="bad-text" title={message}>
          dispatch failed
        </span>
      )}
      {status.state === 'done' && <span className="ok-text">dispatched</span>}
      <button
        type="button"
        className="btn btn-ghost"
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
      </button>
    </span>
  )
}
