import { FOOT, NOTE } from '../../../components/tokens'
import { BarList, Board, BoardGrid, Stat, StatStrip } from '../../../components/viz'
import { DASH, num, pct } from '../../../lib/format'
import type { ActionsData } from '../data'
import { ByRepositoryTable, ByWorkflowTable, FailuresTable, RecentRunsTable } from './runs-tables'
import { DayColumns, GrantBoard, took } from './shared'

type Runs = Extract<ActionsData, { tab: 'runs' }>

export function RunsView({ d }: { d: Runs }) {
  const f = runsFacts({ d })
  const { t, okRate } = f

  return (
    <>
      <StatStrip>
        <Stat label={`Runs · ${String(d.windowDays)} days`} value={num(t.runs)} />
        <Stat
          label="Succeeded"
          value={okRate === null ? DASH : pct(okRate)}
          tone={okRate !== null && okRate < 80 ? 'warn' : undefined}
          sub={`${num(t.ok)} of ${num(t.ok + t.failed)} finished`}
        />
        <Stat label="Failed" value={num(t.failed)} tone={t.failed > 0 ? 'bad' : undefined} />
        <Stat
          label="Running now"
          value={num(t.running)}
          sub={t.queued > 0 ? `${num(t.queued)} queued` : undefined}
        />
        <Stat label="Median run" value={took(t.p50)} sub={`p95 ${took(t.p95)}`} />
        <Stat
          label="Repositories read"
          value={`${num(t.readable)} / ${num(t.watched)}`}
          tone={t.readable < t.watched ? 'warn' : undefined}
        />
      </StatStrip>

      <BoardGrid>
        <RunsPerDayBoard f={f} />

        <ByEventBoard f={f} />

        <GrantBoard unreadable={d.unreadable} publicRepos={d.publicRepos} budget={d.budget} />

        {/* Failures first among the lists: they are the exception the page
            exists to surface, and a quiet line when there are none. */}
        <FailuresTable d={d} />

        <RecentRunsTable d={d} />

        <ByWorkflowTable d={d} />

        <ByRepositoryTable d={d} />
      </BoardGrid>
    </>
  )
}

/** What the page's boards read. */
function runsFacts({ d }: { d: Runs }) {
  const t = d.totals
  const okRate = t.runs === 0 ? null : (100 * t.ok) / Math.max(1, t.ok + t.failed)
  return { d, t, okRate }
}

type RunsFacts = NonNullable<ReturnType<typeof runsFacts>>

function RunsPerDayBoard({ f }: { f: RunsFacts }) {
  const { d } = f
  return (
    <Board
      title="Runs per day"
      icon="clock"
      span={8}
      aside={<span className={NOTE}>a hairline marks a day with a failure</span>}
    >
      <DayColumns points={d.days} unit="runs" empty="no runs in the window" />
    </Board>
  )
}

function ByEventBoard({ f }: { f: RunsFacts }) {
  const { d } = f
  return (
    <Board title="By event" icon="rows" span={4} spanMd={12}>
      <BarList
        items={d.byEvent.map((e) => ({ label: e.label.replace(/_/g, ' '), value: e.value }))}
        empty="nothing ran"
      />
      <p className={FOOT}>
        What starts a workflow: a push, a pull request, a schedule, a tag, or a hand on "Run
        workflow". The apps deploy through daedalus's own webhook and never appear here.
      </p>
    </Board>
  )
}
