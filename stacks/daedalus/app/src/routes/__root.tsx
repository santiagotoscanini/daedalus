import {
  HeadContent,
  Link,
  Outlet,
  Scripts,
  createRootRoute,
  useRouterState,
} from '@tanstack/react-router'
import type { ReactNode } from 'react'

import { CATEGORIES } from '../lib/dashboard/nav'
import appCss from '../styles.css?url'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'daedalus' },
      { name: 'description', content: 'S2 control plane' },
      // Behind a Pocket ID gate on the LAN; there is nothing here for a
      // crawler even if one could reach it.
      { name: 'robots', content: 'noindex, nofollow' },
    ],
    links: [
      { rel: 'stylesheet', href: appCss },
      { rel: 'icon', href: '/icon.svg', type: 'image/svg+xml' },
    ],
  }),
  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <RouteProgress />
        <div className="shell">
          <aside className="sidebar">
            <Link to="/apps" className="brand">
              <img src="/icon.svg" alt="" width={30} height={30} />
              <span>
                daedalus
                <small>workshop</small>
              </span>
            </Link>

            {/* Apps is the management surface; everything below it is a
                read-only view of one subject area. The split is by subject
                rather than by service on purpose — "what is playing" and "what
                is downloading" are one question and six containers. */}
            <nav className="nav-primary">
              <Link to="/apps" className="nav-item">
                <span className="nav-icon" aria-hidden="true">
                  ▦
                </span>
                Apps
              </Link>

              <span className="nav-divider" aria-hidden="true" />

              {CATEGORIES.map((c) => (
                <Link
                  key={c.id}
                  to="/c/$category"
                  params={{ category: c.id }}
                  // The sub-tab is left off so the loader picks the category's
                  // first one; naming it here would mean the rail and the
                  // route disagreed the moment a tab was renamed.
                  search={{}}
                  className="nav-item"
                >
                  <span className="nav-icon" aria-hidden="true">
                    {c.icon}
                  </span>
                  {c.label}
                </Link>
              ))}
            </nav>

            {/* Secondary, not tabs — the gateway model list and the runtime
                readout are diagnostics, not part of the management surface. */}
            <nav className="nav-secondary">
              <Link to="/models">Models</Link>
              <Link to="/about">About</Link>
            </nav>
          </aside>

          <main className="content">{children ?? <Outlet />}</main>
        </div>
        <Scripts />
      </body>
    </html>
  )
}

/**
 * A hairline at the top of the window while a route loader is in flight.
 *
 * The whole reason navigation felt broken: the router correctly keeps the
 * previous page on screen until the next loader resolves, so a click on
 * Dashboard changed nothing visible for the few hundred ms of its fan-out.
 * The bar is the missing "yes, I heard you".
 *
 * CSS-animated rather than driven by real progress — a loader has no
 * measurable percentage, and a fake number that stalls at 80% is worse than an
 * honest indeterminate one.
 */
function RouteProgress() {
  const loading = useRouterState({ select: (s) => s.status === 'pending' })
  return loading ? <div className="route-progress" role="progressbar" aria-label="Loading" /> : null
}
