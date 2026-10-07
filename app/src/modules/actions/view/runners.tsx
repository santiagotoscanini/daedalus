import {
  CELL_MONO,
  CELL_NAME,
  CELL_QUIET,
  TABLE,
  TABLE_HEAD,
  TABLE_ROW,
} from '../../../components/table'
import { TableSection } from '../../../components/table-section'
import {
  CAPTION,
  FOOT,
  LIST,
  MONO,
  NOTE,
  ROW,
  ROW_MAIN,
  ROW_SIDE,
} from '../../../components/tokens'
import { Board, BoardGrid, Chip, Progress, Pulse, Stat, StatStrip } from '../../../components/viz'
import { cn } from '../../../lib/cn'
import { num, since } from '../../../lib/format'
import { LINK_UNKNOWN } from '../../../lib/node-link'
import type { ActionsData } from '../data'
import { accessWord, Ext, osWord, SampleRows, WipBoard } from './shared'

type Runners = Extract<ActionsData, { tab: 'runners' }>

export function RunnersView({ d }: { d: Runners }) {
  const f = runnersFacts({ d })
  const { online, unknown, registered, demandTotal, minutesTotal } = f

  return (
    <>
      <StatStrip>
        <Stat
          label="machines on the network"
          value={num(d.machines.length)}
          sub={`${num(online)} online${unknown > 0 ? ` · ${num(unknown)} unknown` : ''}`}
        />
        <Stat
          label={`hosted jobs · 30 days`}
          value={num(demandTotal)}
          sub={`${num(minutesTotal)} wall minutes`}
        />
        {d.demand.map((x) => (
          <Stat
            key={x.os}
            label={`ask for ${osWord(x.os)}`}
            value={num(x.jobs)}
            sub={`${num(x.workflows)} in files`}
          />
        ))}
        <Stat
          label="registered with GitHub"
          value={d.canListRunners ? num(registered.length) : '—'}
          sub={d.canListRunners ? undefined : 'needs the runners App'}
        />
      </StatStrip>

      <BoardGrid>
        <MachinesThatCouldTakeAJobTable f={f} />

        <RegisteredWithGitHubBoard f={f} />

        <QueueBoard />

        <ThisMonthHereInsteadOfHostedBoard />

        <DefineARunnerBoard />

        <RunnersNowBoard />

        <HowARunnerHereWouldWorkBoard />
      </BoardGrid>
    </>
  )
}

/** What the page's boards read. */
function runnersFacts({ d }: { d: Runners }) {
  const online = d.machines.filter((m) => m.online === true).length
  const unknown = d.machines.filter((m) => m.online === null).length
  const registered = d.registered.flatMap((r) => r.runners)
  const demandTotal = d.demand.reduce((s, x) => s + x.jobs, 0)
  const minutesTotal = d.demand.reduce((s, x) => s + x.minutes, 0)
  return { d, online, unknown, registered, demandTotal, minutesTotal }
}

type RunnersFacts = NonNullable<ReturnType<typeof runnersFacts>>

/** Machine · platform · labels · demand · state. Labels and platform step away first. */
const MACHINE_GRID =
  'grid items-center gap-x-6 px-5 grid-cols-[minmax(9rem,1fr)_minmax(9rem,1fr)_minmax(9rem,1fr)_minmax(9rem,0.9fr)_8rem] @max-[52rem]/table:grid-cols-[minmax(9rem,1fr)_minmax(8rem,0.9fr)_7rem] @max-[52rem]/table:[&>.side]:hidden'

