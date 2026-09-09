import { useEffect, useRef, useState } from 'react'
import { cn } from '../../../lib/cn'
import type { SystemData } from '../../../lib/dashboard/categories/system'
import { DASH, duration, num, pct } from '../../../lib/format'
import { fetchPowerRequestStatus, requestRebootFn } from '../../../server/host'
import { GHOST_BTN } from '../../apps/shared'
import { LogBoard } from '../../logs'
import { Button } from '../../ui/button'
import { BarList, Board, BoardGrid, Chip, Facts, Measures, Trend } from '../../viz'
import {
  BOARD_FOOT,
  BOARD_NOTE,
  HOST_READERS,
  LIST,
  MONO,
  PART,
  PART_DETAIL,
  PART_ID,
  PART_NAME,
  PARTS,
  PartPhoto,
  ROW,
  ROW_MAIN,
  ROW_SIDE,
  VIZ_EMPTY,
} from './shared'

/* ── Host ─────────────────────────────────────────────────────────────── */

type Host = Extract<SystemData, { tab: 'host' }>

/* The restart control, under the case photo. Quiet at rest and deliberately
   not primary: it is one ghost button with no colour of its own, because a
   control that looks important gets clicked to find out what it does. The cost
   — and the red — appear only once it is armed, which is the step where they
   can still change the answer. */
const RESTART =
  'mt-[0.7rem] flex flex-col items-start gap-[0.55rem] border-(--border-soft) border-t pt-[0.75rem]'
const RESTART_COST = 'text-[0.78rem] text-(--text-muted) leading-[1.5]'
const RESTART_STATE = 'text-[0.78rem] leading-[1.5]'
const RESTART_NOTE = 'text-[0.7rem] text-muted-foreground leading-[1.5]'

/** How long an armed restart stays armed. Short enough that a control left
    armed by a distraction cannot be finished by an accidental click later. */
const ARM_MS = 10_000
/** No status naming our request within this long means the host agent never
    came for it — the same claim window components/status.tsx uses. */
const PICKUP_MS = 20_000
const HEALTH_MS = 3_000

type RestartPhase = 'idle' | 'armed' | 'dispatching' | 'refused' | 'down' | 'back'

/**
 * Restart the box.
 *
 * Two steps rather than one click, and the second step is where the cost is
 * spelled out: this is the only control in the app that takes the whole house
 * offline, because pi-hole is this machine and every device in it resolves
 * through here.
 *
 * The interesting half is what happens AFTER dispatch. Every other host action
 * settles when its status file says so; this one kills the process that would
 * write that status, so `running` is the last word from the bridge and the box
 * itself becomes the signal — /api/healthz answering again is the completion
 * event. Failed fetches in that phase are the expected path, not an error.
 */
