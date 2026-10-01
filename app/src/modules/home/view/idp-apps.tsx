// The registration list: five deep until asked, a usage bar per client.

import { useState } from 'react'
import { EMPTY, FOOT, SUB } from '../../../components/tokens'
import { Button } from '../../../components/ui/button'
import { Chip } from '../../../components/viz'
import { DASH, num } from '../../../lib/format'
import type { IdpData } from '../data/signin'
import { LIST, MAIN, SIDE } from './shared'

/** How many registrations the list shows before it is asked for the rest. */
const APPS_SHOWN = 5

/* The "show all N" toggle under the registration list, on `Button
   variant="outline"`. Left-aligned with the rows rather than centred: it is
   the continuation of the list, not a footer action. */
const BTN_MORE =
  'mt-[0.35rem] h-auto self-start px-[0.5rem] py-[0.18rem] text-[0.7rem] text-subdued hover:border-foreground/30'

/* The registration list. Half-width board, so the name column gives before the
   bar does: the bar is the comparison and a 3rem one compares nothing, while a
   truncated name is still recognisable and has its full form on hover. */
const APPS = 'mt-[0.5rem] flex list-none flex-col gap-[0.1rem]'
const APP = '[&[open]>summary]:bg-raised'
const APP_SUMMARY =
  'grid cursor-pointer list-none grid-cols-[minmax(6rem,11rem)_minmax(3rem,1fr)_2.2rem_auto] items-center gap-[0.6rem] rounded-[7px] px-[0.45rem] py-[0.3rem] text-[0.78rem] hover:bg-raised [&::-webkit-details-marker]:hidden'
/* Every `em` after the name is one badge style: a state that changes what the
   row means ("any account", "proxy gate", "app login"). */
const APP_NAME =
  'flex min-w-0 items-center gap-[0.4rem] text-foreground [&>span:first-child]:truncate [&>em]:flex-none [&>em]:rounded-full [&>em]:border [&>em]:border-warning/40 [&>em]:px-[0.35rem] [&>em]:py-[0.02rem] [&>em]:text-[0.6rem] [&>em]:text-warning [&>em]:not-italic'
const APP_WHEN = 'text-right text-[0.7rem] whitespace-nowrap tabular-nums text-muted-foreground'
const APP_BODY = 'flex flex-col gap-[0.35rem] pt-[0.3rem] pr-[0.45rem] pb-[0.7rem] pl-[1.2rem]'

/* The usage bar: the list is ordered by recency, so volume is drawn here. */
const TRACK = 'h-[5px] overflow-hidden rounded-[3px] bg-lifted'
const FILL =
  'block h-full origin-left animate-[bar-grow_600ms_cubic-bezier(0.2,0.9,0.2,1)_both] rounded-[3px] bg-info opacity-85 motion-reduce:animate-none'
export const COUNT = 'text-right text-[0.79rem] whitespace-nowrap tabular-nums text-foreground'

/**
 * The registration list, five deep until asked.
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
    <>
      <h4 className={SUB}>{all ? 'Every registration' : `Last ${String(APPS_SHOWN)} used`}</h4>
      <ul className={APPS}>
        {shown.map((c) => (
          <AppRow key={c.id} c={c} max={max} />
        ))}
      </ul>
      {rest > 0 && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={BTN_MORE}
          onClick={() => {
            setAll(!all)
          }}
        >
          {all ? 'Show fewer' : `Show all ${String(clients.length)}`}
        </Button>
      )}
    </>
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
    <li>
      <details className={APP}>
        <summary className={APP_SUMMARY}>
          <span className={APP_NAME}>
            <span title={c.host ?? c.name}>{c.name}</span>
            {!c.restricted && <em title="Open to every account, not a named group">any account</em>}
            {/* Which of a hostname's registrations this one is — see `role` in
                data/signin.ts. Not a fault, though it wears APP_NAME's one
                warning-toned badge. */}
            {c.role !== null && (
              <em
                title={
                  c.role === 'gate'
                    ? 'The credential traefik’s forward-auth middleware signs in with, before the request reaches the app'
                    : 'The credential the app itself runs its own login with'
                }
              >
                {c.role === 'gate' ? 'proxy gate' : 'app login'}
              </em>
            )}
          </span>
          {/* Muted for a row with nothing in it, so the tail of the list
              reads as a tail rather than as a column of empty tracks. */}
          <span className={idle ? `${TRACK} opacity-25` : TRACK}>
            {!idle && (
              <span
                className={FILL}
                style={{ width: `${String(Math.max(1.5, (c.used / max) * 100))}%` }}
              />
            )}
          </span>
          <span className={COUNT}>{idle ? DASH : num(c.used)}</span>
          <span className={APP_WHEN}>{c.lastAgo ?? 'not in the window'}</span>
        </summary>

        <div className={APP_BODY}>
          {c.opens.length === 0 ? (
            <p className={EMPTY}>
              Nobody opened this in the window. For an app behind the proxy gate that means nobody
              visited it. The registration is what the middleware itself signs in with.
            </p>
          ) : (
            <ul className={LIST}>
              {c.opens.map((o) => (
                <li key={o.id}>
                  {/* Not "first time" — see `opens[].consent`. */}
                  {o.consent && (
                    <Chip tone="info">
                      <span title="A consent record was created here rather than reused. Pocket ID drops the stored one whenever the client is rewritten, which every rebuild does">
                        re-consented
                      </span>
                    </Chip>
                  )}
                  <span className={MAIN}>{o.username}</span>
                  <span className={SIDE}>{o.device}</span>
                  <span className={SIDE}>{o.ago}</span>
                </li>
              ))}
            </ul>
          )}
          {c.used > c.opens.length && (
            <p className={FOOT}>
              The {num(c.opens.length)} most recent of {num(c.used)}. The rest are in Pocket ID.
            </p>
          )}
        </div>
      </details>
    </li>
  )
}