function MachinesThatCouldTakeAJobTable({ f }: { f: RunnersFacts }) {
  const { d } = f
  return (
    <TableSection title="Machines that could take a job" aside="this box and every approved node">
      <ul className={TABLE} aria-label="Machines that could run a job">
        <li className={cn(MACHINE_GRID, TABLE_HEAD)}>
          <span>Machine</span>
          <span className="side">Platform</span>
          <span className="side">Would answer to</span>
          <span>Asked for, a month</span>
          <span className="text-right">State</span>
        </li>
        {d.machines.map((m) => (
          <li key={m.id} className={cn(MACHINE_GRID, TABLE_ROW)}>
            <span className={CELL_NAME}>{m.name}</span>
            <span className={cn(CELL_QUIET, 'side truncate')}>
              {osWord(m.os)} · {m.arch}
              {m.agentVersion !== null && ` · agent ${m.agentVersion}`}
            </span>
            {/* The same labels on every row, so they recede to one quiet line
                rather than a chip each. */}
            <span className={cn(CELL_MONO, 'side')} title={m.labels.join(', ')}>
              {m.labels.join(', ')}
            </span>
            <span className={cn(CELL_QUIET, m.demand > 0 && 'text-subdued')}>
              {m.demand === 0
                ? 'no job asked for this OS'
                : `${num(m.demand)} jobs · ${num(m.minutes)} min`}
            </span>
            {/* Online is the norm; only a machine that has gone quiet, or
                cannot be read, gets a mark. */}
            <span className="flex items-center justify-end gap-2 text-right text-[0.78rem]">
              {m.box ? (
                <span className="text-muted-foreground">the control plane</span>
              ) : m.online === true ? (
                <span className="text-muted-foreground">online</span>
              ) : m.online === null ? (
                <span className="text-muted-foreground">{LINK_UNKNOWN}</span>
              ) : (
                <>
                  <Pulse on={false} tone="muted" />
                  <span className="text-warning">last heard {since(m.lastSeenAgo)}</span>
                </>
              )}
            </span>
          </li>
        ))}
      </ul>
      <p className={FOOT}>
        A runner is a label set a job asks for. The box would take the Linux jobs in a rootless
        container; a node would take its own as a service the agent supervises, the way it runs
        Claude's remote control. Nothing is started from this page yet.
      </p>
    </TableSection>
  )
}

function RegisteredWithGitHubBoard({ f }: { f: RunnersFacts }) {
  const { d, registered } = f
  return (
    <Board
      title="Registered with GitHub"
      icon="panels"
      span={4}
      aside={
        d.canListRunners ? <span className={NOTE}>read</span> : <Chip tone="warn">unreadable</Chip>
      }
    >
      {d.canListRunners ? (
        registered.length === 0 ? (
          <p className={CAPTION}>No self-hosted runner is registered on any watched repository.</p>
        ) : (
          <ul className={LIST}>
            {registered.map((r) => (
              <li key={r.name} className={ROW}>
                <Pulse
                  on={r.status === 'online'}
                  tone={r.busy ? 'accent' : r.status === 'online' ? 'ok' : 'muted'}
                />
                <span className={ROW_MAIN}>{r.name}</span>
                <span className={ROW_SIDE}>
                  {r.os} · {r.busy ? 'busy' : r.status}
                </span>
              </li>
            ))}
          </ul>
        )
      ) : (
        <p className="m-0 text-[0.8rem] leading-[1.5]">
          Listing a repository's runners needs <span className={MONO}>administration: read</span>,
          and registering one needs <span className={MONO}>administration: write</span> — far wider
          than the build App's grant. That is why the design gives runners a second, narrow App
          installed only on the repositories that opt in.
        </p>
      )}
      <p className={CAPTION}>
        {d.canListRunners
          ? d.registered
              .slice(0, 4)
              .map((r) => `${r.repo}: ${accessWord(r.access)}`)
              .join(' · ')
          : `Asked on ${String(d.registered.length)} repositories; none answered the App.`}
      </p>
    </Board>
  )
}

function DefineARunnerBoard() {
  return (
    <WipBoard
      title="Define a runner"
      span={6}
      waits="needs the runners App (administration: write) — then a runner is a row here, started per job"
    >
      <SampleRows
        rows={[
          ['Name', 'box-linux'],
          ['Machine', 'this box · Linux · X64'],
          ['Labels', 'self-hosted, linux, x64, box'],
          ['CPU · memory cap', '4 cores · 8 GiB'],
          ['At most at once', '2'],
          ['Egress', 'GitHub, npm mirror, the registry'],
          ['Lifetime', 'one job, then gone'],
        ]}
      />
    </WipBoard>
  )
}

