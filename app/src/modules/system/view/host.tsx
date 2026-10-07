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
import type { Tone } from '../../../lib/tone'
import type { SystemData } from '../data'
import { RestartControl } from './restart'
import { HOST_READERS, PARTS } from './shared'

/* ── Host ─────────────────────────────────────────────────────────────── */

type Host = Extract<SystemData, { tab: 'host' }>

// The page in reading order, each row a pair or a trio of related heights:
//
//   failed units (only when there are any — a fault goes above everything)
//   Load ················· Temperature      what the machine is doing now
//   Running · Pressure · The box            the small facts, three of a size
//   Controller ··········· Generations      two lists of about one length
//   Host journal
//
// Load is the focal point: the cpu figure is the one number on the page set
// large, and everything else steps down from it.

/** The figure the page is about: set larger than anything else on the tab. */
const HEADLINE =
  'm-0 text-[2.25rem] leading-none tracking-[-0.035em] text-foreground tabular-nums [font-weight:560]'

/** A temperature only takes colour when it is one to worry about. */
function heat(c: number): Tone {
  return c >= 85 ? 'bad' : c >= 75 ? 'warn' : 'muted'
}

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
      span={8}
      aside={c.reachable ? <Chip tone="ok">running</Chip> : <Chip tone="bad">not reachable</Chip>}
    >
      {c.reachable ? (
        <Facts
          list
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
              // One quiet line: a pill per capability, seven of them, was the
              // loudest thing on a panel whose verdict is the chip above.
              v:
                c.capabilities.length === 0 ? (
                  DASH
                ) : (
                  <span className={cn(MONO, 'text-muted-foreground')}>
                    {c.capabilities.join(' · ')}
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
  // The named list is the snapshot's and the count is prometheus's, and either
  // can lead the other by ten minutes — so either one saying "failed" earns
  // the board. Healthy, the Running board's "none" says it once.
  const failing = d.failedUnitsList.length > 0 || (d.failedUnits ?? 0) > 0

  return (
    <BoardGrid>
      {failing && <FailedUnitsBoard d={d} />}

      <LoadBoard d={d} />

      <Board
        title="Temperature"
        icon="◉"
        span={4}
        aside={
          d.temps.length > 0 && (
            <span className={NOTE}>
              hottest {Math.max(...d.temps.map((t) => t.value)).toFixed(0)}°
            </span>
          )
        }
      >
        <BarList
          items={d.temps.map((t) => ({
            ...t,
            display: `${t.value.toFixed(0)}°`,
            tone: heat(t.value),
          }))}
          tone="muted"
          empty="no sensors reporting"
        />
        <p className={FOOT}>
          Every hwmon sensor the host reports. A bar takes colour only when its reading is one to
          act on: amber from 75°, red from 85°.
        </p>
      </Board>

      <RunningBoard d={d} failing={failing} />

      <PressureBoard d={d} />

      {/* The machine itself, on the tab about the machine itself. It carries
          no reading and is not trying to: every other panel here is a number
          that moves, and this is the one thing on the page you could put a
          hand on. The specification lives on Build — this is recognition, and
          a link to the rest.

          It is also where the restart lives, for the same reason: the one
          control that acts on the object rather than on a service belongs on
          the panel that IS the object. */}
      <TheBoxBoard d={d} />

      <ControllerBoard c={d.controller} />

      <GenerationsBoard d={d} />

      <HostJournalBoard />
    </BoardGrid>
  )
}

function LoadBoard({ d }: { d: Host }) {
  return (
    <Board
      title="Load"
      icon="◔"
      span={8}
      aside={<span className={NOTE}>{num(d.cores)} threads · last 6h</span>}
    >
      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-3">
        <div className="flex flex-col gap-1.5">
          <span className="text-[0.75rem] text-muted-foreground">cpu now</span>
          <p className={HEADLINE}>{pct(d.cpuPct, 1)}</p>
        </div>
        <Measures
          items={[
            { k: 'load 1m', v: num(d.load.m1, 2) },
            { k: 'load 5m', v: num(d.load.m5, 2) },
            { k: 'load 15m', v: num(d.load.m15, 2) },
          ]}
        />
      </div>
      <Trend values={d.cpuSpark} tone="accent" height={96} />
      <p className={FOOT}>
        Six hours of cpu, and the load averages beside it for scale: on {num(d.cores)} threads a
        load of {num(d.cores)} is fully committed, not overloaded. What load cannot tell you is what
        those tasks were waiting FOR, which is the Pressure panel below.
      </p>
    </Board>
  )
}

function PressureBoard({ d }: { d: Host }) {
  return (
    <Board title="Pressure" icon="⌁" span={4} aside={<span className={NOTE}>share of time</span>}>
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

function TheBoxBoard({ d }: { d: Host }) {
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

function RunningBoard({ d, failing }: { d: Host; failing: boolean }) {
  return (
    <Board title="Running" icon="▣" span={4}>
      <Facts
        rows={[
          { k: 'Uptime', v: duration(d.uptimeSeconds) },
          { k: 'Kernel', v: d.kernel === null ? DASH : <span className={MONO}>{d.kernel}</span> },
          { k: 'Containers', v: num(d.containers.total) },
          {
            k: 'Failed units',
            // Healthy is a quiet word; only a fault takes colour.
            v:
              d.failedUnits === null ? (
                DASH
              ) : d.failedUnits > 0 ? (
                <span className="text-danger">{num(d.failedUnits)}</span>
              ) : (
                <span className="text-muted-foreground">none</span>
              ),
          },
        ]}
      />
      {d.containers.down.length > 0 && (
        // Named, not counted — "3 containers down" makes you go hunting.
        <p className={cn(CAPTION, 'text-danger')}>Not answering: {d.containers.down.join(', ')}</p>
      )}
      {!failing && (
        <p className={FOOT}>
          No systemd unit on the box is in the failed state: everything that ran either succeeded or
          is still running. {FAILED_UNITS_NOTE}
        </p>
      )}
    </Board>
  )
}

/** What "no failed units" does and does not claim, wherever it is said. */
const FAILED_UNITS_NOTE = (
  <>
    The count is prometheus&rsquo;s and the named list the host snapshot&rsquo;s, which the count
    can lead by up to ten minutes. Empty is a weaker claim than it sounds on this box: every
    container unit is a green <span className={MONO}>Type=oneshot</span> whose container can die
    without the unit noticing, so &ldquo;no failed units&rdquo; and &ldquo;every container
    alive&rdquo; are different questions. The second is the Containers row and its list of who is
    not answering.
  </>
)

/** Drawn only while something has failed: a fault opens the page. */
function FailedUnitsBoard({ d }: { d: Host }) {
  return (
    <Board
      title={d.failedUnitsList.length === 0 ? 'No failed units' : 'Failed units'}
      icon="⚑"
      span={12}
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
      <p className={FOOT}>Named, from the host snapshot. {FAILED_UNITS_NOTE}</p>
    </Board>
  )
}

function GenerationsBoard({ d }: { d: Host }) {
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
              <span className={cn(ROW_MAIN, 'tabular-nums', !g.current && 'text-subdued')}>
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
