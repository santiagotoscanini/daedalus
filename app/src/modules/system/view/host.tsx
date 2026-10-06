import { LogBoard } from '../../../components/logs'
import { PART, PART_DETAIL, PART_ID, PART_NAME, PartPhoto } from '../../../components/part'
import {
  CAPTION,
  EMPTY,
  FOOT,
  LIST,
  MONO,
  NOTE,
  ROW,
  ROW_MAIN,
  ROW_SIDE,
} from '../../../components/tokens'
import { BarList, Board, BoardGrid, Chip, Facts, Measures, Trend } from '../../../components/viz'
import { cn } from '../../../lib/cn'
import { DASH, duration, num, pct } from '../../../lib/format'
import type { SystemData } from '../data'
import { RestartControl } from './restart'
import { HOST_READERS, PARTS } from './shared'

/* ── Host ─────────────────────────────────────────────────────────────── */

type Host = Extract<SystemData, { tab: 'host' }>

/**
 * The controller: the agent on the box, as it answers the app over its socket.
 * Its Claude row is the controller's own report and says so — the box's
 * Claude is still the Claude tab's, from the snapshot and its unit.
 */
function ControllerBoard({ c }: { c: Host['controller'] }) {
  return (
    <Board
      title="Controller"
      icon="⌬"
      span={12}
      aside={c.reachable ? <Chip tone="ok">running</Chip> : <Chip tone="bad">not reachable</Chip>}
    >
      {c.reachable ? (
        <Facts
          rows={[
            { k: 'Agent', v: <span className={MONO}>{c.version}</span> },
            { k: 'Mode', v: c.mode },
            { k: 'API', v: <span className={MONO}>v{c.api}</span> },
            { k: 'Up', v: duration(c.uptimeSecs) },
            { k: 'Telemetry', v: c.telemetry },
            {
              k: 'Claude, as it reports',
              v:
                c.claude === null
                  ? DASH
                  : !c.claude.wanted
                    ? 'off here'
                    : c.claude.reporting
                      ? (c.claude.state ?? 'reporting')
                      : 'not reporting',
            },
            {
              k: 'Capabilities',
              v:
                c.capabilities.length === 0 ? (
                  DASH
                ) : (
                  <span className="flex flex-wrap gap-1">
                    {c.capabilities.map((cap) => (
                      <Chip key={cap}>{cap}</Chip>
                    ))}
                  </span>
                ),
            },
          ]}
        />
      ) : (
        <p className={EMPTY}>Controller not reachable: {c.error}</p>
      )}
      <p className={FOOT}>
        The agent on this box, answering the app over the socket nix mounts into its container. It
        answers for itself for now; the other machines move onto it next. Its Claude row is its own
        report: the box&rsquo;s Claude is still the Claude tab&rsquo;s.
      </p>
    </Board>
  )
}

export function HostView({ d }: { d: Host }) {
  const f = hostFacts({ d })

  return (
    <BoardGrid>
      <LoadBoard f={f} />

      <PressureBoard f={f} />

      <Board title="Temperature" icon="◉" span={4}>
        <BarList
          items={d.temps.map((t) => ({ ...t, display: `${t.value.toFixed(0)}°` }))}
          tone="info"
          empty="no sensors reporting"
        />
      </Board>

      {/* The machine itself, on the tab about the machine itself. It carries
          no reading and is not trying to: every other panel here is a number
          that moves, and this is the one thing on the page you could put a
          hand on. The specification lives on Build — this is recognition, and
          a link to the rest.

          It is also where the restart lives, for the same reason: the one
          control that acts on the object rather than on a service belongs on
          the panel that IS the object. */}
      <TheBoxBoard f={f} />

      <RunningBoard f={f} />

      <Panel f={f} />

      <GenerationsBoard f={f} />

      <ControllerBoard c={d.controller} />

      <HostJournalBoard />
    </BoardGrid>
  )
}

/** What the page's boards read. */
function hostFacts({ d }: { d: Host }) {
  return { d }
}

type HostFacts = NonNullable<ReturnType<typeof hostFacts>>

function LoadBoard({ f }: { f: HostFacts }) {
  const { d } = f
  return (
    <Board
      title="Load"
      icon="◔"
      span={8}
      aside={<span className={NOTE}>{num(d.cores)} threads</span>}
    >
      <Trend values={d.cpuSpark} tone="accent" height={90} />
      <Measures
        items={[
          { k: 'cpu now', v: pct(d.cpuPct, 1) },
          { k: 'load 1m', v: num(d.load.m1, 2) },
          { k: 'load 5m', v: num(d.load.m5, 2) },
          { k: 'load 15m', v: num(d.load.m15, 2) },
        ]}
      />
      <p className={FOOT}>
        Six hours of cpu, and the load averages beside it for scale: on {num(d.cores)} threads a
        load of {num(d.cores)} is fully committed, not overloaded. What load cannot tell you is what
        those tasks were waiting FOR, which is the panel to the right.
      </p>
    </Board>
  )
}

