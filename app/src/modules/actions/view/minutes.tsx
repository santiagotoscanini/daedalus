import {
  CELL_QUIET,
  TABLE,
  TABLE_EMPTY,
  TABLE_HEAD,
  TABLE_ROW_DENSE,
} from '../../../components/table'
import { TableSection } from '../../../components/table-section'
import { AXIS, CAPTION, FOOT, NOTE } from '../../../components/tokens'
import {
  BarList,
  Board,
  BoardGrid,
  Columns,
  Progress,
  Stat,
  StatStrip,
} from '../../../components/viz'
import { cn } from '../../../lib/cn'
import { DASH, num, pct } from '../../../lib/format'
import type { ActionsData } from '../data'
import { Ext, osWord, SampleRows, WipBoard } from './shared'

/** What could move · jobs · wall minutes · billed. */
const TAKE_GRID = 'grid items-center gap-x-4 grid-cols-[minmax(8rem,1fr)_3rem_4.5rem_4.5rem]'

type Minutes = Extract<ActionsData, { tab: 'minutes' }>

export function MinutesView({ d }: { d: Minutes }) {
  const f = minutesFacts({ d })
  const { t, share, savingTotal } = f

  return (
    <>
      <StatStrip>
        <Stat
          label={`billed · ${d.month.label}`}
          value={num(t.billedThisMonth)}
          unit="min"
          tone={share > 80 ? 'warn' : undefined}
          sub={`of ${num(d.allowance)} on GitHub Free`}
        />
        <Stat label={`billed · ${String(d.windowDays)} days`} value={num(t.billed)} unit="min" />
        <Stat
          label="wall minutes"
          value={num(t.raw.linux + t.raw.windows + t.raw.macos + t.raw.unknown)}
          unit="min"
        />
        <Stat
          label="jobs counted"
          value={num(t.jobs)}
          sub={t.unread > 0 ? `${num(t.unread)} runs not read` : undefined}
        />
        <Stat label="self-hosted" value={num(t.selfHosted)} unit="min" sub="bills nothing" />
        <Stat label="a runner here would save" value={num(savingTotal)} unit="min" />
      </StatStrip>

      <BoardGrid>
        <BilledMinutesPerDayBoard f={f} />

        <AgainstThePlanBoard f={f} />

        <ByRepositoryTable f={f} />

        <CostPerWorkflowTable f={f} />

        <WhatARunnerHereWouldTakeBoard f={f} />

        <GitHubSOwnMeterBoard />
      </BoardGrid>
    </>
  )
}

/** What the page's boards read. */
function minutesFacts({ d }: { d: Minutes }) {
  const t = d.totals
  const share = (100 * t.billedThisMonth) / d.allowance
  const first = d.days[0]?.label ?? ''
  const last = d.days[d.days.length - 1]?.label ?? ''
  const savingTotal = d.saving.reduce((s, x) => s + x.billed, 0)
  return { d, t, share, first, last, savingTotal }
}

type MinutesFacts = NonNullable<ReturnType<typeof minutesFacts>>

function BilledMinutesPerDayBoard({ f }: { f: MinutesFacts }) {
  const { d, first, last } = f
  return (
    <Board
      title="Billed minutes per day"
      icon="clock"
      span={8}
      aside={<span className={NOTE}>after the multiplier</span>}
    >
      <Columns points={d.days} height={92} empty="no hosted minutes in the window" />
      <p className={AXIS}>
        <span>{first}</span>
        <span>minutes</span>
        <span>{last}</span>
      </p>
      <p className={FOOT}>
        Counted the way GitHub bills: each job rounded up to whole minutes, then Linux ×
        {String(d.multipliers.linux)}, Windows ×{String(d.multipliers.windows)}, macOS ×
        {String(d.multipliers.macos)}. Public repositories are free and still counted here, so this
        is the ceiling, not the invoice.
      </p>
    </Board>
  )
}

function AgainstThePlanBoard({ f }: { f: MinutesFacts }) {
  const { d, t, share } = f
  return (
    <Board title="Against the plan" icon="grid" span={4}>
      <Progress pct={Math.min(100, share)} tone={share > 80 ? 'warn' : 'accent'} />
      <p className={CAPTION}>
        {pct(share)} of the {num(d.allowance)} minutes GitHub Free includes for private repositories
        each month, from the jobs the box could read since {d.month.from}.
      </p>
      <p className={FOOT}>
        The plan itself is assumed; GitHub's own meter needs a user token nothing on this box holds.
      </p>
      <BarList
        items={[
          { label: 'Linux', value: t.billedByOs.linux },
          { label: 'Windows', value: t.billedByOs.windows },
          { label: 'macOS', value: t.billedByOs.macos },
        ].filter((i) => i.value > 0)}
        empty="nothing billed"
      />
    </Board>
  )
}

function WhatARunnerHereWouldTakeBoard({ f }: { f: MinutesFacts }) {
  const { d, savingTotal } = f
  return (
    <Board
      title="What a runner here would take"
      icon="panels"
      span={6}
      aside={<span className={NOTE}>{num(savingTotal)} min</span>}
    >
      {d.saving.length === 0 ? (
        <p className={CAPTION}>No hosted job in the window.</p>
      ) : (
        <ul className="m-0 list-none p-0 text-[0.8rem]">
          <li className={cn(TAKE_GRID, 'pb-1.5 text-[0.72rem] text-muted-foreground')}>
            <span>Jobs that could move</span>
            <span className="text-right">Jobs</span>
            <span className="text-right">Wall min</span>
            <span className="text-right">Billed</span>
          </li>
          {d.saving.map((s) => (
            <li key={s.os} className={cn(TAKE_GRID, 'border-hairline border-t py-2.5')}>
              <span className="truncate text-foreground">
                {osWord(s.os)} jobs →{' '}
                {s.os === 'linux'
                  ? 'this box'
                  : s.os === 'windows'
                    ? 'a Windows node'
                    : 'a macOS node'}
              </span>
              <span className={cn(CELL_QUIET, 'text-right')}>{num(s.jobs)}</span>
              <span className={cn(CELL_QUIET, 'text-right')}>{num(s.raw)}</span>
              <span className="text-right text-foreground tabular-nums">{num(s.billed)}</span>
            </li>
          ))}
        </ul>
      )}
      <p className={FOOT}>
        Every hosted job whose image one of this network's machines could serve. macOS minutes are
        the expensive ones (×{String(d.multipliers.macos)}), and there is a Mac on the network. The
        Runners tab is where that becomes a runner.
      </p>
    </Board>
  )
}

