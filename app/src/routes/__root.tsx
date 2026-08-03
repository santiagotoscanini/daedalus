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
      // The app is behind a Pocket ID gate on the LAN; there is nothing here
      // for a crawler even if one could reach it.
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
        <header className="topbar">
          <Link to="/" className="brand">
            <img src="/icon.svg" alt="" width={22} height={22} />
            <span>daedalus</span>
          </Link>
          <nav>
            <Link to="/" activeOptions={{ exact: true }}>
              Overview
            </Link>
            <Link to="/models">Models</Link>
            <Link to="/about">About</Link>
          </nav>
        </header>
        <main>{children ?? <Outlet />}</main>
        <Scripts />
      </body>
    </html>
  )
}
