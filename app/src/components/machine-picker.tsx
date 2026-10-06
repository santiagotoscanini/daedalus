import { Link } from '@tanstack/react-router'

import { cn } from '../lib/cn'
import type { NodeRow } from '../lib/repo/nodes'
import { MONO, SEGMENT_ITEM, SEGMENT_ITEM_ON, SEGMENT_TRACK } from './tokens'

// The machine picker: this box, then every approved node, above the System
// tabs — the one page whose subject exists on every machine, now that
// Claude is a tab of it. Drawn only once there is a node: a box alone has
// nothing to pick. One segmented control, like every other one-of-N.

const OS_MARK: Record<string, { src: string; invert: boolean }> = {
  windows: { src: '/icon-windows.svg', invert: false },
  macos: { src: '/icon-apple.svg', invert: true },
  linux: { src: '/icon-linux.svg', invert: true },
}

export function MachinePicker({
  nodes,
  active,
  tab,
}: {
  nodes: NodeRow[]
  active: string | null
  /** The tab to keep while switching machine; the target resolves an id it lacks to its first. */
  tab?: string
}) {
  if (nodes.length === 0) return null
  const item = (selected: boolean) => cn(SEGMENT_ITEM, selected && SEGMENT_ITEM_ON)
  const link = (machine: string | null, selected: boolean, children: React.ReactNode) => (
    <Link
      to="/c/$category"
      params={{ category: 'system' }}
      search={{ ...(tab === undefined ? {} : { tab }), ...(machine === null ? {} : { machine }) }}
      aria-current={selected ? 'page' : undefined}
      className={item(selected)}
    >
      {children}
    </Link>
  )
  return (
    <nav aria-label="Machine" className="mb-4 flex max-w-full overflow-x-auto">
      <div className={SEGMENT_TRACK}>
        {link(
          null,
          active === null,
          <>
            <img src="/icon-nixos.webp" alt="" width={14} height={14} className="size-3.5" />
            This box
          </>,
        )}
        {nodes.map((n) => {
          const mark = OS_MARK[n.os]
          return (
            <span key={n.id} className="contents">
              {link(
                n.id,
                active === n.id,
                <>
                  {mark !== undefined && (
                    <img
                      src={mark.src}
                      alt=""
                      width={14}
                      height={14}
                      className={cn('size-3.5', mark.invert && 'dark:invert')}
                    />
                  )}
                  {n.name}
                  {/* How many Claude sessions are on it — on every tab, so the item
                      is the same width whichever tab is open. */}
                  {n.claude !== null && n.claude.sessions > 0 && (
                    <span className={cn(MONO, 'text-[0.72rem] text-muted-foreground tabular-nums')}>
                      {n.claude.sessions}
                    </span>
                  )}
                </>,
              )}
            </span>
          )
        })}
      </div>
    </nav>
  )
}
