import { Link, type LinkProps } from '@tanstack/react-router'
import { Fragment, type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { cn } from '../lib/cn'
import { NavIcon, type NavIconName } from './nav-icon'

// The tab row every multi-tab page draws: category sub-tabs, the app detail
// tabs, the app-list registries. One component because the row carries rules
// that should not be re-decided per page — the active tab wears both its own
// styling and `aria-current`, and navigation is always `replace` so stepping
// through tabs does not fill the history with every one visited on the way.

type TabItem<Id extends string = string> = {
  id: Id
  label: ReactNode
  /** The status-dot slot, drawn before the label. See c.$category's TabNav. */
  extra?: ReactNode
  /** A rule before this tab, separating it from the ones preceding it. */
  dividerBefore?: boolean
  /** Drawn dimmer: the tab is offered but its subject is switched off. */
  muted?: boolean
  /** A mark before the label. */
  icon?: NavIconName
}

export function TabBar<Id extends string>({
  tabs,
  active,
  linkTo,
  trailing,
}: {
  tabs: readonly TabItem<Id>[]
  active: string
  /** Where each tab goes. A callback so every caller keeps its own typed
      route, params and search rather than this component guessing them. */
  linkTo: (id: Id) => LinkProps
  /** A control at the row's far end — the cog a service's page wears. */
  trailing?: ReactNode
}) {
  // More tabs than fit: the row scrolls (a phone), so it fades at the edge that
  // has more and brings the open tab into view — a tab cut mid-word with no
  // hint that it moves reads as broken.
  const nav = useRef<HTMLElement>(null)
  const [more, setMore] = useState(false)
  const measure = useCallback(() => {
    const el = nav.current
    if (el !== null) setMore(el.scrollLeft + el.clientWidth < el.scrollWidth - 4)
  }, [])
  useEffect(() => {
    const el = nav.current
    if (el === null) return
    el.querySelector(`[data-tab="${active}"]`)?.scrollIntoView({
      inline: 'center',
      block: 'nearest',
    })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [measure, active])
  return (
    <div className="mb-5 flex items-end gap-3 border-hairline border-b">
      <nav
        ref={nav}
        onScroll={measure}
        className={cn(
          // Navigation is an underline on a full-width hairline; the boxed
          // segmented control is reserved for FILTERS. Drawn alike, a page's
          // sections and a list's filters read as three equal toolbars.
          '-mb-px flex max-w-full gap-6',
          more && '[mask-image:linear-gradient(to_right,black_calc(100%-2rem),transparent)]',
          // Four tabs plus a dot do not fit on a phone; scroll them rather than
          // wrapping into a second row that pushes the content down everywhere.
          'overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
          // `extra` is drawn by the caller (c.$category), which hands us the same
          // status dot the tiles use — `StateDot`, a `role="img"` span. At tile
          // size its ring collides with the label, so the row shrinks whatever
          // dot it is given.
          '[&_[role=img]]:size-[0.46rem]',
        )}
      >
        {tabs.map((t) => (
          <Fragment key={t.id}>
            {t.dividerBefore === true && (
              <span
                className="mx-1 my-1.5 w-px flex-none self-stretch bg-hairline"
                aria-hidden="true"
              />
            )}
            <Link
              {...linkTo(t.id)}
              data-tab={t.id}
              className={cn(
                'inline-flex flex-none cursor-pointer items-center gap-1.5 whitespace-nowrap border-transparent border-b-2 pt-1 pb-2.5 text-[0.8125rem] max-[40rem]:pt-2.5 max-[40rem]:pb-3 text-muted-foreground no-underline transition-colors duration-100 hover:text-foreground hover:no-underline [&>svg]:opacity-70',
                t.id === active &&
                  'border-foreground text-foreground [font-weight:550] [&>svg]:opacity-100',
                t.muted === true && 'opacity-55 hover:opacity-90',
              )}
              aria-current={t.id === active ? 'page' : undefined}
              // The `active` prop above is the ONLY source of activeness.
              // Without this, Link's default activeProps injects its own
              // `active` class by location match — which subset-matches on
              // search params, so a default tab linked with empty search stays
              // lit while its sibling is selected.
              activeProps={{}}
              replace
            >
              {t.extra}
              {t.icon !== undefined && <NavIcon name={t.icon} size={15} />}
              {t.label}
            </Link>
          </Fragment>
        ))}
      </nav>
      {trailing !== undefined && (
        <span className="ml-auto flex-none self-center pb-1.5">{trailing}</span>
      )}
    </div>
  )
}
