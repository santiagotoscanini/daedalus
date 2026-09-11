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
import appCss from '../app.css?url'
import { AccountMenu } from '../components/account-menu'
import { ErrorPanel } from '../components/error'
import { NavIcon } from '../components/nav-icon'
import type { Account } from '../core/settings/types'
import { cn } from '../lib/cn'
import { CATEGORIES } from '../lib/dashboard/nav'
import { useResolvedScheme } from '../lib/scheme'
import { presetById, type ThemeChoice, themeCss } from '../lib/theme'
import { fetchAccount } from '../server/profile'
import { fetchTheme } from '../server/settings'
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

/**
 * Resolving `system` to a real scheme, before the first paint.
 *
 * The other two schemes need no script at all: the operator's choice is a
 * database row, so the server already knows it and renders it onto
 * `<html>`. `system` is the one the server cannot answer — the OS
 * preference lives in the browser — and reading it in an effect instead
 * would paint the server's guess and then swap, which is the flash this
 * whole arrangement exists to avoid.
 *
 * This script covers the moment BEFORE hydration only. From hydration on,
 * `useResolvedScheme` (lib/scheme.ts) answers the same question inside
 * React, so the attribute React renders agrees with the one this wrote —
 * otherwise React's next pass over the document put the server's guess
 * back, and a light system went dark on the first click.
 *
 * Deliberately not a `prefers-color-scheme` media query in the CSS: an
 * operator who picks light on a dark-mode laptop must get light, and two
 * mechanisms voting on the same attribute is how a theme toggle stops
 * working.
 */
const THEME_BOOT = `try{if(document.documentElement.dataset.themeSource==='system')document.documentElement.dataset.theme=matchMedia('(prefers-color-scheme: light)').matches?'light':'dark'}catch(e){}`

/**
 * One rail row, in three places: the categories, the workshop pair at the
 * foot, and the app-scoped rail.
 *
 * The `after:` half is the collapsed rail's tooltip. At 64px the icon is the
 * only thing naming the destination, so the label has to come back somewhere
 * — beside the row rather than under the cursor, and immediately rather than
 * after the second the native `title` waits. `attr(data-label)` is why every
 * caller sets that attribute.
 *
 * Selected is quiet, not orange: it is the one row the eye rests on at every
 * glance, and a block of accent there outshouted every reading on the page.
 * The accent's job on this rail is the wordmark.
 */
const NAV_ITEM = [
  'relative flex items-center gap-2.5 rounded-[7px] px-2.5 py-[0.45rem]',
  'text-(--text-muted) text-sm whitespace-nowrap no-underline',
  'transition-[background-color,color] duration-150',
  'hover:bg-(--panel-2) hover:text-foreground hover:no-underline',
  'focus-visible:outline-2 focus-visible:outline-(--brand-dim) focus-visible:outline-offset-2',
  // A thumb, not a cursor.
  'max-rail:px-2.5 max-rail:py-[0.68rem] max-rail:text-[0.97rem]',
  'nav-collapsed:justify-center nav-collapsed:px-0',
  'nav-collapsed:after:pointer-events-none nav-collapsed:after:absolute',
  'nav-collapsed:after:top-1/2 nav-collapsed:after:left-[calc(100%+0.55rem)]',
  'nav-collapsed:after:z-40 nav-collapsed:after:-translate-y-1/2',
  'nav-collapsed:after:rounded-[7px] nav-collapsed:after:border nav-collapsed:after:bg-(--raise)',
  'nav-collapsed:after:px-[0.55rem] nav-collapsed:after:py-1',
  'nav-collapsed:after:text-[0.78rem] nav-collapsed:after:leading-tight',
  'nav-collapsed:after:font-medium nav-collapsed:after:tracking-normal',
  'nav-collapsed:after:text-foreground nav-collapsed:after:whitespace-nowrap',
  'nav-collapsed:after:content-[attr(data-label)]',
  'nav-collapsed:after:opacity-0 nav-collapsed:after:transition-opacity',
  'nav-collapsed:hover:after:opacity-100 nav-collapsed:focus-visible:after:opacity-100',
  // The icon carries less weight than its label, so at rest it is drawn
  // back; hovering or selecting brings the whole row forward together.
  '[&>svg]:shrink-0 [&>svg]:opacity-75 [&>svg]:transition-opacity hover:[&>svg]:opacity-100',
].join(' ')

