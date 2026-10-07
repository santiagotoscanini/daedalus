// Apps › Builder › History: the window's numbers, each stage's median, the
// apps as a table and the latest failures as another.

import { Link } from '@tanstack/react-router'
import { sha7 } from '../../lib/build-display'
import { cn } from '../../lib/cn'
import { DASH, ms, pct } from '../../lib/format'
import { Ago } from '../ago'
import {
  CELL_MONO,
  CELL_QUIET,
  TABLE,
  TABLE_EMPTY,
  TABLE_HEAD,
  TABLE_LINK,
  TABLE_ROW,
  TABLE_ROW_LINK,
} from '../table'
import { FOOT } from '../tokens'
import { Stat, StatStrip } from '../viz'
import type { Builder } from './builder'
import { TabSection } from './section'

type History = Builder['history']

/** App · builds · failed · median · landed. Numbers right-aligned, units in the head. */
const APP_GRID = cn(
  'grid items-center gap-x-6 px-5',
  'grid-cols-[minmax(0,1fr)_5rem_5rem_6rem_5rem]',
  '@max-[36rem]/table:grid-cols-[minmax(0,1fr)_5rem_5rem]',
)
/** Stage · median · builds. */
const STAGE_GRID = 'grid items-center gap-x-6 px-5 grid-cols-[minmax(0,1fr)_6rem_5rem]'
/** App + commit · stage · error · when. */
const FAIL_GRID = cn(
  'grid items-center gap-x-6 px-5',
  'grid-cols-[12.5rem_5.75rem_minmax(0,1fr)_4.5rem]',
  '@max-[44rem]/table:grid-cols-[minmax(0,1fr)] @max-[44rem]/table:gap-y-0.5',
)
const NARROW = '@max-[36rem]/table:hidden'
const FAIL_NARROW = '@max-[44rem]/table:hidden'

export function HistorySection({ h }: { h: History }) {
  return (
    <TabSection title="History" note={`The last ${String(h.days)} days.`} label="History">
      <p className={cn(FOOT, 'mb-3')}>
        “Landed” is succeeded over succeeded plus failed: a cancelled or superseded build was
        somebody’s decision, not the builder’s result. A build’s time runs from its hand-off to the
        host to its last word, so the wait in the queue is not in it. Each stage’s figure is its
        median over the same window, with how many builds finished it; a stage a failed build
        completed counts.
      </p>
      <StatStrip>
        <Stat label="Builds" value={String(h.total)} />
        <Stat
          label="Landed"
          value={h.successRate === null ? DASH : pct(h.successRate * 100)}
          sub={`${String(h.succeeded)} of ${String(h.succeeded + h.failed)} · ${String(h.failed)} failed`}
        />
        <Stat label="Median build" value={ms(h.medianMs)} sub="hand-off to finish" />
      </StatStrip>
      {/* The pipeline in build order: a short table, so five stages never
          leave an orphan tile at any width. */}
      {h.stages.some((s) => s.medianMs !== null) ? (
        <ul className={cn(TABLE, 'mb-4')} aria-label="Median time per stage">
          <li className={cn(STAGE_GRID, TABLE_HEAD)}>
            <span>Stage</span>
            <span className="text-right">Median</span>
            <span className="text-right">Builds</span>
          </li>
          {h.stages
            .filter((s) => s.medianMs !== null)
            .map((s) => (
              <li key={s.phase} className={cn(STAGE_GRID, TABLE_ROW)}>
                <span className="text-foreground">{s.phase}</span>
                <span className={cn(CELL_QUIET, 'text-right whitespace-nowrap')}>
                  {ms(s.medianMs)}
                </span>
                <span className={cn(CELL_QUIET, 'text-right')}>{String(s.count)}</span>
              </li>
            ))}
        </ul>
      ) : (
        <p className="mt-0 mb-4 text-[0.8rem] text-muted-foreground">
          No stage has been timed yet.
        </p>
      )}

      <ul className={cn(TABLE, 'mt-6')} aria-label="Builds by app">
        <li className={cn(APP_GRID, TABLE_HEAD)}>
          <span>App</span>
          <span className="text-right">Builds</span>
          <span className="text-right">Failed</span>
          <span className={cn('text-right', NARROW)}>Median</span>
          <span className={cn('text-right', NARROW)}>Landed</span>
        </li>
        {h.apps.length === 0 && <li className={TABLE_EMPTY}>No builds in this window.</li>}
        {h.apps.map((a) => (
          <li key={a.app} className={cn(APP_GRID, TABLE_ROW, TABLE_ROW_LINK)}>
            <Link
              to="/apps/$name"
              params={{ name: a.app }}
              search={{ tab: 'deployments' }}
              className={cn(TABLE_LINK, 'min-w-0')}
            >
              <span className="block truncate text-[0.875rem] text-foreground [font-weight:560]">
                {a.app}
              </span>
              <span className="hidden text-[0.72rem] text-muted-foreground @max-[36rem]/table:block">
                median {ms(a.medianMs)} ·{' '}
                {a.successRate === null ? DASH : `${pct(a.successRate * 100)} landed`}
              </span>
            </Link>
            <span className={cn(CELL_QUIET, 'text-right')}>{String(a.total)}</span>
            <span
              className={cn(
                CELL_QUIET,
                'text-right',
                a.failed > 0 && 'text-foreground [font-weight:550]',
              )}
            >
              {a.failed > 0 ? String(a.failed) : DASH}
            </span>
            <span className={cn(CELL_QUIET, 'text-right', NARROW)}>{ms(a.medianMs)}</span>
            <span
              className={cn(
                CELL_QUIET,
                'text-right',
                NARROW,
                a.successRate !== null && a.successRate < 1 && 'text-warning',
              )}
            >
              {a.successRate === null ? DASH : pct(a.successRate * 100)}
            </span>
          </li>
        ))}
      </ul>
    </TabSection>
  )
}

