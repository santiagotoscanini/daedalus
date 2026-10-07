// Actions › Runs: the lists — runs, failures, workflows, repositories — as the
// house table rather than rows inside boards.

import { Ago } from '../../../components/ago'
import {
  CELL_QUIET,
  CELL_SUB,
  TABLE,
  TABLE_EMPTY,
  TABLE_HEAD,
  TABLE_LINK,
  TABLE_ROW_DENSE,
  TABLE_ROW_LINK,
  TableGroup,
} from '../../../components/table'
import { TableSection } from '../../../components/table-section'
import { CAPTION, FOOT } from '../../../components/tokens'
import { cn } from '../../../lib/cn'
import { DASH, duration, num } from '../../../lib/format'
import type { ActionsData } from '../data'
import type { RunRow } from '../data/runs'
import { Ext, imageWord, RunChip, took } from './shared'

type Runs = Extract<ActionsData, { tab: 'runs' }>

/** State · run · event · runner · took · when. Event and runner step away first. */
const RUN_GRID =
  'grid items-center gap-x-6 px-5 grid-cols-[6rem_minmax(12rem,1.6fr)_6.5rem_minmax(7rem,1fr)_4.5rem_6rem] @max-[52rem]/table:grid-cols-[6rem_minmax(10rem,1fr)_4.5rem_6rem] @max-[52rem]/table:[&>.side]:hidden @max-[38rem]/table:grid-cols-[minmax(0,1fr)_auto] @max-[38rem]/table:gap-x-3 @max-[38rem]/table:[&>.st]:hidden @max-[38rem]/table:[&>.took]:hidden'

/** The failures table: every row failed, so it has no state column. */
const FAIL_GRID =
  'grid items-center gap-x-6 px-5 grid-cols-[minmax(14rem,2fr)_6.5rem_minmax(6rem,0.8fr)_4.5rem_6rem] @max-[52rem]/table:grid-cols-[minmax(10rem,1fr)_4.5rem_6rem] @max-[52rem]/table:[&>.side]:hidden @max-[38rem]/table:grid-cols-[minmax(0,1fr)_auto] @max-[38rem]/table:gap-x-3 @max-[38rem]/table:[&>.took]:hidden'

/** The machines a run used, as OS words ("Linux, macOS"); the images are on hover. */
function runnerWord(ranOn: readonly string[]): string {
  if (ranOn.length === 0) return DASH
  return [...new Set(ranOn.map((l) => imageWord(l).split(' · ')[0] ?? l))]
    .filter((w) => w !== '')
    .join(', ')
}

/** One run as a table row; the whole row opens the run on GitHub. */
function RunRowLine({ r, showFailure = false }: { r: RunRow; showFailure?: boolean }) {
  return (
    <li className={cn(showFailure ? FAIL_GRID : RUN_GRID, TABLE_ROW_DENSE, TABLE_ROW_LINK)}>
      {!showFailure && (
        <span className="st">
          <RunChip status={r.status} conclusion={r.conclusion} />
        </span>
      )}
      <span className="min-w-0">
        <a
          href={r.url}
          target="_blank"
          rel="noreferrer"
          className={cn(TABLE_LINK, 'block truncate @max-[38rem]/table:whitespace-normal')}
        >
          <span className="@max-[38rem]/table:hidden">
            <span className="text-foreground [font-weight:560]">{r.repo}</span>
            <span className="text-muted-foreground"> · </span>
            <span className="text-foreground">{r.workflow}</span>
          </span>
          {/* On a phone the workflow is the name, wrapping to two lines, and the
              repository is the muted line under it. */}
          <span className="hidden text-foreground [font-weight:560] [overflow-wrap:anywhere] @max-[38rem]/table:inline">
            {r.workflow}
          </span>
          {r.branch !== null && r.branch !== 'main' && (
            <span className="ml-1.5 font-mono text-[0.75rem] text-muted-foreground">
              {r.branch}
            </span>
          )}
        </a>
        <span className="hidden flex-wrap items-center gap-x-1.5 gap-y-0.5 pt-0.5 text-[0.72rem] text-muted-foreground @max-[38rem]/table:flex">
          {!showFailure && <RunChip status={r.status} conclusion={r.conclusion} />}
          <span>{r.repo}</span>
          <span>· {r.event.replace(/_/g, ' ')}</span>
          <span className="tabular-nums">· {took(r.seconds)}</span>
        </span>
        {/* The job path gives way, never the failing step: the job truncates
            and the step (the one red) is always whole. */}
        {showFailure && r.failed !== null && (
          <p className={cn(CELL_SUB, 'flex min-w-0 items-baseline gap-1')}>
            {r.failed.step === null ? (
              <span className="truncate text-danger">{r.failed.job}</span>
            ) : (
              <>
                <span className="min-w-0 truncate" title={r.failed.job}>
                  {r.failed.job}
                </span>
                <span className="flex-none">›</span>
                <span className="max-w-[60%] flex-none truncate text-danger" title={r.failed.step}>
                  {r.failed.step}
                </span>
              </>
            )}
          </p>
        )}
      </span>
      <span className={cn(CELL_QUIET, 'side truncate')}>{r.event.replace(/_/g, ' ')}</span>
      <span className={cn(CELL_QUIET, 'side truncate')} title={r.ranOn.join(', ')}>
        {runnerWord(r.ranOn)}
      </span>
      <span className={cn(CELL_QUIET, 'took text-right')}>{took(r.seconds)}</span>
      <span className={cn(CELL_QUIET, 'text-right')}>
        <Ago at={r.createdAt} />
      </span>
    </li>
  )
}

