import {
  HeadContent,
  Link,
  Outlet,
  Scripts,
  createRootRoute,
  useRouterState,
} from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

import { NavIcon } from '../components/nav-icon'
import { CATEGORIES } from '../lib/dashboard/nav'
import appCss from '../styles.css?url'

/**
 * The collapsed/expanded rail, restored before the first paint.
 *
 * It has to be an inline script in the head rather than React state: the shell
 * is server-rendered, the server has no way to know this browser's preference,
 * and reading it in an effect means a full-width rail is painted first and then
 * snaps to 64px on hydration. The attribute is what the stylesheet keys off, so
 * setting it here means the very first paint is already right.
 */
const NAV_BOOT = `try{var v=localStorage.getItem('daedalus:nav');if(v==='collapsed')document.documentElement.dataset.nav=v}catch(e){}`

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      // `viewport-fit=cover` so the drawer and the sticky top bar can reach
      // under a phone's rounded corners; the padding below puts them back.
      { name: 'viewport', content: 'width=device-width, initial-scale=1, viewport-fit=cover' },
      { title: 'daedalus' },
      { name: 'description', content: 'S2 control plane' },
      // Behind a Pocket ID gate on the LAN; there is nothing here for a
      // crawler even if one could reach it.
      { name: 'robots', content: 'noindex, nofollow' },
    ],
    // Icons are plain files under public/ plus the link tags for them —
    // TanStack Start has no file-based icon convention, so nothing is inferred
    // from a filename and every variant is declared here.
    //
    //   icon.svg        the real source. Scales to any favicon size.
    //   icon.png        512², for the browsers that still ignore SVG favicons.
    //   apple-icon.png  180², what iOS puts on the home screen.
    //
    // The Apple one is a SEPARATE render, not a resize: iOS masks the icon
    // into its own squircle, so the art has to be full-bleed. Feeding it
    // icon.svg — which draws its own `rx="7"` rounded rect — would round the
    // corners twice and leave four dark notches. Regenerate after an icon
    // change by dropping that `rx` and rasterising:
    //
    //   nix run nixpkgs#resvg -- --width 180 --height 180 in.svg apple-icon.png
    links: [
      { rel: 'stylesheet', href: appCss },
      { rel: 'icon', href: '/icon.svg', type: 'image/svg+xml' },
      { rel: 'icon', href: '/icon.png', type: 'image/png' },
      { rel: 'apple-touch-icon', href: '/apple-icon.png' },
    ],
  }),
  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
        <script dangerouslySetInnerHTML={{ __html: NAV_BOOT }} />
      </head>
      <body>
        <RouteProgress />
        <Shell>{children}</Shell>
        <Scripts />
      </body>
    </html>
  )
}

/**
 * The rail, and the two different things it is.
 *
 * On a desktop it is a column beside the page, collapsible to icons. On a
 * phone it is a drawer over the page, opened from a button in a top bar. Those
 * are one element and one set of links — the alternative was a second copy of
 * the navigation that drifts from the first — and the two states are kept
 * apart entirely in CSS, at the same 52rem breakpoint the rest of the layout
 * uses.
 */