function GitHubSOwnMeterBoard() {
  return (
    <WipBoard
      title="GitHub's own meter"
      span={6}
      waits="needs a user token with the `user` scope, kept in the vault"
    >
      <SampleRows
        rows={[
          ['Included minutes', '2,000'],
          ['Used this cycle', '412'],
          ['Paid minutes', '0'],
          ['Storage', '0.3 GB of 0.5 GB'],
        ]}
      />
    </WipBoard>
  )
}

/** Repository · billed · Linux · Windows · macOS · self-hosted · unread. */
const REPO_GRID =
  'grid items-center gap-x-5 px-5 grid-cols-[minmax(7rem,1fr)_4.5rem_3.5rem_3.5rem_3.5rem_3.5rem_4rem] @max-[38rem]/table:grid-cols-[minmax(7rem,1fr)_4.5rem_4rem] @max-[38rem]/table:[&>.os]:hidden'

/** A zero recedes to a dash, so the minutes that exist are what the eye finds. */
function Minutes({ n, className }: { n: number; className?: string }) {
  return (
    <span
      className={cn(CELL_QUIET, 'text-right', n === 0 && 'text-muted-foreground/50', className)}
    >
      {n === 0 ? DASH : num(n)}
    </span>
  )
}

function ByRepositoryTable({ f }: { f: MinutesFacts }) {
  const { d } = f
  return (
    <TableSection
      title="By repository"
      aside="minutes"
      className="col-span-7 max-[78rem]:col-span-12"
    >
      <ul className={TABLE} aria-label="Minutes by repository">
        <li className={cn(REPO_GRID, TABLE_HEAD)}>
          <span>Repository</span>
          <span className="text-right">Billed</span>
          <span className="os text-right" title="Linux wall minutes, before the multiplier">
            Linux
          </span>
          <span className="os text-right" title="Windows wall minutes, before the multiplier">
            Win
          </span>
          <span className="os text-right" title="macOS wall minutes, before the multiplier">
            macOS
          </span>
          <span className="os text-right">Self</span>
          <span className="text-right">Unread</span>
        </li>
        {d.byRepo.length === 0 && <li className={TABLE_EMPTY}>no jobs read</li>}
        {d.byRepo.map((r) => (
          <li key={r.repo} className={cn(REPO_GRID, TABLE_ROW_DENSE)}>
            <Ext href={`${r.url}/actions`} className="truncate text-foreground">
              {r.repo}
            </Ext>
            <span
              className={cn(
                'text-right tabular-nums',
                r.billed > 0 ? 'text-foreground [font-weight:560]' : 'text-muted-foreground/50',
              )}
            >
              {r.billed > 0 ? num(r.billed) : DASH}
            </span>
            <Minutes n={r.raw.linux} className="os" />
            <Minutes n={r.raw.windows} className="os" />
            <Minutes n={r.raw.macos} className="os" />
            <Minutes n={r.selfHosted} className="os" />
            <Minutes n={r.unread} />
          </li>
        ))}
      </ul>
      <p className={FOOT}>
        Linux, Win and macOS are wall minutes per image before the multiplier; billed is after it.
        "Unread" runs are beyond the
        {` ${String(24)} `}most recent per repository the page reads jobs for, or in a repository
        the App cannot read.
      </p>
    </TableSection>
  )
}

/** Workflow · the job that dominates it · billed. */
const WF_COST_GRID =
  'grid items-center gap-x-5 px-5 grid-cols-[minmax(7rem,1fr)_minmax(5rem,0.8fr)_4.5rem] @max-[26rem]/table:grid-cols-[minmax(7rem,1fr)_4.5rem] @max-[26rem]/table:[&>.job]:hidden'

function CostPerWorkflowTable({ f }: { f: MinutesFacts }) {
  const { d } = f
  return (
    <TableSection
      title="Cost per workflow"
      aside="billed minutes"
      className="col-span-5 max-[78rem]:col-span-12"
    >
      <ul className={TABLE} aria-label="Billed minutes by workflow">
        <li className={cn(WF_COST_GRID, TABLE_HEAD)}>
          <span>Workflow</span>
          <span className="job">Heaviest job</span>
          <span className="text-right">Billed</span>
        </li>
        {d.byWorkflow.length === 0 && <li className={TABLE_EMPTY}>no hosted jobs read</li>}
        {d.byWorkflow.map((w) => (
          <li key={w.label} className={cn(WF_COST_GRID, TABLE_ROW_DENSE)}>
            <span className="truncate text-foreground">{w.label}</span>
            <span className={cn(CELL_QUIET, 'job truncate')}>
              {w.topJob === null ? DASH : `${w.topJob} · ${num(w.topJobBilled)}`}
            </span>
            <span className="text-right text-foreground tabular-nums">{num(w.billed)}</span>
          </li>
        ))}
      </ul>
      <p className={FOOT}>Ranked by billed minutes, with the job that dominates each one.</p>
    </TableSection>
  )
}