function PressureBoard({ f }: { f: HostFacts }) {
  const { d } = f
  return (
    <Board title="Pressure" icon="⌁" span={4}>
      {/* PSI — see `HostData.pressure`. */}
      <Facts
        rows={[
          { k: 'CPU stalled', v: pct(d.pressure.cpu, 2) },
          { k: 'I/O stalled', v: pct(d.pressure.io, 2) },
          { k: 'Memory stalled', v: pct(d.pressure.memory, 2) },
        ]}
      />
      <p className={FOOT}>
        The share of time in which <em>something</em> was waiting on each resource rather than
        running. Zero is the healthy reading and the usual one; I/O climbing while cpu stays flat is
        a disk problem wearing a performance problem&rsquo;s clothes.
      </p>
    </Board>
  )
}

function TheBoxBoard({ f }: { f: HostFacts }) {
  const { d } = f
  return (
    <Board title="The box" icon="▣" span={4}>
      <div className={PART}>
        <PartPhoto part={PARTS.case} />
        <div className={PART_ID}>
          <strong className={PART_NAME}>{PARTS.case.name}</strong>
          <span className={PART_DETAIL}>
            {d.kernel === null ? 'kernel unread' : `Linux ${d.kernel}`}, up{' '}
            {duration(d.uptimeSeconds)}.
          </span>
        </div>
      </div>
      <RestartControl containers={d.containers.total} uptimeSeconds={d.uptimeSeconds} />
    </Board>
  )
}

function RunningBoard({ f }: { f: HostFacts }) {
  const { d } = f
  return (
    <Board title="Running" icon="▣" span={4}>
      <Facts
        rows={[
          { k: 'Uptime', v: duration(d.uptimeSeconds) },
          { k: 'Kernel', v: d.kernel === null ? DASH : <span className={MONO}>{d.kernel}</span> },
          { k: 'Containers', v: num(d.containers.total) },
          {
            k: 'Failed units',
            v:
              d.failedUnits === null ? (
                DASH
              ) : d.failedUnits > 0 ? (
                <Chip tone="bad">{num(d.failedUnits)}</Chip>
              ) : (
                <Chip tone="ok">none</Chip>
              ),
          },
        ]}
      />
      {d.containers.down.length > 0 && (
        // Named, not counted — "3 containers down" makes you go hunting.
        <p className={cn(CAPTION, 'text-danger')}>Not answering: {d.containers.down.join(', ')}</p>
      )}
    </Board>
  )
}

function Panel({ f }: { f: HostFacts }) {
  const { d } = f
  return (
    <Board
      title={d.failedUnitsList.length === 0 ? 'No failed units' : 'Failed units'}
      icon="⚑"
      span={8}
      aside={
        d.failedUnitsList.length === 0 ? (
          <Chip tone="ok">none</Chip>
        ) : (
          <Chip tone="bad">{num(d.failedUnitsList.length)}</Chip>
        )
      }
    >
      {d.failedUnitsList.length === 0 ? (
        <p className={EMPTY}>
          No systemd unit on the box is in the failed state. Everything that ran either succeeded or
          is still running.
        </p>
      ) : (
        <ul className={LIST}>
          {d.failedUnitsList.map((u) => (
            <li key={u.unit} className={ROW}>
              <Chip tone="bad">{u.subState ?? 'failed'}</Chip>
              <span className={cn(ROW_MAIN, MONO)}>{u.unit}</span>
              <span className={ROW_SIDE}>{u.description ?? ''}</span>
            </li>
          ))}
        </ul>
      )}
      <p className={FOOT}>
        Named, from the host snapshot. The count in the panel above is prometheus&rsquo;s and can
        lead this list by up to ten minutes. Empty is a weaker claim than it sounds on this box:
        every container unit is a green <span className={MONO}>Type=oneshot</span> whose container
        can die without the unit noticing, so &ldquo;no failed units&rdquo; and &ldquo;every
        container alive&rdquo; are different questions. The second is the Containers row and its
        list of who is not answering.
      </p>
    </Board>
  )
}

function GenerationsBoard({ f }: { f: HostFacts }) {
  const { d } = f
  return (
    <Board
      title="Generations"
      icon="⎌"
      span={4}
      aside={<span className={NOTE}>{num(d.generations.length)} on disk</span>}
    >
      <ul className={LIST}>
        {[...d.generations]
          .reverse()
          .slice(0, 6)
          .map((g) => (
            <li key={g.id} className={ROW}>
              <span className={ROW_MAIN}>
                #{g.id}
                {g.current && (
                  <>
                    {' '}
                    <Chip tone="ok">current</Chip>
                  </>
                )}
              </span>
              <span className={ROW_SIDE}>{g.date}</span>
            </li>
          ))}
      </ul>
      <p className={FOOT}>
        The rollback path: reboot and pick one from the systemd-boot menu.{' '}
        <span className={MONO}>configurationLimit = 10</span> bounds that MENU. It does not prune
        the profile, which is why {num(d.generations.length)} are on disk. They cost store space
        until a garbage collection runs, and nothing here schedules one.
      </p>
    </Board>
  )
}

function HostJournalBoard() {
  return (
    <LogBoard
      source={{ unit: 'init.scope' }}
      title="Host journal"
      neighbours={HOST_READERS}
      foot={
        <p className={FOOT}>
          PID 1&rsquo;s own stream: unit starts, stops and failures for the whole box. Systemd files
          its &ldquo;Starting&rdquo; and &ldquo;Finished&rdquo; lines here rather than under the
          unit they are about, which is why a oneshot that succeeded looks silent in its own log and
          lands in this one.
        </p>
      }
    />
  )
}