function RunHead({ failures = false }: { failures?: boolean }) {
  return (
    <li className={cn(failures ? FAIL_GRID : RUN_GRID, TABLE_HEAD)}>
      {!failures && <span className="st">State</span>}
      <span>Repository · workflow</span>
      <span className="side">Event</span>
      <span className="side">Runner</span>
      <span className="took text-right">Took</span>
      <span className="text-right">Started</span>
    </li>
  )
}

/**
 * Newest first, with what is running right now as a group at the head of the
 * same table — said once, where a separate board repeated its top rows.
 */
export function RecentRunsTable({ d }: { d: Runs }) {
  const live = new Set(d.running.map((r) => r.id))
  const rest = d.recent.filter((r) => !live.has(r.id))
  return (
    <TableSection title="Recent runs" aside={`newest first · ${num(d.recent.length)} shown`}>
      <ul className={TABLE} aria-label="Recent runs">
        <RunHead />
        {d.running.length > 0 && (
          <>
            <TableGroup title="Running now" note={`${String(d.running.length)} live`} />
            {d.running.map((r) => (
              <RunRowLine key={r.id} r={r} />
            ))}
            <TableGroup title="Finished" />
          </>
        )}
        {rest.map((r) => (
          <RunRowLine key={r.id} r={r} />
        ))}
        {d.recent.length === 0 && d.running.length === 0 && (
          <li className={TABLE_EMPTY}>
            No run the box can read in the last {String(d.windowDays)} days.
          </li>
        )}
      </ul>
    </TableSection>
  )
}

/** The failures, loud — only drawn as a table when there are any. */
export function FailuresTable({ d }: { d: Runs }) {
  return (
    <TableSection
      title="Failures"
      aside={
        d.failures.length === 0
          ? 'none in the window'
          : `${String(d.failures.length)} in the window`
      }
    >
      {d.failures.length === 0 ? (
        <p className={CAPTION}>Nothing failed in the window.</p>
      ) : (
        <ul className={TABLE} aria-label="Failed runs">
          <RunHead failures />
          {d.failures.map((r) => (
            <RunRowLine key={r.id} r={r} showFailure />
          ))}
        </ul>
      )}
      <p className={FOOT}>
        The job and the step that failed, read from the run's jobs; the row opens the run's log on
        GitHub.
      </p>
    </TableSection>
  )
}

/** Name · runs · failed · median. */
const TALLY_GRID =
  'grid items-center gap-x-3 px-5 grid-cols-[minmax(0,1fr)_3.5rem_3.5rem_4rem] @min-[38rem]/table:gap-x-5'

export function ByWorkflowTable({ d }: { d: Runs }) {
  return (
    <TableSection title="By workflow" className="col-span-6 max-[78rem]:col-span-12">
      <ul className={TABLE} aria-label="Runs by workflow">
        <li className={cn(TALLY_GRID, TABLE_HEAD)}>
          <span>Workflow</span>
          <span className="text-right">Runs</span>
          <span className="text-right">Failed</span>
          <span className="text-right">Median</span>
        </li>
        {d.byWorkflow.length === 0 && <li className={TABLE_EMPTY}>no runs</li>}
        {d.byWorkflow.map((w) => (
          <li key={w.label} className={cn(TALLY_GRID, TABLE_ROW_DENSE)}>
            <span className="text-foreground [overflow-wrap:anywhere]">{w.label}</span>
            <span className={cn(CELL_QUIET, 'text-right')}>{num(w.runs)}</span>
            <Failed n={w.failed} />
            <span className={cn(CELL_QUIET, 'text-right')}>{took(w.p50)}</span>
          </li>
        ))}
      </ul>
    </TableSection>
  )
}

export function ByRepositoryTable({ d }: { d: Runs }) {
  return (
    <TableSection title="By repository" className="col-span-6 max-[78rem]:col-span-12">
      <ul className={TABLE} aria-label="Runs by repository">
        <li className={cn(TALLY_GRID, TABLE_HEAD)}>
          <span>Repository</span>
          <span className="text-right">Runs</span>
          <span className="text-right">Failed</span>
          <span className="text-right">Median</span>
        </li>
        {d.byRepo.map((r) => {
          const readable = r.access === 'app' || r.access === 'public'
          return (
            <li key={r.repo} className={cn(TALLY_GRID, TABLE_ROW_DENSE)}>
              <span className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
                <Ext href={`${r.url}/actions`} className="text-foreground [overflow-wrap:anywhere]">
                  {r.repo}
                </Ext>
                <span className="text-[0.75rem] text-muted-foreground">
                  {r.kind}
                  {r.access === 'public' && ' · public'}
                </span>
              </span>
              {readable ? (
                <>
                  <span
                    className={cn(CELL_QUIET, 'text-right')}
                    title={r.total > r.runs ? `${num(r.runs)} of ${num(r.total)} read` : undefined}
                  >
                    {num(r.runs)}
                    {r.total > r.runs && (
                      <span className="text-muted-foreground/70"> /{num(r.total)}</span>
                    )}
                  </span>
                  <Failed n={r.failed} />
                  <span className={cn(CELL_QUIET, 'text-right')}>
                    {r.p50 === null ? DASH : duration(r.p50)}
                  </span>
                </>
              ) : (
                <span className="col-span-3 text-right font-mono text-[0.72rem] text-warning">
                  needs actions: read
                </span>
              )}
            </li>
          )
        })}
      </ul>
    </TableSection>
  )
}

/** Zero failures is the norm and recedes to a dash; any failure is the ink. */
function Failed({ n }: { n: number }) {
  return n > 0 ? (
    <span className="text-right text-danger tabular-nums [font-weight:560]">{num(n)}</span>
  ) : (
    <span className={cn(CELL_QUIET, 'text-right text-muted-foreground/60')}>{DASH}</span>
  )
}
