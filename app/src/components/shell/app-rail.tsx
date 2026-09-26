import { Link, useMatches } from '@tanstack/react-router'
import { cn } from '../../lib/cn'
import { APP_TABS } from '../../routes/apps.$name'
import { NavIcon } from '../nav-icon'
import { NAV_DIVIDER, NAV_ITEM, NAV_ITEM_ACTIVE, NAV_LABEL, NAV_LIST } from './styles'

export type AppRailContext = {
  name: string
  tab: string
  /** Feature tabs, hidden while unknown (loader still in flight). */
  hasDatabase: boolean
  hasVpn: boolean
}

/**
 * Whether the app detail route is matched, and what its rail needs to know.
 *
 * Read through `useMatches` rather than passed up from the route: the rail
 * renders in the shell, above the route in the tree. `loaderData` is
 * undefined while the loader is in flight — the two conditional tabs stay
 * hidden for those milliseconds rather than flashing in and out.
 */
export function useAppRailContext(): AppRailContext | null {
  return useMatches({
    select: (matches) => {
      // A build's page is not nested under the app route (it has no Outlet),
      // but it is still inside the app, under Deployments.
      const m = matches.find(
        (x) => x.routeId === '/apps/$name' || x.routeId === '/apps_/$name/builds/$id',
      )
      if (m === undefined) return null
      const data = m.loaderData as
        | { app: { postgres: boolean; egressContainer: string | null } | null }
        | null
        | undefined
      return {
        name: (m.params as { name: string }).name,
        tab:
          m.routeId === '/apps/$name'
            ? ((m.search as { tab?: string }).tab ?? 'overview')
            : 'deployments',
        hasDatabase: data?.app?.postgres === true,
        hasVpn: (data?.app?.egressContainer ?? null) !== null,
      }
    },
    structuralSharing: true,
  })
}

/**
 * The app-scoped rail: a way back, whose app this is, and its sections.
 *
 * The two feature tabs are hidden rather than disabled when the feature is
 * off — a greyed-out "vpn" on an app with no egress is a question the page
 * has already answered.
 *
 * `tasks` is NOT one of them, and the difference is the whole distinction this
 * rule turns on: database and vpn reflect infrastructure an app either has or
 * does not, so the tab is a report. Tasks are something you ADD — hiding the
 * tab until one exists is a door that can only be opened from inside, and the
 * first task could never be written. The empty state invites it instead.
 */
export function AppRail({ app }: { app: AppRailContext }) {
  const tabs = APP_TABS.filter(
    (t) => (t !== 'database' || app.hasDatabase) && (t !== 'vpn' || app.hasVpn),
  )
  return (
    <nav className={NAV_LIST} aria-label="App sections">
      {/* activeProps muted: /apps prefix-matches every app detail URL, so the
          default would keep this lit on every page of the section. */}
      <Link
        to="/apps"
        className={cn(NAV_ITEM, 'text-(--dim) hover:text-foreground')}
        data-label="All apps"
        activeProps={{}}
      >
        <NavIcon name="chevron" size={16} />
        <span className={NAV_LABEL}>All apps</span>
      </Link>

      <span className={NAV_DIVIDER} aria-hidden="true" />
      {/* Which app this is. Hidden when the rail collapses — at 64px there is
          no room for a name, and the icons below still work unchanged. */}
      <span className="overflow-hidden text-ellipsis whitespace-nowrap px-[0.65rem] pt-0.5 pb-1.5 font-[550] text-[0.78rem] text-foreground nav-collapsed:hidden">
        {app.name}
      </span>

      {tabs.map((t) => (
        <Link
          key={t}
          to="/apps/$name"
          params={{ name: app.name }}
          // Carry the rest of the search forward, so switching to another
          // section and back does not silently reset the access window.
          search={(prev) => ({ ...prev, tab: t })}
          // The label is the lowercase tab id, capitalized here on the row
          // itself. Not as a descendant rule on the rail: that also reached
          // the wordmark and beat its `uppercase`.
          className={cn(NAV_ITEM, 'capitalize', t === app.tab && NAV_ITEM_ACTIVE)}
          // Manual activeness only — Link's default activeProps matches by
          // location and would light every row (see components/tabs.tsx).
          activeProps={{}}
          data-label={t.charAt(0).toUpperCase() + t.slice(1)}
        >
          <NavIcon name={t} />
          <span className={NAV_LABEL}>{t}</span>
        </Link>
      ))}
    </nav>
  )
}
