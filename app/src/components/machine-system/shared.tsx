import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'

import type { NodeTelemetry } from '../../lib/agent/status'
import { cn } from '../../lib/cn'
import type { BoxHead as BoxHeadData } from '../../lib/dashboard/box-head'
import type { NodeSystemData } from '../../lib/dashboard/node-system'
import { bytes, DASH, since } from '../../lib/format'
import type { Tone } from '../../lib/tone'
import { EMPTY, FOOT, LIST, MONO, NOTE, ROW, ROW_MAIN } from '../tokens'
import { Board, Chip } from '../viz'

/* ── shared ───────────────────────────────────────────────────────────── */

// The node's System tabs share the box's vocabulary (components/tokens.ts,
// modules/system/view/shared.tsx) on purpose: a machine is a machine, and
// the reader who has learned where the temperature sits on the box's Host
// tab should find it in the same place on a laptop's. What differs is the
// source — one agent's document rather than prometheus, ZFS and a host
// snapshot — and where the difference matters the page says so in the
// foot, as the box's pages do.

export { EMPTY, FOOT, LIST, MONO, NOTE, ROW, ROW_MAIN, ROW_SIDE, SUB } from '../tokens'

/** The part-identity block, as Build draws it on the box. */
export const PART = 'flex min-h-[2.6rem] items-center gap-[0.9rem] pb-[0.35rem]'
export const PART_ID = 'flex min-w-0 flex-auto flex-col items-start gap-[0.25rem]'
export const PART_NAME = 'text-[0.98rem] text-foreground tracking-[-0.01em] wrap-anywhere'
export const PART_DETAIL = 'text-[0.73rem] text-(--text-muted) leading-[1.4]'

export const OS_MARK: Record<string, { src: string; invert: boolean }> = {
  windows: { src: '/icon-windows.svg', invert: false },
  macos: { src: '/icon-apple.svg', invert: true },
  linux: { src: '/icon-linux.svg', invert: true },
}

/** A percentage's tone: the same thresholds the box's own pages use. */
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

export function rate(bps: number | null): string {
  return bps === null ? DASH : `${bytes(bps)}/s`
}

export function temp(c: number | null | undefined): string {
  return c == null ? DASH : `${c.toFixed(0)}°`
}

/** Hours → "13h" | "41d" | "1.2y", as the box's Disks tab says it. */
export function hours(h: number | null): string {
  if (h === null) return DASH
  if (h < 48) return `${String(h)}h`
  const years = h / 24 / 365
  return years >= 1 ? `${years.toFixed(1)}y` : `${String(Math.round(h / 24))}d`
}

/** "SMBIOS spells it 12th Gen Intel(R) Core(TM) i5-12600K". Nobody says that. */
export function cpuName(v: string | null | undefined): string {
  return v == null
    ? DASH
    : v
        .replace(/\((R|TM)\)/g, '')
        .replace(/\s+/g, ' ')
        .trim()
}

/** "Micro-Star International Co., Ltd." is a legal name, not a brand. */
export function shortVendor(v: string | null): string {
  if (v === null) return DASH
  return v
    .replace(/Micro-Star International Co\., Ltd\.?/i, 'MSI')
    .replace(/American Megatrends International, LLC\.?/i, 'AMI')
    .replace(/Apple Inc\.?/i, 'Apple')
    .replace(/Gigabyte Technology Co\., Ltd\.?/i, 'Gigabyte')
    .replace(/, (Inc|LLC|Ltd)\.?$/i, '')
}

/** RFC 3339 → "3 days ago", or the string as the OS gave it. */
export function ago(iso: string | null): string {
  if (iso === null) return DASH
  const t = Date.parse(iso)
  return Number.isNaN(t) ? iso : since((Date.now() - t) / 1000)
}

/**
 * The strip above every System tab: the machine, its OS, and how it is.
 *
 * Above the tabs rather than inside a board, because it is the subject of
 * all of them, and the same strip for this box and for a node, because the
 * picker above can change what every board below is about and the eye
 * should not have to learn two shapes to follow it. The mark is the OS's:
 * NixOS for the box, Windows or Apple for a node.
 */
