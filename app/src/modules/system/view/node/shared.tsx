import { Ago } from '../../../../components/ago'
import { HeadStrip, OS_MARK } from '../../../../components/machine-head'
import { EMPTY, FOOT, LIST, MONO, ROW, ROW_MAIN } from '../../../../components/tokens'
import { Board } from '../../../../components/viz'
import type { Telemetry } from '../../../../host/controller/generated'
import { cn } from '../../../../lib/cn'
import type { BoxHead as BoxHeadData } from '../../../../lib/dashboard/box-head'
import type { NodeSystemData } from '../../../../lib/dashboard/node-system'
import { bytes, DASH, since } from '../../../../lib/format'
import type { Tone } from '../../../../lib/tone'

/* ── shared ───────────────────────────────────────────────────────────── */

// The node's System tabs share the box's vocabulary (components/tokens.ts,
// modules/system/view/shared.tsx) on purpose: a machine is a machine, and
// the reader who has learned where the temperature sits on the box's Host
// tab should find it in the same place on a laptop's. What differs is the
// source — one agent's document rather than prometheus, ZFS and a host
// snapshot — and where the difference matters the page says so in the
// foot, as the box's pages do.

export {
  EMPTY,
  FOOT,
  LIST,
  MONO,
  NOTE,
  ROW,
  ROW_MAIN,
  ROW_SIDE,
  SUB,
} from '../../../../components/tokens'

/** A load or fill percentage's tone on a node's gauges. */
export function loadTone(p: number | null): Tone {
  if (p === null) return 'muted'
  if (p >= 90) return 'bad'
  if (p >= 75) return 'warn'
  return 'accent'
}

export function share(used: number | null, total: number | null): number | null {
  return used === null || total === null || total === 0 ? null : (used / total) * 100
}

/** "12.5 GB of 32 GB" */
export function ofTotal(used: number | null, total: number | null): string {
  if (used === null && total === null) return DASH
  return `${used === null ? DASH : bytes(used)} of ${total === null ? DASH : bytes(total)}`
}

/** Hours → "13h" | "41d" | "1.2y", as the box's Disks tab says it. */
export function hours(h: number | null): string {
  if (h === null) return DASH
  if (h < 48) return `${String(h)}h`
  const years = h / 24 / 365
  return years >= 1 ? `${years.toFixed(1)}y` : `${String(Math.round(h / 24))}d`
}

/** The box's own strip, from the site export and the host snapshot. */
export function BoxHead({ h }: { h: BoxHeadData }) {
  return (
    <HeadStrip
      mark={{ src: '/icon-nixos.webp', invert: false }}
      name={h.hostname}
      chip={{ label: 'this box', tone: 'ok' }}
      line={
        <>
          {h.os}
          {h.kernel !== null && ` · ${h.kernel}`}
          {` · ${h.arch}`}
          {h.model !== null && ` · ${h.model}`}
          {' · '}
          <span className={MONO}>{h.hostname}</span>
        </>
      }
    />
  )
}

/** A node's strip, from its row, its status document and its telemetry. */
export function MachineHead({
  d,
}: {
  d: Pick<NodeSystemData, 'node' | 'status'> & { telemetry?: Telemetry | null }
}) {
  const { node, status } = d
  const t = d.telemetry ?? null
  const edition = status?.os_name || node.os
  const awake =
    node.connected === null
      ? { label: 'link unknown', tone: 'muted' as Tone }
      : !node.connected
        ? { label: 'not connected', tone: 'muted' as Tone }
        : status === null
          ? { label: 'no status yet', tone: 'muted' as Tone }
          : status.awake_hold
            ? { label: 'held awake', tone: 'ok' as Tone }
            : status.policy.awake_hold
              ? { label: 'hold OFF', tone: 'bad' as Tone }
              : { label: 'may sleep', tone: 'muted' as Tone }

  return (
    <HeadStrip
      mark={OS_MARK[node.os]}
      name={node.name}
      chip={awake}
      aside={
        t === null ? undefined : (
          <>
            sampled <Ago at={t.sampled_at} />
          </>
        )
      }
      line={
        <>
          {edition}
          {status?.os_version ? ` · ${status.os_version}` : ''}
          {status?.arch ? ` · ${status.arch}` : ''}
          {t?.machine.model ? ` · ${t.machine.model}` : ''}
          {' · '}
          <span className={MONO}>{node.hostname}</span>
        </>
      }
    />
  )
}
/**
 * What the page can say when there is no document to draw: the controller
 * holds nothing from the machine, or no sample yet. Returned in place of the
 * tabs' boards, so every tab says the same thing rather than each drawing a
 * grid of dashes.
 */
export function NoDocument({ d }: { d: NodeSystemData }) {
  const { node, status } = d
  if (status === null) {
    return (
      <p className={EMPTY}>
        Nothing from {node.hostname}
        {d.error !== null && `: ${d.error}`}. The machine is asleep, off, or its agent cannot reach
        the controller; it was last heard {since(node.lastSeenAgo)}.
      </p>
    )
  }
  return (
    <p className={EMPTY}>
      {node.hostname} is connected but has not sent a sample yet; its first comes a few seconds
      after the agent starts.
    </p>
  )
}

/**
 * The line under a board that only the full document can fill: why this
 * page is reading the summary, when it is.
 */
export function DetailNote({ d }: { d: NodeSystemData }) {
  if (d.full || d.detailError === null) return null
  return <p className={cn(FOOT, 'text-warning')}>Summary only: {d.detailError}.</p>
}

/** The agent's own list of what this OS would not let it read. */
export function NotReadable({ t }: { t: Telemetry }) {
  if (t.errors.length === 0) return null
  return (
    <Board title="Not readable here" icon="⊘" span={12}>
      <ul className={LIST}>
        {t.errors.map((e) => (
          <li key={e} className={ROW}>
            <span className={ROW_MAIN}>{e}</span>
          </li>
        ))}
      </ul>
      <p className={FOOT}>
        What this operating system would not let the agent read without vendor tools, one line per
        dash it explains. The agent writes these itself, so a new line here is a new gap, not a page
        that stopped trying.
      </p>
    </Board>
  )
}
