import { Link, type LinkProps } from '@tanstack/react-router'
import { Fragment, type ReactNode } from 'react'

// The tab row every multi-tab page draws: category sub-tabs, the app detail
// tabs, the app-list registries. One component because the row carries rules
// that should not be re-decided per page — the active tab wears both the
// `active` class (the CSS keys on it) and `aria-current`, and navigation is
// always `replace` so stepping through tabs does not fill the history with
// every one visited on the way.

export type TabItem<Id extends string = string> = {
  id: Id
  label: ReactNode
  /** The status-dot slot, drawn before the label. See c.$category's TabNav. */
  extra?: ReactNode
  /** A rule before this tab, separating it from the ones preceding it. */
  dividerBefore?: boolean
}

export function TabBar<Id extends string>({
  tabs,
  active,
  linkTo,
}: {
  tabs: readonly TabItem<Id>[]
  active: string
  /** Where each tab goes. A callback so every caller keeps its own typed
      route, params and search rather than this component guessing them. */
  linkTo: (id: Id) => LinkProps
}) {
  return (
    <nav className="tabs">
      {tabs.map((t) => (
        <Fragment key={t.id}>
          {/* Not a border on the tab itself: the row's own underline runs
              through every item, and a left border would sit on top of it
              rather than across it. */}
          {t.dividerBefore === true && <span className="tabs-rule" aria-hidden="true" />}
          <Link
            {...linkTo(t.id)}
            className={t.id === active ? 'active' : ''}
            aria-current={t.id === active ? 'page' : undefined}
            replace
          >
            {t.extra}
            {t.label}
          </Link>
        </Fragment>
      ))}
    </nav>
  )
}
