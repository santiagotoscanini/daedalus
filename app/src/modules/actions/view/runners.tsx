import { FOOT, LIST, MONO, NOTE, ROW, ROW_MAIN, ROW_SIDE } from '../../../components/tokens'
import { Board, BoardGrid, Chip, Progress, Pulse, Stat, StatStrip } from '../../../components/viz'
import { num, since } from '../../../lib/format'
import type { ActionsData } from '../data'
import { accessWord, Ext, osWord, SampleRows, WipBoard } from './shared'

type Runners = Extract<ActionsData, { tab: 'runners' }>

export function RunnersView({ d }: { d: Runners }) {
  const online = d.machines.filter((m) => m.online).length
  const registered = d.registered.flatMap((r) => r.runners)
  const demandTotal = d.demand.reduce((s, x) => s + x.jobs, 0)
  const minutesTotal = d.demand.reduce((s, x) => s + x.minutes, 0)

  return (
    <>
      <StatStrip>
        <Stat
          label="machines on the network"
          value={num(d.machines.length)}
          sub={`${num(online)} online`}
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
        <Board
          title="Machines that could take a job"
          icon="grid"
          span={8}
          aside={<span className={NOTE}>this box and every approved node</span>}
        >
          <ul className={LIST}>
            {d.machines.map((m) => (
              <li
                key={m.id}
                className="border-(--border-soft) border-t py-[0.45rem] first:border-t-0"
              >
                <div className="flex min-w-0 items-center gap-[0.45rem] text-[0.77rem]">
                  <Pulse on={m.online} tone={m.online ? 'ok' : 'muted'} />
                  <span className={ROW_MAIN}>
                    <b className="font-[550]">{m.name}</b>
                    <span className="ml-[0.4rem] text-muted-foreground">
                      {osWord(m.os)} · {m.arch}
                      {m.agentVersion !== null && ` · agent ${m.agentVersion}`}
                    </span>
                  </span>
                  <span className={ROW_SIDE}>
                    {m.box
                      ? 'the control plane'
                      : m.online
                        ? 'online'
                        : `seen ${since(m.lastSeenAgo)} ago`}
                  </span>
                </div>
                <p className="m-0 mt-[0.25rem] flex flex-wrap items-center gap-[0.3rem] text-[0.72rem] text-muted-foreground">
                  <span>would answer to</span>
                  {m.labels.map((l) => (
                    <span
                      key={l}
                      className={`${MONO} rounded border border-(--border-soft) px-[0.3rem] py-[0.05rem]`}
                    >
                      {l}
                    </span>
                  ))}
                  <span className="ml-auto tabular-nums">
                    {m.demand === 0
                      ? 'no job asked for this OS'
                      : `${num(m.demand)} jobs · ${num(m.minutes)} min a month ask for it`}
                  </span>
                </p>
              </li>
            ))}
          </ul>
          <p className={FOOT}>
            A runner is a label set a job asks for. The box would take the Linux jobs in a rootless
            container; the PC and the Mac would take theirs as a service the agent supervises, like
            Claude's remote control. Nothing is started from this page yet.
          </p>
        </Board>

        <Board
          title="Registered with GitHub"
          icon="panels"
          span={4}
          aside={
            <Chip tone={d.canListRunners ? 'ok' : 'warn'}>
              {d.canListRunners ? 'read' : 'unreadable'}
            </Chip>
          }
        >
          {d.canListRunners ? (
            registered.length === 0 ? (
              <p className={FOOT}>No self-hosted runner is registered on any watched repository.</p>
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
              Listing a repository's runners needs{' '}
              <span className={MONO}>administration: read</span>, and registering one needs{' '}
              <span className={MONO}>administration: write</span> — far wider than the build App's
              grant. That is why the design gives runners a second, narrow App installed only on the
              repositories that opt in.
            </p>
          )}
          <p className={`${FOOT} mt-[0.4rem]`}>
            {d.canListRunners
              ? d.registered
                  .slice(0, 4)
                  .map((r) => `${r.repo}: ${accessWord(r.access)}`)
                  .join(' · ')
              : `Asked on ${String(d.registered.length)} repositories; none answered the App.`}
          </p>
        </Board>

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

        <WipBoard
          title="Runners now"
          span={6}
          waits="drawn once a runner exists: what each one is doing, and its load"
        >
          <ul className="m-0 flex list-none flex-col gap-[0.5rem] p-0">
            {[
              ['box-linux · 1', 'plutus · CI · test', 73, 41],
              ['box-linux · 2', 'idle', 2, 6],
              ['mac-arm64', 'daedalus · Agent · check (macos)', 88, 62],
            ].map(([name, job, cpu, mem]) => (
              <li key={String(name)} className="text-[0.77rem]">
                <div className="flex items-center gap-[0.45rem]">
                  <span className={ROW_MAIN}>
                    <b className="font-[550]">{name}</b>
                    <span className="ml-[0.4rem] text-muted-foreground">{job}</span>
                  </span>
                  <span className={ROW_SIDE}>
                    cpu {String(cpu)}% · mem {String(mem)}%
                  </span>
                </div>
                <div className="mt-[0.2rem] grid grid-cols-2 gap-[0.4rem]">
                  <Progress pct={Number(cpu)} height={4} active={Number(cpu) > 10} />
                  <Progress pct={Number(mem)} height={4} tone="info" />
                </div>
              </li>
            ))}
          </ul>
        </WipBoard>

        <WipBoard
          title="Queue"
          span={6}
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

        <WipBoard
          title="This month, here instead of hosted"
          span={6}
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

        <Board title="How a runner here would work" icon="logs" span={12}>
          <ul className="m-0 grid list-none gap-x-[1.2rem] gap-y-[0.35rem] p-0 text-[0.78rem] leading-[1.5] sm:grid-cols-2">
            <li>
              <b className="font-[550]">Per job, then gone.</b> A{' '}
              <span className={MONO}>workflow_job</span> arrives queued with a matching label; the
              box mints a just-in-time runner config, starts one rootless container with a dedicated
              uid and the builder's egress fence, and it takes exactly that job and exits. No idle
              runner, no long-lived registration, nothing shared between jobs.
            </li>
            <li>
              <b className="font-[550]">On the other machines, through the agent.</b> The PC and the
              Mac run a runner as a declared service the agent supervises, the way it runs Claude's
              remote control today, with the same per-job lifetime. macOS jobs are the ones worth
              moving: ten billed minutes for every wall minute.
            </li>
            <li>
              <b className="font-[550]">Runners run CI, never fleet images.</b> An image reaches the
              registry through daedalus's own build path and nothing else; a runner that could push
              one would be a second deploy path with none of the checks.
            </li>
            <li>
              <b className="font-[550]">A second, narrow App.</b> Registering a runner needs{' '}
              <span className={MONO}>administration: write</span> on the repository, so it gets its
              own App, installed only on the repositories that opt in, sealed in the same vault as
              the build App's key.
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
      </BoardGrid>
    </>
  )
}
