// Apps › Builder › Now: what the box is building, step by step, live.

import { Link, useRouter } from '@tanstack/react-router'
import {
  buildDurationMs,
  buildTimeline,
  type LiveBuild,
  sha7,
  type TimelineStep,
} from '../../lib/build-display'
import { cn } from '../../lib/cn'
import { ms } from '../../lib/format'
import { type Tone, toneStyle } from '../../lib/tone'
import { fetchBuilderNow } from '../../server/builds'
import { Ago } from '../ago'
import { useLiveValue, useNow } from '../poll'
import { EMPTY, FOOT, LIST, MONO, NOTE, ROW, ROW_N, ROW_SIDE } from '../tokens'
import { Board, Pulse } from '../viz'
import { BuildStateChip, requesterLabel } from './builds'

/* ── now ──────────────────────────────────────────────────────────────── */

const STEP_TONE: Record<TimelineStep['status'], Tone> = {
  done: 'ok',
  running: 'info',
  failed: 'bad',
  pending: 'muted',
  skipped: 'muted',
}

export function NowBoard({ initial }: { initial: LiveBuild[] }) {
  const router = useRouter()
  const builds = useLiveValue(
    initial,
    async (current) => {
      const next = await fetchBuilderNow()
      // A build finished: History and the medians are now one build out of date.
      if (current.some((b) => !next.some((n) => n.id === b.id))) void router.invalidate()
      return next
    },
    (current) => (current.length > 0 ? 3000 : 15_000),
    () => true,
  )
  const open = builds.length > 0
  const now = useNow(open)

  const running = builds.filter((b) => b.state !== 'queued').length
  return (
    <Board
      title="Now"
      icon="logs"
      span={12}
      aside={
        <span className={cn(NOTE, 'inline-flex items-center gap-[0.35rem]')}>
          <Pulse on={running > 0} tone="info" />
          {running > 0
            ? `${String(running)} building, ${String(builds.length - running)} queued`
            : builds.length > 0
              ? `${String(builds.length)} queued`
              : 'idle'}
        </span>
      }
    >
      {builds.length === 0 ? (
        <p className={EMPTY}>Nothing is queued or building.</p>
      ) : (
        <ul className={LIST}>
          {builds.map((b) => (
            <NowRow key={b.id} b={b} now={now} />
          ))}
        </ul>
      )}
      <p className={FOOT}>
        One build runs at a time; a newer push replaces a build still waiting in its lane. A
        candidate build pushes <span className={MONO}>candidate-&lt;sha&gt;</span> and deploys
        nothing. What each build pushed is on the{' '}
        <Link to="/apps" search={{ tab: 'images' }}>
          Container registry
        </Link>{' '}
        tab.
      </p>
    </Board>
  )
}

function NowRow({ b, now }: { b: LiveBuild; now: number | null }) {
  const steps = buildTimeline(b.state, b.timings)
  // The host times a stage when it ends, so the running one has no number of
  // its own; the clock on the right is the whole build since its hand-off.
  const took = now === null ? null : buildDurationMs(b, now)
  return (
    <li className={cn(ROW, 'flex-wrap gap-y-[0.35rem] py-[0.5rem]')}>
      <Link
        to="/apps/$name/builds/$id"
        params={{ name: b.app, id: b.id }}
        className="inline-flex min-w-[11rem] items-baseline gap-[0.5rem] no-underline"
      >
        <span className="text-foreground">{b.app}</span>
        <code className="text-[0.74rem] text-muted-foreground">{sha7(b.sha)}</code>
      </Link>
      <BuildStateChip state={b.state} />
      <span className={ROW_SIDE}>
        {requesterLabel(b)}
        {b.publish === 'candidate' && ' · candidate'}
      </span>
      <ol className="m-0 ml-auto flex list-none flex-wrap items-center gap-x-[0.8rem] gap-y-1 p-0">
        {steps.map((s) => (
          <li
            key={s.phase}
            className={cn(
              'inline-flex items-center gap-[0.3rem] text-[0.74rem]',
              s.status === 'pending' ? 'text-muted-foreground' : 'text-subdued',
            )}
          >
            {s.status === 'running' ? (
              <Pulse on tone="info" />
            ) : (
              <span
                aria-hidden="true"
                className="inline-block size-[7px] flex-none rounded-full bg-(--tone)"
                style={toneStyle(STEP_TONE[s.status])}
              />
            )}
            {s.phase}
            <span className="font-mono text-[0.7rem] text-muted-foreground">
              {s.ms === null ? '' : ms(s.ms)}
            </span>
          </li>
        ))}
      </ol>
      <span className={cn(ROW_N, 'min-w-[5.5rem] text-[0.72rem] text-muted-foreground')}>
        {b.state === 'queued' ? (
          <>
            asked <Ago at={b.createdAt} />
          </>
        ) : (
          ms(took)
        )}
      </span>
    </li>
  )
}