function RunnersNowBoard() {
  return (
    <WipBoard
      title="Runners now"
      span={6}
      waits="drawn once a runner exists: what each one is doing, and its load"
    >
      <ul className="m-0 flex list-none flex-col gap-3 p-0">
        {[
          ['box-linux · 1', 'plutus · CI · test', 73, 41],
          ['box-linux · 2', 'idle', 2, 6],
          ['mac-arm64', 'daedalus · Agent · check (macos)', 88, 62],
        ].map(([name, job, cpu, mem]) => (
          <li key={String(name)} className="text-[0.8rem]">
            <div className="flex items-center gap-2">
              <span className={ROW_MAIN}>
                <b className="[font-weight:560]">{name}</b>
                <span className="ml-1.5 text-muted-foreground">{job}</span>
              </span>
              <span className={ROW_SIDE}>
                cpu {String(cpu)}% · mem {String(mem)}%
              </span>
            </div>
            <div className="mt-1.5 grid grid-cols-2 gap-2">
              <Progress pct={Number(cpu)} height={4} active={Number(cpu) > 10} />
              <Progress pct={Number(mem)} height={4} tone="info" />
            </div>
          </li>
        ))}
      </ul>
    </WipBoard>
  )
}

function QueueBoard() {
  return (
    <WipBoard
      title="Queue"
      span={4}
      waits="needs the workflow_job webhook: a queued job with a matching label starts a runner"
    >
      <SampleRows
        rows={[
          ['argus · e2e · seeded', 'waiting 12 s · self-hosted, linux'],
          ['santree · Release · sign', 'waiting 40 s · self-hosted, macos, arm64'],
        ]}
      />
      <p className={FOOT}>a cap on runners at once, and what is waiting when it is hit</p>
    </WipBoard>
  )
}

function ThisMonthHereInsteadOfHostedBoard() {
  return (
    <WipBoard
      title="This month, here instead of hosted"
      span={4}
      waits="counted once runners take jobs"
    >
      <SampleRows
        rows={[
          ['Jobs taken here', '38'],
          ['Minutes not billed', '1,240'],
          ['Of which macOS', '1,100'],
          ['Longest job', 'Agent · check (macos) · 14 min'],
        ]}
      />
    </WipBoard>
  )
}

function HowARunnerHereWouldWorkBoard() {
  return (
    <Board title="How a runner here would work" icon="logs" span={12}>
      <ul className="m-0 grid list-none gap-x-6 gap-y-3 p-0 text-[0.8rem] leading-[1.55] text-muted-foreground sm:grid-cols-2 [&_b]:text-foreground">
        <li>
          <b className="[font-weight:560]">Per job, then gone.</b> A{' '}
          <span className={MONO}>workflow_job</span> arrives queued with a matching label; the box
          mints a just-in-time runner config, starts one rootless container with a dedicated uid and
          the builder's egress fence, and it takes exactly that job and exits. No idle runner, no
          long-lived registration, nothing shared between jobs.
        </li>
        <li>
          <b className="[font-weight:560]">On the other machines, through the agent.</b> The PC and
          the Mac run a runner as a declared service the agent supervises, the way it runs Claude's
          remote control today, with the same per-job lifetime. macOS jobs are the ones worth
          moving: ten billed minutes for every wall minute.
        </li>
        <li>
          <b className="[font-weight:560]">Runners run CI, never fleet images.</b> An image reaches
          the registry through daedalus's own build path and nothing else; a runner that could push
          one would be a second deploy path with none of the checks.
        </li>
        <li>
          <b className="[font-weight:560]">A second, narrow App.</b> Registering a runner needs{' '}
          <span className={MONO}>administration: write</span> on the repository, so it gets its own
          App, installed only on the repositories that opt in, sealed in the same vault as the build
          App's key.
        </li>
      </ul>
      <p className={FOOT}>
        The design is PLAN.md's feature 11.{' '}
        <Ext
          href="https://docs.github.com/en/actions/hosting-your-own-runners"
          className="text-primary"
        >
          GitHub's self-hosted runner docs
        </Ext>{' '}
        are the reference for the label and JIT-config mechanics.
      </p>
    </Board>
  )
}