function RestartControl({
  containers,
  uptimeSeconds,
}: {
  containers: number | null
  uptimeSeconds: number | null
}) {
  const [phase, setPhase] = useState<RestartPhase>('idle')
  const [request, setRequest] = useState<{ id: string; at: number } | null>(null)
  const [refusal, setRefusal] = useState('')
  // "Back" only means something after a "gone": the first health poll is
  // answered by a container that has not been told to stop yet, and without
  // this the restart would report itself finished before it had begun.
  // The ref is what the poll decides on — the effect closes over it once — and
  // the state beside it is what the copy reads.
  const gone = useRef(false)
  const [sawDown, setSawDown] = useState(false)

  useEffect(() => {
    if (phase !== 'armed') return
    const t = setTimeout(() => {
      setPhase('idle')
    }, ARM_MS)
    return () => {
      clearTimeout(t)
    }
  }, [phase])

  // The window in which the host is still alive to answer: it either refuses
  // (bad verb, rebuild in flight) or writes `running` on its way to the
  // reboot. Both arrive within a second or two.
  useEffect(() => {
    if (phase !== 'dispatching' || request === null) return
    let stopped = false
    const t = setInterval(() => {
      void fetchPowerRequestStatus()
        .then((s) => {
          if (stopped) return
          if (s.id !== request.id) {
            // A status file from the LAST restart says `running` forever —
            // only our own id is evidence about this request.
            if (Date.now() - request.at > PICKUP_MS) {
              setRefusal('the host did not pick this request up. Is its path unit alive?')
              setPhase('refused')
            }
            return
          }
          if (s.state === 'failed') {
            setRefusal(s.error)
            setPhase('refused')
            return
          }
          if (s.state === 'running') setPhase('down')
        })
        .catch(() => {
          // Not a failure: a server function that stops answering is what a
          // machine going down looks like from in here.
          if (!stopped) setPhase('down')
        })
    }, 1_000)
    return () => {
      stopped = true
      clearInterval(t)
    }
  }, [phase, request])

  // Nothing will ever be written to the status file again, so this phase asks
  // the box instead. /api/healthz is the one unauthenticated path (it is the
  // forward-auth bypass gatus uses), which is what makes it answerable the
  // moment the app is serving again.
  useEffect(() => {
    if (phase !== 'down') return
    let stopped = false
    const t = setInterval(() => {
      void fetch('/api/healthz', { cache: 'no-store' })
        .then((r) => {
          if (stopped) return
          if (!r.ok) {
            gone.current = true
            setSawDown(true)
            return
          }
          if (gone.current) setPhase('back')
        })
        .catch(() => {
          if (stopped) return
          gone.current = true
          setSawDown(true)
        })
    }, HEALTH_MS)
    return () => {
      stopped = true
      clearInterval(t)
    }
  }, [phase])

  if (phase === 'armed') {
    return (
      <div
        className={cn(
          RESTART,
          'border-t-[color-mix(in_srgb,var(--danger)_40%,var(--border-soft))]',
        )}
      >
        <p className={RESTART_COST}>
          Everything on this box stops for a couple of minutes.{' '}
          <strong className="font-medium text-warning">LAN DNS goes down with it</strong>: pi-hole
          is this machine, so no device in the house resolves a name until it is back.{' '}
          {containers === null ? 'Every container' : `All ${num(containers)} containers`} stop and
          start again, and {duration(uptimeSeconds)} of uptime goes back to zero.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onClick={() => {
              setRefusal('')
              gone.current = false
              setSawDown(false)
              setPhase('dispatching')
              void requestRebootFn()
                .then((r) => {
                  setRequest({ id: r.id, at: Date.now() })
                })
                .catch((e: unknown) => {
                  setRefusal(e instanceof Error ? e.message : String(e))
                  setPhase('refused')
                })
            }}
          >
            Confirm restart
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={GHOST_BTN}
            onClick={() => {
              setPhase('idle')
            }}
          >
            Cancel
          </Button>
          <span className={RESTART_NOTE}>disarms on its own in {ARM_MS / 1000}s</span>
        </div>
      </div>
    )
  }

  if (phase === 'dispatching' || phase === 'down') {
    return (
      <div className={RESTART}>
        <p className={RESTART_STATE}>
          {phase === 'dispatching'
            ? 'Asking the host to restart…'
            : sawDown
              ? 'The box is down. Waiting for it to answer again…'
              : 'Restarting. This page will stop responding shortly.'}
        </p>
        <p className={RESTART_NOTE}>
          Nothing will report this finished: the server goes down with the box. This is watching{' '}
          <span className={MONO}>/api/healthz</span> instead.
        </p>
      </div>
    )
  }

  return (
    <div className={RESTART}>
      {phase === 'back' && (
        <p className={cn(RESTART_STATE, 'text-success')}>
          The box is back, and this page is talking to it.
        </p>
      )}
      {phase === 'refused' && <p className={cn(RESTART_STATE, 'text-danger')}>{refusal}</p>}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className={GHOST_BTN}
        onClick={() => {
          setPhase('armed')
        }}
      >
        Restart the box
      </Button>
    </div>
  )
}

export function HostView({ d }: { d: Host }) {
  return (
    <BoardGrid>
      <Board
        title="Load"
        icon="◔"
        span={8}
        aside={<span className={BOARD_NOTE}>{num(d.cores)} threads</span>}
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
        <p className={BOARD_FOOT}>
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
        <p className={BOARD_FOOT}>
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
          a link to the rest.

          It is also where the restart lives, for the same reason: the one
          control that acts on the object rather than on a service belongs on
          the panel that IS the object. */}
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
          <p className={cn(BOARD_FOOT, 'text-danger')}>
            Not answering: {d.containers.down.join(', ')}
          </p>
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
          <p className={VIZ_EMPTY}>
            No systemd unit on the box is in the failed state. Everything that ran either succeeded
            or is still running.
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
        <p className={BOARD_FOOT}>
          Named, from the host snapshot. The count in the panel above is prometheus&rsquo;s and can
          lead this list by up to ten minutes. Empty is a weaker claim than it sounds on this box:
          every container unit is a green <span className={MONO}>Type=oneshot</span> whose container
          can die without the unit noticing, so &ldquo;no failed units&rdquo; and &ldquo;every
          container alive&rdquo; are different questions. The second is the Containers row and its
          list of who is not answering.
        </p>
      </Board>

      <Board
        title="Generations"
        icon="⎌"
        span={4}
        aside={<span className={BOARD_NOTE}>{num(d.generations.length)} on disk</span>}
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
        <p className={BOARD_FOOT}>
          The rollback path: reboot and pick one from the systemd-boot menu.{' '}
          <span className={MONO}>configurationLimit = 10</span> bounds that MENU. It does not prune
          the profile, which is why {num(d.generations.length)} are on disk. They cost store space
          until a garbage collection runs, and nothing here schedules one.
        </p>
      </Board>

      <LogBoard
        source={{ unit: 'init.scope' }}
        title="Host journal"
        neighbours={HOST_READERS}
        foot={
          <p className={BOARD_FOOT}>
            PID 1&rsquo;s own stream: unit starts, stops and failures for the whole box. Systemd
            files its &ldquo;Starting&rdquo; and &ldquo;Finished&rdquo; lines here rather than under
            the unit they are about, which is why a oneshot that succeeded looks silent in its own
            log and lands in this one.
          </p>
        }
      />
    </BoardGrid>
  )
}
