import { Link } from '@tanstack/react-router'

import { cn } from '../lib/cn'
import type { NodeRow } from '../lib/repo/nodes'
import { MONO } from './tokens'

// The machine picker: this box, then every approved node. On the pages
// whose subject exists on every machine — System, Claude — the same row
// above the tabs, so the eye learns it once. Drawn only once there is a
// node: a box alone has nothing to pick.

const OS_MARK: Record<string, { src: string; invert: boolean }> = {
  windows: { src: '/icon-windows.svg', invert: false },
  macos: { src: '/icon-apple.svg', invert: true },
  linux: { src: '/icon-linux.svg', invert: true },
}

export function MachinePicker({
  nodes,
  active,
  page,
}: {
  nodes: NodeRow[]
  active: string | null
  /** Which page's picker this is, so each link keeps that page's route and search. */
  page: 'claude' | 'system'
}) {
  if (nodes.length === 0) return null
  const pill = (selected: boolean) =>
    cn(
      'inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[0.8rem] transition-colors',
      selected
        ? 'border-primary bg-primary/10 text-foreground'
        : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground',
    )
  const link = (machine: string | null, className: string, children: React.ReactNode) =>
    page === 'claude' ? (
      <Link to="/claude" search={machine === null ? {} : { machine }} className={className}>
        {children}
      </Link>
    ) : (
      <Link
        to="/c/$category"
        params={{ category: 'system' }}
        search={machine === null ? {} : { machine }}
        className={className}
      >
        {children}
      </Link>
    )
  return (
    <nav aria-label="Machine" className="mb-4 flex flex-wrap items-center gap-2">
      {link(
        null,
        pill(active === null),
        <>
          <img src="/icon-nixos.webp" alt="" width={14} height={14} className="size-3.5" />
          This box
        </>,
      )}
      {nodes.map((n) => {
        const mark = OS_MARK[n.os]
        return (
          <span key={n.id}>
            {link(
              n.id,
              pill(active === n.id),
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
                {page === 'claude' && n.claude !== null && n.claude.sessions > 0 && (
                  <span className={`${MONO} text-[0.7rem] text-(--dim)`}>{n.claude.sessions}</span>
                )}
              </>,
            )}
          </span>
        )
      })}
    </nav>
  )
}
