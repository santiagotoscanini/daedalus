import { Link, type LinkProps } from '@tanstack/react-router'
import { Fragment, type ReactNode } from 'react'
import { cn } from '../lib/cn'
import { NavIcon, type NavIconName } from './nav-icon'

// The tab row every multi-tab page draws: category sub-tabs, the app detail
// tabs, the app-list registries. One component because the row carries rules
// that should not be re-decided per page — the active tab wears both its own
// styling and `aria-current`, and navigation is always `replace` so stepping
// through tabs does not fill the history with every one visited on the way.

export type TabItem<Id extends string = string> = {
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
    <nav
      className={cn(
        'mb-6 flex gap-1 border-b border-b-(color:--border-soft)',
        // Four tabs plus a dot do not fit on a phone; scroll them rather than
        // wrapping into a second row that pushes the content down everywhere.
        'max-[52rem]:overflow-x-auto max-[52rem]:[scrollbar-width:none] max-[52rem]:[&::-webkit-scrollbar]:hidden',
        // `extra` is drawn by the caller (c.$category), which hands us the same
        // status dot the tiles use — `StateDot`, a `role="img"` span. At tile
        // size its ring collides with the label, so the row shrinks whatever
        // dot it is given.
        '[&_[role=img]]:size-[0.46rem]',
      )}
    >
      {tabs.map((t) => (
        <Fragment key={t.id}>
          {/* Not a border on the tab itself: the row's own underline runs
              through every item, and a left border would sit on top of it
              rather than across it. Inset so it reads as a divider between
              labels rather than as a second, shorter border. */}
          {t.dividerBefore === true && (
            <span
              className="mx-[0.6rem] mt-[0.45rem] mb-2 w-px self-stretch bg-border"
              aria-hidden="true"
            />
          )}
          <Link
            {...linkTo(t.id)}
            className={cn(
              '-mb-px inline-flex cursor-pointer items-center gap-[0.4rem] border-b-2 border-b-transparent px-3 py-2 text-sm transition-colors duration-150',
              'max-[52rem]:whitespace-nowrap',
              t.id === active
                ? 'border-b-primary text-foreground'
                : 'text-(--text-muted) hover:text-foreground',
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
      {trailing !== undefined && <span className="ml-auto self-center pb-1">{trailing}</span>}
    </nav>
  )
}
