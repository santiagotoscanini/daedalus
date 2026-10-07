import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { cn } from '../lib/cn'
import type { NodeRow } from '../lib/repo/nodes'
import { type Tone, toneStyle } from '../lib/tone'
import { OS_MARK } from './machine-head'
import { SEGMENT_ITEM, SEGMENT_ITEM_ON, SEGMENT_TRACK } from './tokens'

// THE machine picker: one segmented control for every page whose subject is
// one machine of several — System above its tabs, AI › Providers inside its
// tab. Same marks, same item shape, same place for a count and a dot, so a
// reader who has learned it on one page reads it on the other.
//
// Two layers:
//
//   `MachineSwitcher` — the control itself, over any list of items. Each item
//   says where it links, its OS mark, and optionally a short qualifier, a
//   count and a status dot. A dot is for an EXCEPTION (not answering, not
//   connected): a row of green dots on healthy machines is decoration, so a
//   caller passes `dot` only where a machine differs from the norm.
//
//   `MachinePicker` — System's use of it: this box, then every approved node,
//   each keeping the open tab.
//
// `identity` puts the picked machine's one-line description directly under the
// control, as its caption: the picker and the line naming what it picked are
// one level of navigation, not a picker, a header and then the tabs.

/** The box's own mark: it runs NixOS whatever the node OS table says. */
export const BOX_MARK = { src: '/icon-nixos.webp', invert: false }

/** Where an item goes. Every picker today lives on a category page. */
export type MachineLink = {
  to: '/c/$category'
  params: { category: string }
  search: Record<string, string | undefined>
}

export type MachineItem = {
  /** Unique within the picker. */
  key: string
  label: string
  /** An OS name from OS_MARK, or 'box' for this box's NixOS mark. */
  os: string
  selected: boolean
  link: MachineLink
  /** A short qualifier after the name, muted ("Lemonade" when a machine runs two). */
  sub?: string
  /** A small figure after the name (Claude sessions on System). Hidden when 0 or absent. */
  count?: number | null
  /** A status dot — pass it only for a machine that differs from the norm. */
  dot?: Tone | null
  /** Hover text for the item. */
  title?: string
}

// The control, then — under it, never crammed beside it — the picked machine's
// one muted line, which wraps safely at any width.
const ROW = 'mb-4 flex min-w-0 flex-col items-start gap-2'
const COUNT = 'text-[0.72rem] text-muted-foreground tabular-nums'
const DOT = 'inline-block size-1.5 flex-none rounded-full bg-(--tone)'

export function MachineSwitcher({
  items,
  label = 'Machine',
  identity,
  className,
}: {
  items: MachineItem[]
  /** The nav's accessible name. */
  label?: string
  /** The picked machine's one-line description, under the control. */
  identity?: ReactNode
  className?: string
}) {
  return (
    <nav aria-label={label} className={cn(ROW, className)}>
      <div className={cn(SEGMENT_TRACK, 'overflow-x-auto')}>
        {items.map((it) => {
          const mark = it.os === 'box' ? BOX_MARK : OS_MARK[it.os]
          return (
            <Link
              key={it.key}
              to={it.link.to}
              params={it.link.params}
              search={it.link.search}
              aria-current={it.selected ? 'page' : undefined}
              title={it.title}
              className={cn(SEGMENT_ITEM, it.selected && SEGMENT_ITEM_ON)}
            >
              {mark !== undefined && (
                <img
                  src={mark.src}
                  alt=""
                  width={14}
                  height={14}
                  className={cn('size-3.5', mark.invert && 'dark:invert')}
                />
              )}
              {it.label}
              {it.sub !== undefined && <span className="text-muted-foreground">{it.sub}</span>}
              {it.count != null && it.count > 0 && <span className={COUNT}>{it.count}</span>}
              {it.dot != null && (
                <span aria-hidden="true" className={DOT} style={toneStyle(it.dot)} />
              )}
            </Link>
          )
        })}
      </div>
      {identity !== undefined && (
        <div className="min-h-5 w-full min-w-0 text-[0.8rem] text-muted-foreground">{identity}</div>
      )}
    </nav>
  )
}

/**
 * System's picker: this box, then every approved node. Drawn only once there
 * is a node — a box alone has nothing to pick.
 *
 * The count on a node is its Claude sessions (on every tab, so an item is the
 * same width whichever tab is open); `counts` and `dots` add or override per
 * machine id, with '' as this box's key.
 */
export function MachinePicker({
  nodes,
  active,
  tab,
  dots,
  counts,
  identity,
}: {
  nodes: NodeRow[]
  active: string | null
  /** The tab to keep while switching machine; the target resolves an id it lacks to its first. */
  tab?: string
  /** A status dot per machine id ('' for this box) — exceptions only. */
  dots?: Record<string, Tone | null>
  /** A figure per machine id ('' for this box), in place of the session count. */
  counts?: Record<string, number | null>
  /** The picked machine's one-line description, under the control. */
  identity?: ReactNode
}) {
  if (nodes.length === 0) return null
  const link = (machine: string | null): MachineLink => ({
    to: '/c/$category',
    params: { category: 'system' },
    search: { ...(tab === undefined ? {} : { tab }), ...(machine === null ? {} : { machine }) },
  })
  const items: MachineItem[] = [
    {
      key: '',
      label: 'This box',
      os: 'box',
      selected: active === null,
      link: link(null),
      count: counts?.[''] ?? null,
      dot: dots?.[''] ?? null,
    },
    ...nodes.map(
      (n): MachineItem => ({
        key: n.id,
        label: n.name,
        os: n.os,
        selected: active === n.id,
        link: link(n.id),
        count: counts?.[n.id] !== undefined ? counts[n.id] : (n.claude?.sessions ?? null),
        dot: dots?.[n.id] ?? null,
        title:
          n.claude !== null && n.claude.sessions > 0
            ? `${String(n.claude.sessions)} Claude sessions`
            : undefined,
      }),
    ),
  ]
  return <MachineSwitcher items={items} identity={identity} />
}
