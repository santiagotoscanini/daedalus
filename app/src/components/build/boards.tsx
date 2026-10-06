import type { ReactNode } from 'react'
import {
  type BuildCommit,
  type BuildView,
  buildDurationMs,
  buildQueuedMs,
  buildTimeline,
  type DeployOutcome,
  isOpenBuild,
  pushedTags,
  sha7,
  type TimelineStep,
} from '../../lib/build-display'
import { bytes, DASH, ms } from '../../lib/format'
import { useSite } from '../../lib/site-context'
import { stageExposed } from '../../lib/stage'
import type { Tone } from '../../lib/tone'
import type { BuildPageApp } from '../../server/builds'
import { requesterLabel } from '../apps/builds'
import { GuardedAwait } from '../error'
import { CAPTION, EMPTY } from '../tokens'
import { Board, Chip, Facts, Pulse } from '../viz'
import { FollowLog } from './follow-log'

// The build page's boards, one per question: what was built (Commit), what came
// out (Result), how it went (Phases, Checks), what Railpack made of the repo
// (Detection, Resolved tools, Railpack said), what the push produced (Image),
// and the log. Commit, Result, Phases and Log draw their own card; the rest —
// ImageBoard too, despite its name — are a card's body, placed in their card
// by BuildDetail.

/** A moment as UTC minutes: the same string on the server and in the browser. */
export const at = (iso: string | null): string =>
  iso === null ? DASH : `${iso.slice(0, 16).replace('T', ' ')} UTC`

export function CommitBoard({
  build,
  commit,
  commitUrl,
  open,
  now,
}: {
  build: BuildView
  commit: Promise<BuildCommit | null> | null
  commitUrl: string
  open: boolean
  now: number | null
}) {
  const took = open && now === null ? null : buildDurationMs(build, now ?? 0)
  const waited = buildQueuedMs(build)
  return (
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
  )
}

function CommitField({
  commit,
  pick,
}: {
  commit: Promise<BuildCommit | null> | null
  pick: (c: BuildCommit) => string
}) {
  const none = <span className="text-muted-foreground">{DASH}</span>
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

export function ResultBoard({
  name,
  app,
  build,
  open,
}: {
  name: string
  app: BuildPageApp | null
  build: BuildView
  open: boolean
}) {
  const site = useSite()
  return (
    <Board title="Result" span={6}>
      {build.digest === null ? (
        <p className={EMPTY}>
          {open || build.state === 'queued' ? 'Nothing published yet.' : 'Nothing was published.'}
        </p>
      ) : (
        <Facts
          list
          rows={[
            {
              k: 'digest',
              v: (
                <code title={build.digest}>{build.digest.replace('sha256:', '').slice(0, 12)}</code>
              ),
            },
            {
              k: 'image',
              v: <code title={build.imageRef ?? undefined}>{`${site.registryHost}/${name}`}</code>,
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
      {app !== null && stageExposed(app.stage) && build.deploy.kind === 'deployed' && (
        <p className="m-0 text-[0.82rem]">
          <a href={`https://${app.effectiveHostname}`} target="_blank" rel="noreferrer">
            ↗ {app.effectiveHostname}
          </a>
        </p>
      )}
    </Board>
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
          <code key={tag} className="text-[0.75rem]" title={tag}>
            {tag.length > 20 ? `${tag.slice(0, tag.indexOf('-') + 8)}…` : tag}
          </code>
        ))}
      </span>
    ),
  }
}

function Outcome({ outcome }: { outcome: DeployOutcome }) {
  switch (outcome.kind) {
    case 'none':
      return <span className="text-muted-foreground">{DASH}</span>
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
      return <span className="text-subdued">waiting for the deploy</span>
    case 'deployed':
      return (
        <span className={outcome.result === 'ok' ? 'text-success' : 'text-danger'}>
          deployed, {outcome.result}
          {outcome.httpCode !== null ? ` (HTTP ${outcome.httpCode})` : ''} at {at(outcome.at)}
        </span>
      )
  }
}

export function PhasesBoard({ build, open }: { build: BuildView; open: boolean }) {
  return (
    <Board title="Phases" span={6}>
      <ol className="m-0 list-none p-0">
        {buildTimeline(build.state, build.timings).map((s) => (
          <Step key={s.phase} step={s} />
        ))}
      </ol>
      {open && build.phase !== '' && <p className={CAPTION}>Now: {build.phase}</p>}
    </Board>
  )
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
    <li className="flex items-center gap-2.5 border-hairline border-t py-1.5 text-[0.84rem] first:border-t-0 first:pt-0">
      <Pulse on={step.status === 'running'} tone={STEP_TONE[step.status]} />
      <span
        className={
          step.status === 'pending' || step.status === 'skipped'
            ? 'text-muted-foreground'
            : step.status === 'failed'
              ? 'text-danger'
              : undefined
        }
      >
        {step.phase}
      </span>
      <span className="ml-auto font-mono text-[0.78rem] text-muted-foreground">
        {STEP_NOTE[step.status] ?? (step.ms === null ? DASH : ms(step.ms))}
      </span>
    </li>
  )
}

export function Checks({ build }: { build: BuildView }) {
  const checks = build.checks
  if (checks === null || (checks.ran.length === 0 && checks.failed === null)) {
    return (
      <p className={EMPTY}>
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
              className="flex items-center gap-2.5 border-hairline border-t py-1.5 text-[0.84rem] first:border-t-0 first:pt-0"
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
      <p className={CAPTION}>
        {checks.failed === null
          ? `${String(names.length)} ran, none failed.`
          : `${checks.failed} failed, so nothing was built past it.`}
      </p>
    </>
  )
}

export const LOG_TONE: Record<string, Tone> = {
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
export const docsUrl = (path: string): string =>
  /^https?:\/\//i.test(path)
    ? path
    : `https://railpack.com${path.startsWith('/') ? '' : '/'}${path}`

export function LogBoard({ build, open }: { build: BuildView; open: boolean }) {
  return (
    <Board title="Log" span={12} aside={open ? <Chip tone="info">following</Chip> : undefined}>
      {build.log.available ? (
        <FollowLog text={build.log.text} />
      ) : (
        <p className={EMPTY}>
          {build.state === 'queued'
            ? 'Queued. The log starts when the host picks the build up.'
            : 'The host has no log for this build.'}
        </p>
      )}
      <p className={CAPTION}>
        {build.log.truncated ? `The last 64 KB of ${bytes(build.log.sizeBytes)}. ` : ''}
        Credentials are redacted twice: by the host as it writes the log, and here as it is read.
      </p>
    </Board>
  )
}
