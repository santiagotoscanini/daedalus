import { HeadContent, Link, Outlet, Scripts, createRootRoute } from '@tanstack/react-router'
import type { ReactNode } from 'react'

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
        <div className="shell">
          <aside className="sidebar">
            <Link to="/apps" className="brand">
              <img src="/icon.svg" alt="" width={30} height={30} />
              <span>
                daedalus
                <small>workshop</small>
              </span>
            </Link>

            <nav className="nav-primary">
              <Link to="/apps" className="nav-item">
                <span className="nav-icon" aria-hidden="true">
                  ▦
                </span>
                Apps
              </Link>
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