function Shell({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false)
  const [open, setOpen] = useState(false)
  const openButton = useRef<HTMLButtonElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)

  // The DOM attribute is authoritative — the boot script set it before React
  // existed. This only teaches the component what the page already looks like,
  // so the toggle's label and aria-expanded agree with it.
  useEffect(() => {
    setCollapsed(document.documentElement.dataset.nav === 'collapsed')
  }, [])

  const toggle = useCallback(() => {
    setCollapsed((was) => {
      const next = !was
      document.documentElement.dataset.nav = next ? 'collapsed' : 'open'
      try {
        localStorage.setItem('daedalus:nav', next ? 'collapsed' : 'open')
      } catch {
        // Private mode, or storage full. The rail still collapses; it just
        // will not remember, which is not worth failing a click over.
      }
      return next
    })
  }, [])

  // Closing the drawer on navigation is the whole reason it can be a drawer:
  // a menu you have to dismiss yourself after tapping a link is one tap too
  // many, every time.
  const path = useRouterState({ select: (s) => s.location.pathname })
  useEffect(() => {
    setOpen(false)
  }, [path])

  // A drawer left open across the breakpoint would be a phone-shaped panel
  // that the desktop stylesheet no longer draws, with the body scroll lock
  // below still in force — so the page would simply stop scrolling. Rotating a
  // tablet is enough to do it.
  useEffect(() => {
    const wide = window.matchMedia('(width > 52rem)')
    const onChange = (e: MediaQueryListEvent) => {
      if (e.matches) setOpen(false)
    }
    wide.addEventListener('change', onChange)
    return () => {
      wide.removeEventListener('change', onChange)
    }
  }, [])

  // Escape closes, and focus goes back to the button that opened it — losing
  // your place in the page is the usual cost of a drawer that forgets.
  useEffect(() => {
    if (!open) return
    closeButton.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        openButton.current?.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    // The page behind a drawer must not scroll: on a phone a swipe meant for
    // the menu otherwise moves the list underneath it.
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  }, [open])

  return (
    <div className="shell">
      {/* Phone only. The rail is off-canvas there, so the brand and the way
          back into it need somewhere to live that is always on screen. */}
      <header className="topbar">
        <button
          ref={openButton}
          type="button"
          className="iconbtn"
          aria-label="Open navigation"
          aria-expanded={open}
          aria-controls="nav"
          onClick={() => {
            setOpen(true)
          }}
        >
          <NavIcon name="menu" size={20} />
        </button>
        <Link to="/apps" className="brand brand-top">
          <img src="/icon.svg" alt="" width={26} height={26} />
          <span>daedalus</span>
        </Link>
      </header>

      {/* Not a button: it duplicates the close control for a pointer, and a
          screen reader that already has one does not need a second. */}
      <div
        className="scrim"
        data-open={open ? 'true' : 'false'}
        onClick={() => {
          setOpen(false)
        }}
        aria-hidden="true"
      />

      <aside id="nav" className="sidebar" data-open={open ? 'true' : 'false'}>
        <div className="rail-head">
          <Link to="/apps" className="brand">
            <img src="/icon.svg" alt="" width={30} height={30} />
            <span>
              daedalus
              <small>workshop</small>
            </span>
          </Link>
          <button
            ref={closeButton}
            type="button"
            className="iconbtn nav-close"
            aria-label="Close navigation"
            onClick={() => {
              setOpen(false)
              openButton.current?.focus()
            }}
          >
            <NavIcon name="close" size={18} />
          </button>
        </div>

        {/* Apps is the management surface; everything below it is a
            read-only view of one subject area. The split is by subject
            rather than by service on purpose — "what is playing" and "what
            is downloading" are one question and six containers. */}
        <nav className="nav-primary" aria-label="Sections">
          <Link to="/apps" className="nav-item" data-label="Apps">
            <NavIcon name="apps" />
            <span className="nav-label">Apps</span>
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
              // What the tooltip says when the rail is collapsed. An
              // attribute rather than `title`: the native one waits a second
              // and then appears under the cursor rather than beside the row.
              data-label={c.label}
            >
              {/* The icon is keyed by the category id. It was a glyph on the
                  spec until it turned out to be the id spelled a second
                  way — see components/nav-icon.tsx. */}
              <NavIcon name={c.id} />
              <span className="nav-label">{c.label}</span>
            </Link>
          ))}
        </nav>

        {/* Desktop only: the drawer is dismissed by the scrim, not by this. */}
        <button type="button" className="nav-collapse" onClick={toggle} aria-pressed={collapsed}>
          <NavIcon name="chevron" size={17} />
          <span className="nav-label">Collapse</span>
        </button>
      </aside>

      <main className="content">{children ?? <Outlet />}</main>
    </div>
  )
}

/**
 * A hairline at the top of the window while a route loader is in flight.
 *
 * Still here even though the pages now stream: the router keeps the previous
 * page on screen until the loader resolves, and a few routes still await
 * something before they can render at all — the app detail page has to know
 * the record exists before it can draw a tab bar, or decide it is a 404. Those
 * are tens of milliseconds, and the bar is what makes them feel answered
 * rather than ignored. Everything past that point is a skeleton, not a wait.
 *
 * CSS-animated rather than driven by real progress — a loader has no
 * measurable percentage, and a fake number that stalls at 80% is worse than an
 * honest indeterminate one.
 */
function RouteProgress() {
  const loading = useRouterState({ select: (s) => s.status === 'pending' })
  return loading ? <div className="route-progress" role="progressbar" aria-label="Loading" /> : null
}
