// The registration table: five deep until asked, a usage bar per client.

import { useState } from 'react'
import { NUM_CELL } from '../../../components/modules/parts'
import {
  CELL_QUIET,
  TABLE,
  TABLE_HEAD,
  TABLE_ROW,
  TABLE_ROW_LINK,
  TableMore,
} from '../../../components/table'
import { CAPTION, EMPTY } from '../../../components/tokens'
import { Chip } from '../../../components/viz'
import { cn } from '../../../lib/cn'
import { DASH, num } from '../../../lib/format'
import type { IdpData } from '../data/signin'

/** How many registrations the table shows before it is asked for the rest. */
const APPS_SHOWN = 5

/* One grid for the head and every row. The bar is the comparison and gives
   way first when the board is narrow; the name truncates, its full form on
   hover. */
const GRID = cn(
  'grid items-center gap-x-6 px-5',
  'grid-cols-[minmax(0,1.5fr)_minmax(6rem,1fr)_4rem_7.5rem]',
  '@max-[36rem]/table:grid-cols-[minmax(0,1fr)_4rem_7.5rem]',
)
const HIDE_NARROW = '@max-[36rem]/table:hidden'

/* The row is a <details>; its summary is the grid, so the whole line opens it. */
const SUMMARY = cn(
  GRID,
  'min-h-11 cursor-pointer list-none py-2 outline-none [&::-webkit-details-marker]:hidden',
  'focus-visible:shadow-[inset_0_0_0_2px_var(--brand-dim)]',
)
const NAME = 'flex min-w-0 items-center gap-2 text-[0.84rem] text-foreground [font-weight:520]'
/* The disclosure mark: turns with the row. */
const MARK =
  'flex-none text-[0.6rem] text-muted-foreground transition-transform group-open/app:rotate-90'

/* The usage bar: the list is ordered by recency, so volume is drawn here. */
const TRACK = 'block h-1.5 overflow-hidden rounded-full bg-foreground/[0.07]'
const FILL =
  'block h-full origin-left animate-[bar-grow_600ms_cubic-bezier(0.2,0.9,0.2,1)_both] rounded-full bg-muted-foreground opacity-70 motion-reduce:animate-none'

/* The opened row: who went in, as a nested list indented under the name. */
const BODY = 'flex flex-col gap-2 pr-5 pb-4 pl-10'
const OPENS =
  'm-0 flex list-none flex-col p-0 [&>li]:grid [&>li]:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_6rem] [&>li]:items-center [&>li]:gap-x-4 [&>li]:border-hairline [&>li]:py-1.5 [&>li]:text-[0.8rem] [&>li+li]:border-t'

/** The count column. Exported for the devices table, which counts the same way. */
export const COUNT = cn(NUM_CELL, 'text-[0.84rem] text-foreground')

/**
 * The registration table, five deep until asked.
 *
 * The full list runs past a screen, most of it the tail nobody looks at. Five
 * is the part that changes — the list is ordered by recency, so the top of it
 * IS the recent activity — and the rest is one click away for the times the
 * question is about the tail.
 */
export function AppList({ clients, max }: { clients: IdpData['clients']; max: number }) {
  const [all, setAll] = useState(false)
  const shown = all ? clients : clients.slice(0, APPS_SHOWN)
  const rest = clients.length - APPS_SHOWN

  return (
    <ul className={TABLE}>
      <li className={cn(GRID, TABLE_HEAD)}>
        <span>{all ? 'Every registration' : `Last ${String(APPS_SHOWN)} used`}</span>
        <span className={HIDE_NARROW}>Use</span>
        <span className={NUM_CELL}>Opens</span>
        <span className={NUM_CELL}>Last opened</span>
      </li>
      {shown.map((c) => (
        <AppRow key={c.id} c={c} max={max} />
      ))}
      {rest > 0 && (
        <TableMore
          open={all}
          onToggle={() => {
            setAll(!all)
          }}
          more={`Show all ${String(clients.length)}`}
          less="Show fewer"
        />
      )}
    </ul>
  )
}

/**
 * One registered application, with its accesses folded behind it.
 *
 * A `<details>` rather than two panels, because the two questions are nested
 * rather than parallel: "which of these is still in use" is asked of the whole
 * list at a glance, and "who went into THAT one, from what" is asked of one
 * row you are already looking at. Side by side, the second would be a column
 * of near-identical lines that reads as a log — which is Pocket ID's own audit
 * page's job.
 *
 * A never-opened registration still gets a row, and still opens: it says so,
 * which is the answer.
 */
function AppRow({ c, max }: { c: IdpData['clients'][number]; max: number }) {
  const idle = c.used === 0

  return (
    <li className={cn(TABLE_ROW, TABLE_ROW_LINK, 'py-0')}>
      <details className="group/app">
        <summary className={SUMMARY}>
          <span className={NAME}>
            <span className={MARK} aria-hidden="true">
              ▸
            </span>
            <span className="truncate" title={c.host ?? c.name}>
              {c.name}
            </span>
            {/* The exception: open to anyone rather than to a named group. */}
            {!c.restricted && (
              <Chip tone="warn" title="Open to every account, not a named group">
                any account
              </Chip>
            )}
            {/* Which of a hostname's registrations this one is — see `role` in
                data/signin.ts. Not a fault, so it is not drawn as one. */}
            {c.role !== null && (
              <Chip
                tone="muted"
                title={
                  c.role === 'gate'
                    ? 'The credential traefik’s forward-auth middleware signs in with, before the request reaches the app'
                    : 'The credential the app itself runs its own login with'
                }
              >
                {c.role === 'gate' ? 'proxy gate' : 'app login'}
              </Chip>
            )}
          </span>
          {/* Muted for a row with nothing in it, so the tail of the list
              reads as a tail rather than as a column of empty tracks. */}
          <span className={cn(TRACK, HIDE_NARROW, idle && 'opacity-25')}>
            {!idle && (
              <span
                className={FILL}
                style={{ width: `${String(Math.max(1.5, (c.used / max) * 100))}%` }}
              />
            )}
          </span>
          <span className={cn(COUNT, idle && 'text-muted-foreground')}>
            {idle ? DASH : num(c.used)}
          </span>
          <span className={cn(CELL_QUIET, 'text-right whitespace-nowrap')}>
            {c.lastAgo ?? 'not in the window'}
          </span>
        </summary>

        <div className={BODY}>
          {c.opens.length === 0 ? (
            <p className={EMPTY}>
              Nobody opened this in the window. For an app behind the proxy gate that means nobody
              visited it. The registration is what the middleware itself signs in with.
            </p>
          ) : (
            <ul className={OPENS}>
              {c.opens.map((o) => (
                <li key={o.id}>
                  <span className="flex min-w-0 items-center gap-2 text-foreground">
                    <span className="truncate">{o.username}</span>
                    {/* Not "first time" — see `opens[].consent`. */}
                    {o.consent && (
                      <Chip
                        tone="info"
                        title="A consent record was created here rather than reused. Pocket ID drops the stored one whenever the client is rewritten, which every rebuild does"
                      >
                        re-consented
                      </Chip>
                    )}
                  </span>
                  <span className="truncate text-[0.78rem] text-muted-foreground">{o.device}</span>
                  <span className={cn(CELL_QUIET, 'text-right')}>{o.ago}</span>
                </li>
              ))}
            </ul>
          )}
          {c.used > c.opens.length && (
            <p className={CAPTION}>
              The {num(c.opens.length)} most recent of {num(c.used)}. The rest are in Pocket ID.
            </p>
          )}
        </div>
      </details>
    </li>
  )
}