const NAV_ITEM_ACTIVE = 'bg-(--panel-2) font-[550] text-foreground [&>svg]:opacity-100'

/** The label, which the collapsed rail hides in favour of the tooltip. */
const NAV_LABEL = 'min-w-0 overflow-hidden text-ellipsis nav-collapsed:hidden'

const NAV_DIVIDER = 'my-2 mx-[0.7rem] h-px bg-(--border-soft) nav-collapsed:mx-1.5'

const NAV_LIST = 'flex flex-col gap-[0.12rem]'

/** The wordmark. Letter-spaced small caps, which the collapsed rail centres. */
const BRAND = [
  'flex min-w-0 flex-1 items-center gap-[0.7rem] px-[0.55rem] py-1',
  'font-semibold text-[0.76rem] text-foreground uppercase tracking-[0.14em]',
  'no-underline hover:no-underline',
  'focus-visible:outline-2 focus-visible:outline-(--brand-dim) focus-visible:outline-offset-2',
  'nav-collapsed:justify-center nav-collapsed:px-0',
].join(' ')

/** A square hit target holding one icon and nothing else. */
const ICON_BUTTON = [
  'inline-flex size-[38px] flex-none cursor-pointer items-center justify-center',
  'rounded-[9px] border-0 bg-transparent p-0 text-(--text-muted)',
  'hover:bg-(--panel-2) hover:text-foreground',
  'focus-visible:outline-2 focus-visible:outline-(--brand-dim) focus-visible:outline-offset-2',
].join(' ')

