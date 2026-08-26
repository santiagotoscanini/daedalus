import {
  createRootRoute,
  HeadContent,
  Link,
  Outlet,
  Scripts,
  useMatches,
  useRouterState,
} from '@tanstack/react-router'
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'

import { ErrorPanel } from '../components/error'
import { NavIcon } from '../components/nav-icon'
import { CATEGORIES } from '../lib/dashboard/nav'
import appCss from '../styles.css?url'
import { APP_TABS } from './apps.$name'

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
  // Inside the shell (this route's children render there), so an uncaught
  // loader or render error keeps the rail and its way back to every other page.
  errorComponent: ErrorPanel,
  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: NAV_BOOT is a
            static string constant defined in this repo, not user input — it must
            run before hydration, which only an inline script can do. */}
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

  // Inside an app the rail changes subject: the sections OF that app, with a
  // way back, instead of the box's directory. Vercel's settings shape — a
  // detail page with eight sections outgrows a horizontal tab row. Matched
  // here (not in the route) because the rail is the shell's.
  const app = useAppRailContext()
  // biome-ignore lint/correctness/useExhaustiveDependencies: `path` is not read in the body — it IS the trigger; the effect exists to run on navigation.
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

      <aside
        id="nav"
        className={app !== null ? 'sidebar app-rail' : 'sidebar'}
        data-open={open ? 'true' : 'false'}
      >
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

        {app !== null ? (
          <AppRail app={app} />
        ) : (
          /* Apps is the management surface; everything below it is a
             read-only view of one subject area. The split is by subject
             rather than by service on purpose — "what is playing" and "what
             is downloading" are one question and six containers. */
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
        )}

        {/* Below everything, and pushed there rather than ordered there.
            The rail above is a directory of what this box RUNS, one entry
            per subject area; Claude is not one of those — it is the thing
            that maintains all of them, and this page is about the session
            you would be holding while reading any of the others. Sitting it
            eighth in that list would be a claim it belongs to the same
            taxonomy. The gap is the argument. */}
        <nav className="nav-secondary" aria-label="This workshop">
          <span className="nav-divider" aria-hidden="true" />
          <Link to="/claude" className="nav-item" data-label="Claude">
            <NavIcon name="claude" />
            <span className="nav-label">Claude</span>
          </Link>
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

type AppRailContext = {
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
function useAppRailContext(): AppRailContext | null {
  return useMatches({
    select: (matches) => {
      const m = matches.find((x) => x.routeId === '/apps/$name')
      if (m === undefined) return null
      const data = m.loaderData as
        | { app: { postgres: boolean; egressContainer: string | null } }
        | null
        | undefined
      return {
        name: (m.params as { name: string }).name,
        tab: (m.search as { tab?: string }).tab ?? 'overview',
        hasDatabase: data?.app.postgres === true,
        hasVpn: (data?.app.egressContainer ?? null) !== null,
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
 * has already answered (this rule moved here from the old tab bar).
 */
function AppRail({ app }: { app: AppRailContext }) {
  const tabs = APP_TABS.filter(
    (t) => (t !== 'database' || app.hasDatabase) && (t !== 'vpn' || app.hasVpn),
  )
  return (
    <nav className="nav-primary" aria-label="App sections">
      {/* activeProps muted: /apps prefix-matches every app detail URL, so the
          default would keep this lit on every page of the section. */}
      <Link to="/apps" className="nav-item" data-label="All apps" activeProps={{}}>
        <NavIcon name="chevron" size={16} />
        <span className="nav-label">All apps</span>
      </Link>

      <span className="nav-divider" aria-hidden="true" />
      <span className="rail-app">{app.name}</span>

      {tabs.map((t) => (
        <Link
          key={t}
          to="/apps/$name"
          params={{ name: app.name }}
          // Carry the rest of the search forward, so switching to another
          // section and back does not silently reset the access window.
          search={(prev) => ({ ...prev, tab: t })}
          className={t === app.tab ? 'nav-item active' : 'nav-item'}
          // Manual activeness only — Link's default activeProps matches by
          // location and would light every row (see components/tabs.tsx).
          activeProps={{}}
          data-label={t.charAt(0).toUpperCase() + t.slice(1)}
        >
          <NavIcon name={t} />
          <span className="nav-label">{t}</span>
        </Link>
      ))}
    </nav>
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