export function FailuresSection({ h }: { h: History }) {
  return (
    <TabSection
      title="Latest failures"
      label="Latest failures"
      aside={<span>{String(h.failed)} in the window</span>}
    >
      <ul className={TABLE} aria-label="Latest failures">
        {h.failures.length === 0 ? (
          <li className={TABLE_EMPTY}>No build failed in the last {String(h.days)} days.</li>
        ) : (
          <>
            <li className={cn(FAIL_GRID, TABLE_HEAD)}>
              <span>Build</span>
              <span className={FAIL_NARROW}>Failed in</span>
              <span className={FAIL_NARROW}>Error</span>
              <span className={cn('text-right', FAIL_NARROW)}>When</span>
            </li>
            {h.failures.map((f) => (
              <li key={f.id} className={cn(FAIL_GRID, TABLE_ROW, TABLE_ROW_LINK)}>
                <Link
                  to="/apps/$name/builds/$id"
                  params={{ name: f.app, id: f.id }}
                  className={cn(TABLE_LINK, 'flex min-w-0 flex-wrap items-baseline gap-x-2')}
                >
                  <span className="text-foreground [font-weight:560]">{f.app}</span>
                  <code className={CELL_MONO}>{sha7(f.sha)}</code>
                </Link>
                {/* Every row here is a failure, so the stage is the fact that
                    differs — in ink, not another red pill. */}
                <span className={cn('text-[0.78rem] text-foreground', FAIL_NARROW)}>{f.phase}</span>
                <span className="min-w-0 text-[0.78rem] text-muted-foreground">
                  {f.error ?? 'no error recorded'}
                  {/* The columns that step away on a narrow table live here. */}
                  <span className="mt-0.5 hidden text-[0.72rem] @max-[44rem]/table:block">
                    failed in {f.phase} · <Ago at={f.at} />
                  </span>
                </span>
                <span className={cn(CELL_QUIET, 'text-right', FAIL_NARROW)}>
                  <Ago at={f.at} />
                </span>
              </li>
            ))}
          </>
        )}
      </ul>
    </TabSection>
  )
}