export function HeadStrip({
  mark,
  name,
  chip,
  aside,
  line,
}: {
  mark: { src: string; invert: boolean } | undefined
  name: string
  chip?: { label: string; tone: Tone }
  aside?: string
  line: ReactNode
}) {
  return (
    <div className="mb-[1.1rem] flex items-start gap-[0.85rem] max-[44rem]:flex-wrap">
      {mark !== undefined && (
        <img
          src={mark.src}
          alt=""
          width={44}
          height={44}
          className={cn('block size-11 flex-none object-contain', mark.invert && 'dark:invert')}
        />
      )}
      <div className="min-w-0 flex-auto">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="m-0 text-[1.25rem] tracking-[-0.01em]">{name}</h2>
          {chip !== undefined && <Chip tone={chip.tone}>{chip.label}</Chip>}
          {aside !== undefined && <span className={NOTE}>{aside}</span>}
        </div>
        <p className={`${NOTE} mt-1`}>{line}</p>
      </div>
    </div>
  )
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

/** A node's strip, from its row, its agent's page and its telemetry. */
export function MachineHead({
  d,
}: {
  d: Pick<NodeSystemData, 'node' | 'status'> & { telemetry?: NodeTelemetry | null }
}) {
  const { node, status } = d
  const t = d.telemetry ?? null
  const edition = status?.osName || node.os
  const awake =
    status === null
      ? { label: 'not answering', tone: 'muted' as Tone }
      : status.awakeHold
        ? { label: 'held awake', tone: 'ok' as Tone }
        : status.policy.awakeHold
          ? { label: 'hold OFF', tone: 'bad' as Tone }
          : { label: 'may sleep', tone: 'muted' as Tone }

  return (
    <HeadStrip
      mark={OS_MARK[node.os]}
      name={node.name}
      chip={awake}
      aside={
        t === null ? undefined : `sampled ${since((Date.now() - Date.parse(t.sampledAt)) / 1000)}`
      }
      line={
        <>
          {edition}
          {status?.osVersion ? ` · ${status.osVersion}` : ''}
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
 * What the page can say when there is no document to draw: the agent did
 * not answer, or it is too old to carry one. Returned in place of the tabs'
 * boards, so every tab says the same thing rather than each drawing a grid
 * of dashes.
 */
export function NoDocument({ d }: { d: NodeSystemData }) {
  const { node, status } = d
  if (status === null) {
    return (
      <p className={EMPTY}>
        The agent on {node.hostname} did not answer{d.error !== null && `: ${d.error}`}. The machine
        is asleep, off, or on a network this box cannot reach; the last hello was{' '}
        {since(node.lastSeenAgo)}.
      </p>
    )
  }
  return (
    <p className={EMPTY}>
      The agent on {node.hostname} is {status.version}, which reports nothing about the machine
      beyond its name. Telemetry arrived in agent 0.7.0; the agent installs it on its own within ten
      minutes of a release, or now from{' '}
      <Link to="/settings" search={{ tab: 'machines' }}>
        Settings › Machines
      </Link>
      .
    </p>
  )
}

/**
 * The line under a board that only the full document can fill: why this
 * page is reading the open block, when it is.
 */
export function DetailNote({ d }: { d: NodeSystemData }) {
  if (d.full || d.detailError === null) return null
  return <p className={cn(FOOT, 'text-warning')}>Open page only: {d.detailError}.</p>
}

/** The agent's own list of what this OS would not let it read. */
export function NotReadable({ t }: { t: NodeTelemetry }) {
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

/**
 * A board for a reading the agent does not have yet but could.
 *
 * The shape of the answer, blurred, and one line on what it waits for.
 * Blurred rather than absent because the layout is the promise: the tab is
 * tuned to the machine, and a Windows PC has die temperatures whether or
 * not this box can read them this week. What is drawn underneath is a
 * sample in the right units, never a real number.
 */
export function WipBoard({
  title,
  icon,
  span,
  waits,
  children,
}: {
  title: string
  icon?: string
  span: 4 | 6 | 8 | 12
  /** "needs the SMC, which the agent does not read yet" */
  waits: string
  children: ReactNode
}) {
  return (
    <Board title={title} icon={icon} span={span} aside={<Chip tone="muted">in progress</Chip>}>
      <div className="relative">
        <div aria-hidden className="pointer-events-none select-none opacity-50 blur-[3px]">
          {children}
        </div>
        <div className="absolute inset-0 flex items-center justify-center p-3">
          <span className="rounded-md border border-(--border-soft) bg-(--panel) px-3 py-1.5 text-center text-[0.76rem] text-(--text-muted) leading-[1.4] shadow-sm">
            {waits}
          </span>
        </div>
      </div>
    </Board>
  )
}