export const Route = createRootRoute({
  // The theme is the one thing the shell cannot render without, so it is
  // loaded here rather than by the page: every route renders inside this
  // document, and a per-route load would repaint the palette on navigation.
  //
  // The signed-in account is the opposite case: it asks Pocket ID, so it is
  // handed over as a promise and streams in behind the page — the rail's
  // account button draws a placeholder until then, and no page waits on it.
  loader: async () => ({ theme: await fetchTheme(), account: fetchAccount() }),
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
  const theme = Route.useLoaderData({ select: (d) => d.theme })
  const account = Route.useLoaderData({ select: (d) => d.account })
  const preset = presetById(theme.presetId)
  const scheme = useResolvedScheme(theme.scheme)
  const css = themeCss(preset)

  return (
    // Two attributes, not one. `data-theme` is the scheme in force (resolved
    // the same way the boot script resolves it, see lib/scheme.ts) and the
    // only thing the stylesheet reads; `data-theme-source` is the stored
    // preference, which the boot script needs to tell "the operator chose
    // dark" from "the operator chose system and the server guessed dark".
    <html lang="en" data-theme={scheme} data-theme-source={theme.scheme}>
      <head>
        <HeadContent />
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: a static
            constant defined in this repo, not user input — it must run before
            hydration, which only an inline script can do. */}
        <script dangerouslySetInnerHTML={{ __html: `${THEME_BOOT}${NAV_BOOT}` }} />
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: themeCss
            filters both token names and values against an allowlist, so
            nothing that could close this element can reach it. Inline rather
            than a stylesheet request because a second round trip for the
            palette is a visible repaint. */}
        {css !== '' && <style dangerouslySetInnerHTML={{ __html: css }} />}
      </head>
      <body>
        <RouteProgress />
        <Shell theme={theme} account={account}>
          {children}
        </Shell>
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
function Shell({
  children,
  theme,
  account,
}: {
  children: ReactNode
  theme: ThemeChoice
  account: Promise<Account | null>
}) {
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
    // Grid on a desktop, block on a phone. Block, not a one-column grid: as
    // a grid with `min-height: 100vh` a short page left spare height that
    // got divided between the rows, floating the top bar's logo down the
    // middle of it — and a sticky GRID item is confined to its own grid
    // area, so the bar would have had no room to travel.
    <div className="grid min-h-screen grid-cols-[var(--sidebar-w)_1fr] max-rail:block">
      {/* Phone only. The rail is off-canvas there, so the brand and the way
          back into it need somewhere to live that is always on screen. */}
      <header
        className={cn(
          'hidden max-rail:flex max-rail:items-center max-rail:gap-1.5',
          'sticky top-0 z-40 border-b border-b-(--border-soft) px-3 py-[0.45rem]',
          'pl-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.75rem,env(safe-area-inset-right))]',
          // Translucent rather than solid: the page scrolling under it is the
          // cue that this bar is fixed and the content is not.
          'bg-background/88 backdrop-blur-[10px]',
        )}
      >
        <button
          ref={openButton}
          type="button"
          className={ICON_BUTTON}
          aria-label="Open navigation"
          aria-expanded={open}
          aria-controls="nav"
          onClick={() => {
            setOpen(true)
          }}
        >
          <NavIcon name="menu" size={20} />
        </button>
        <Link to="/apps" className={cn(BRAND, 'flex-none px-1.5')}>
          <img src="/icon.svg" alt="" width={26} height={26} className="flex-none" />
          <span>daedalus</span>
        </Link>
      </header>

      {/* Not a button: it duplicates the close control for a pointer, and a
          screen reader that already has one does not need a second. */}
      <div
        className={cn(
          'hidden max-rail:block max-rail:fixed max-rail:inset-0 max-rail:z-50',
          'bg-overlay/55 opacity-0 invisible transition-[opacity,visibility]',
          'duration-200 delay-[0s,200ms]',
          'data-[open=true]:visible data-[open=true]:opacity-100 data-[open=true]:delay-0',
        )}
        data-open={open ? 'true' : 'false'}
        onClick={() => {
          setOpen(false)
        }}
        aria-hidden="true"
      />

      <aside
        id="nav"
        className={cn(
          'sticky top-0 flex h-screen flex-col gap-[1.4rem]',
          'border-r border-r-(--border-soft) bg-background px-[0.7rem] pt-[1.1rem] pb-[0.9rem]',
          'nav-collapsed:px-[0.55rem]',
          // Below the breakpoint it stops being a column and becomes a
          // drawer. `visibility`, not transform alone: a rail merely moved
          // off the left edge is still in the tab order and still read out,
          // so the page behind it would have eight invisible links in front
          // of its own content. The delay keeps it visible for the length of
          // the closing slide.
          'max-rail:fixed max-rail:inset-y-0 max-rail:left-0 max-rail:right-auto max-rail:z-[60]',
          'max-rail:h-[100dvh] max-rail:w-[min(17.5rem,82vw)] max-rail:gap-[1.1rem]',
          'max-rail:overflow-y-auto max-rail:border-r-border',
          'max-rail:pt-3 max-rail:pb-[1.4rem] max-rail:pl-[max(0.7rem,env(safe-area-inset-left))]',
          'max-rail:invisible max-rail:-translate-x-full',
          'max-rail:transition-[transform,visibility] max-rail:duration-[220ms]',
          'max-rail:ease-[cubic-bezier(0.4,0,0.2,1)] max-rail:delay-[0s,220ms]',
          'max-rail:data-[open=true]:visible max-rail:data-[open=true]:translate-x-0',
          'max-rail:data-[open=true]:delay-0',
          // Inside an app the rail's entries are that app's sections, which
          // are lowercase tab ids.
          app !== null && '[&_a]:capitalize',
        )}
        data-open={open ? 'true' : 'false'}
      >
        {/* Collapsed, the row has no room beside the logo, so it becomes a
            column: logo above, the chevron beneath it. */}
        <div className="flex items-center gap-1.5 nav-collapsed:flex-col nav-collapsed:gap-2">
          <Link to="/apps" className={BRAND}>
            <img src="/icon.svg" alt="" width={30} height={30} className="flex-none" />
            <span className="nav-collapsed:hidden">
              daedalus
              <small className="block font-medium text-(--dim) text-[0.62rem] tracking-[0.2em]">
                workshop
              </small>
            </span>
          </Link>
          {/* Desktop only: the drawer is dismissed by the scrim, not by this.
              An icon and nothing else — `<` to close, `>` to open — beside
              the wordmark rather than a labelled row of its own at the foot
              of the rail, which cost a whole entry to say one word. */}
          <button
            type="button"
            className={cn(
              ICON_BUTTON,
              'size-8 text-(--dim) max-rail:hidden nav-collapsed:[&>svg]:rotate-180',
            )}
            onClick={toggle}
            aria-pressed={collapsed}
            aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
          >
            <NavIcon name="chevron" size={17} />
          </button>
          <button
            ref={closeButton}
            type="button"
            className={cn(ICON_BUTTON, 'hidden max-rail:inline-flex')}
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
          <nav className={NAV_LIST} aria-label="Sections">
            <Link
              to="/apps"
              className={NAV_ITEM}
              activeProps={{ className: NAV_ITEM_ACTIVE }}
              data-label="Apps"
            >
              <NavIcon name="apps" />
              <span className={NAV_LABEL}>Apps</span>
            </Link>

            <span className={NAV_DIVIDER} aria-hidden="true" />

            {CATEGORIES.map((c) => (
              <Link
                key={c.id}
                to="/c/$category"
                params={{ category: c.id }}
                // The sub-tab is left off so the loader picks the category's
                // first one; naming it here would mean the rail and the
                // route disagreed the moment a tab was renamed.
                search={{}}
                className={NAV_ITEM}
                activeProps={{ className: NAV_ITEM_ACTIVE }}
                // What the tooltip says when the rail is collapsed. An
                // attribute rather than `title`: the native one waits a second
                // and then appears under the cursor rather than beside the row.
                data-label={c.label}
              >
                {/* The icon is keyed by the category id. It was a glyph on the
                    spec until it turned out to be the id spelled a second
                    way — see components/nav-icon.tsx. */}
                <NavIcon name={c.id} />
                <span className={NAV_LABEL}>{c.label}</span>
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
        <nav className={cn(NAV_LIST, 'mt-auto')} aria-label="This workshop">
          <span className={NAV_DIVIDER} aria-hidden="true" />
          <Link
            to="/claude"
            className={NAV_ITEM}
            activeProps={{ className: NAV_ITEM_ACTIVE }}
            data-label="Claude"
          >
            <NavIcon name="claude" />
            <span className={NAV_LABEL}>Claude</span>
          </Link>
          {/* The person, last: who is signed in, and behind it Profile,
              Settings, the theme, passkeys and signing out
              (components/account-menu.tsx). Settings lives in there now; the
              button lights while a settings page is open, as its row did. */}
          <AccountMenu
            account={account}
            theme={theme}
            active={path.startsWith('/settings')}
            triggerClassName={NAV_ITEM}
            activeClassName={NAV_ITEM_ACTIVE}
            labelClassName={NAV_LABEL}
          />
        </nav>
      </aside>

      <main className="min-w-0 px-[clamp(1rem,3.5vw,2.75rem)] pt-[1.9rem] pb-28 max-rail:pb-32">
        {children ?? <Outlet />}
      </main>
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
    <nav className={NAV_LIST} aria-label="App sections">
      {/* activeProps muted: /apps prefix-matches every app detail URL, so the
          default would keep this lit on every page of the section. The back
          link is a destination, not a section of the app, so it keeps its
          own case and a quieter colour. */}
      <Link
        to="/apps"
        className={cn(NAV_ITEM, 'text-(--dim) normal-case hover:text-foreground')}
        data-label="All apps"
        activeProps={{}}
      >
        <NavIcon name="chevron" size={16} />
        <span className={NAV_LABEL}>All apps</span>
      </Link>

      <span className={NAV_DIVIDER} aria-hidden="true" />
      {/* Which app this is. The one line that goes with the labels when the
          rail collapses — at 64px there is no room for a name, and the
          icons below still work unchanged. */}
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
          className={cn(NAV_ITEM, t === app.tab && NAV_ITEM_ACTIVE)}
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
  return loading ? (
    <div
      className={cn(
        'fixed top-0 left-0 z-100 h-0.5 w-full origin-[0_50%]',
        'bg-linear-90 from-(--brand) to-(--brand-dim)',
        'animate-[route-progress_8s_cubic-bezier(0.1,0.8,0.2,1)_forwards]',
        // Someone who asked for less motion still needs the signal, so the
        // bar stays — it just sits at a fixed width instead of sweeping.
        'motion-reduce:animate-none motion-reduce:scale-x-[0.35]',
      )}
      role="progressbar"
      aria-label="Loading"
    />
  ) : null
}
