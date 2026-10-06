import {
  AXIS,
  CAPTION,
  FOOT,
  LIST,
  NOTE,
  ROW,
  ROW_MAIN,
  ROW_SIDE,
} from '../../../components/tokens'
import {
  BarList,
  Board,
  BoardGrid,
  Chip,
  Columns,
  Progress,
  Stat,
  StatStrip,
} from '../../../components/viz'
import { num, pct } from '../../../lib/format'
import type { ActionsData } from '../data'
import { Ext, osWord, SampleRows, WipBoard } from './shared'

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
        <Stat
          label="a runner here would save"
          value={num(savingTotal)}
          unit="min"
          tone={savingTotal > 0 ? 'ok' : undefined}
        />
      </StatStrip>

      <BoardGrid>
        <BilledMinutesPerDayBoard f={f} />

        <AgainstThePlanBoard f={f} />

        <ByRepositoryBoard f={f} />

        <WhatARunnerHereWouldTakeBoard f={f} />

        <GitHubSOwnMeterBoard />

        <CostPerWorkflowBoard f={f} />
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

function ByRepositoryBoard({ f }: { f: MinutesFacts }) {
  const { d } = f
  return (
    <Board title="By repository" icon="rows" span={6}>
      <ul className={LIST}>
        {d.byRepo.map((r) => (
          <li key={r.repo} className={ROW}>
            <span className={ROW_MAIN}>
              <Ext href={`${r.url}/actions`}>{r.repo}</Ext>
            </span>
            <span className={ROW_SIDE}>
              {num(r.billed)} billed
              {r.raw.linux > 0 && ` · L ${num(r.raw.linux)}`}
              {r.raw.windows > 0 && ` · W ${num(r.raw.windows)}`}
              {r.raw.macos > 0 && ` · M ${num(r.raw.macos)}`}
              {r.selfHosted > 0 && ` · self ${num(r.selfHosted)}`}
              {r.unread > 0 && ` · ${num(r.unread)} runs unread`}
            </span>
          </li>
        ))}
        {d.byRepo.length === 0 && <li className={CAPTION}>no jobs read</li>}
      </ul>
      <p className={FOOT}>
        L, W, M are wall minutes per image before the multiplier. "Unread" runs are beyond the
        {` ${String(24)} `}most recent per repository the page reads jobs for, or in a repository
        the App cannot read.
      </p>
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
      aside={<Chip tone={savingTotal > 0 ? 'ok' : 'muted'}>{num(savingTotal)} min</Chip>}
    >
      {d.saving.length === 0 ? (
        <p className={CAPTION}>No hosted job in the window.</p>
      ) : (
        <ul className={LIST}>
          {d.saving.map((s) => (
            <li key={s.os} className={ROW}>
              <span className={ROW_MAIN}>
                {osWord(s.os)} jobs →{' '}
                {s.os === 'linux'
                  ? 'this box'
                  : s.os === 'windows'
                    ? 'a Windows node'
                    : 'a macOS node'}
              </span>
              <span className={ROW_SIDE}>
                {num(s.jobs)} jobs · {num(s.raw)} wall min · {num(s.billed)} billed
              </span>
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

function CostPerWorkflowBoard({ f }: { f: MinutesFacts }) {
  const { d } = f
  return (
    <Board title="Cost per workflow" icon="rows" span={6}>
      <ul className={LIST}>
        {d.byWorkflow.map((w) => (
          <li key={w.label} className={ROW}>
            <span className={ROW_MAIN}>
              {w.label}
              {w.topJob !== null && (
                <span className="ml-1.5 text-muted-foreground">
                  {w.topJob} {num(w.topJobBilled)}
                </span>
              )}
            </span>
            <span className={ROW_SIDE}>{num(w.billed)} billed</span>
          </li>
        ))}
        {d.byWorkflow.length === 0 && <li className={CAPTION}>no hosted jobs read</li>}
      </ul>
      <p className={FOOT}>Ranked by billed minutes, with the job that dominates each one.</p>
    </Board>
  )
}
