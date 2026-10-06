import { Link, type LinkProps } from '@tanstack/react-router'
import { Fragment, type ReactNode } from 'react'
import { cn } from '../lib/cn'
import { NavIcon, type NavIconName } from './nav-icon'
import { SEGMENT_ITEM, SEGMENT_ITEM_ON, SEGMENT_TRACK } from './tokens'

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
  return (
    <div className="mb-7 flex items-center gap-3">
      <nav
        className={cn(
          // A segmented control on glass: the row is one pill, the selected tab
          // a lit chip inside it. Reads as "one of these" at a glance, which an
          // underline across a full-width rule did not.
          SEGMENT_TRACK,
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
              className={cn(
                SEGMENT_ITEM,
                t.id === active && SEGMENT_ITEM_ON,
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
      {trailing !== undefined && <span className="ml-auto flex-none">{trailing}</span>}
    </div>
  )
}
