import type { SystemData } from '../../../lib/dashboard/categories/system'
import { DASH, duration, num, pct } from '../../../lib/format'
import { LogBoard } from '../../logs'
import { BarList, Board, BoardGrid, Chip, Facts, Measures, Trend } from '../../viz'
import { HOST_READERS, PARTS, PartPhoto } from './shared'

/* ── Host ─────────────────────────────────────────────────────────────── */

type Host = Extract<SystemData, { tab: 'host' }>

export function HostView({ d }: { d: Host }) {
  return (
    <BoardGrid>
      <Board
        title="Load"
        icon="◔"
        span={8}
        aside={<span className="board-note">{num(d.cores)} threads</span>}
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
        <p className="board-foot">
          Six hours of cpu, and the load averages beside it for scale: on {num(d.cores)} threads a
          load of {num(d.cores)} is fully committed, not overloaded. What load cannot tell you is
          what those tasks were waiting FOR, which is the panel to the right.
        </p>
      </Board>

      <Board title="Pressure" icon="⌁" span={4}>
        {/* PSI is the number load average was always a proxy for. Everything
            here is normally zero; the panel exists for the day it is not. */}
        <Facts
          rows={[
            { k: 'CPU stalled', v: pct(d.pressure.cpu, 2) },
            { k: 'I/O stalled', v: pct(d.pressure.io, 2) },
            { k: 'Memory stalled', v: pct(d.pressure.memory, 2) },
          ]}
        />
        <p className="board-foot">
          The share of time in which <em>something</em> was waiting on each resource rather than
          running. Zero is the healthy reading and the usual one; I/O climbing while cpu stays flat
          is a disk problem wearing a performance problem&rsquo;s clothes.
        </p>
      </Board>

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
          a link to the rest. */}
      <Board title="The box" icon="▣" span={4}>
        <div className="part">
          <PartPhoto part={PARTS.case} />
          <div className="part-id">
            <strong className="part-name">{PARTS.case.name}</strong>
            <span className="part-detail">
              {d.kernel === null ? 'kernel unread' : `Linux ${d.kernel}`}, up{' '}
              {duration(d.uptimeSeconds)}.
            </span>
          </div>
        </div>
      </Board>

      <Board title="Running" icon="▣" span={4}>
        <Facts
          rows={[
            { k: 'Uptime', v: duration(d.uptimeSeconds) },
            { k: 'Kernel', v: d.kernel === null ? DASH : <span className="mono">{d.kernel}</span> },
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
          <p className="board-foot text-bad">Not answering: {d.containers.down.join(', ')}</p>
        )}
      </Board>

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
          <p className="viz-empty">
            No systemd unit on the box is in the failed state — every service, timer and oneshot
            that ran either succeeded or is still running.
          </p>
        ) : (
          <ul className="itemlist">
            {d.failedUnitsList.map((u) => (
              <li key={u.unit}>
                <Chip tone="bad">{u.subState ?? 'failed'}</Chip>
                <span className="item-main mono">{u.unit}</span>
                <span className="item-side">{u.description ?? ''}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="board-foot">
          Named, from the host snapshot — the count in the panel above is prometheus&rsquo;s and can
          lead this list by up to ten minutes. Empty is a weaker claim than it sounds on this box:
          every container unit is a green <span className="mono">Type=oneshot</span> whose container
          can die without the unit noticing, so &ldquo;no failed units&rdquo; and &ldquo;every
          container alive&rdquo; are different questions — the second is the Containers row and its
          list of who is not answering.
        </p>
      </Board>

      <Board
        title="Generations"
        icon="⎌"
        span={4}
        aside={<span className="board-note">{num(d.generations.length)} on disk</span>}
      >
        <ul className="itemlist">
          {[...d.generations]
            .reverse()
            .slice(0, 6)
            .map((g) => (
              <li key={g.id}>
                <span className="item-main">
                  #{g.id}
                  {g.current && (
                    <>
                      {' '}
                      <Chip tone="ok">current</Chip>
                    </>
                  )}
                </span>
                <span className="item-side">{g.date}</span>
              </li>
            ))}
        </ul>
        <p className="board-foot">
          The rollback path: reboot and pick one from the systemd-boot menu.{' '}
          <span className="mono">configurationLimit = 10</span> bounds that MENU — it does not prune
          the profile, which is why {num(d.generations.length)} are on disk. They cost store space
          until a garbage collection runs, and nothing here schedules one.
        </p>
      </Board>

      <LogBoard
        source={{ unit: 'init.scope' }}
        title="Host journal"
        neighbours={HOST_READERS}
        foot={
          <p className="board-foot">
            PID 1&rsquo;s own stream — unit starts, stops and failures for the whole box. Systemd
            files its &ldquo;Starting&rdquo; and &ldquo;Finished&rdquo; lines here rather than under
            the unit they are about, which is why a oneshot that succeeded looks silent in its own
            log and lands in this one.
          </p>
        }
      />
    </BoardGrid>
  )
}
