import { Link } from '@tanstack/react-router'
import type { Account } from '../../core/settings/types'
import { cn } from '../../lib/cn'
import type { ModuleManifest } from '../../lib/modules/manifest'
import type { ThemeChoice } from '../../lib/theme'
import { AccountMenu } from '../account-menu'
import { NavIcon, type NavIconName } from '../nav-icon'
import { AppRail, type AppRailContext } from './app-rail'
import {
  BRAND,
  ICON_BUTTON,
  NAV_DIVIDER,
  NAV_ITEM,
  NAV_ITEM_ACTIVE,
  NAV_LABEL,
  NAV_LIST,
} from './styles'
import type { Drawer } from './use-rail'

// The rail: one element, two layouts.
//
//   desktop  a fixed column beside the page, collapsible to 64px of icons
//   phone    an off-canvas drawer, slid in by the phone bar's menu button
//
// One element rather than two copies of the navigation that drift apart; the
// two states are kept apart entirely in CSS (`max-rail:` below 52rem).
//
//   ┌ RailHead ─────────────┐  logo · collapse chevron (desktop) · close (phone)
//   │ DirectoryNav          │  Apps, then the modules this box runs
//   │   — or AppRail —      │  inside an app: that app's sections
//   │                       │
//   │ FleetNav (at the foot)│  modules about every machine · account menu
//   └───────────────────────┘

type RailProps = {
  modules: ModuleManifest[]
  app: AppRailContext | null
  path: string
  account: Promise<Account | null>
  theme: ThemeChoice
  collapsed: boolean
  onToggleCollapse: () => void
  drawer: Drawer
}

export function Rail({
  modules,
  app,
  path,
  account,
  theme,
  collapsed,
  onToggleCollapse,
  drawer,
}: RailProps) {
  // Two kinds of entry. The directory is what this box RUNS, one row per
  // subject area. A module with a machine picker is about every machine on
  // the network, this one included — a different kind of thing, so it sits
  // at the foot on its own.
  const directory = modules.filter((m) => m.machinePicker !== true)
  const fleet = modules.filter((m) => m.machinePicker === true)

  return (
    // Fixed, not sticky. A sticky rail depends on the body being the
    // scroller, and every Radix popover (a Select, the account menu) locks the
    // body's overflow while open: Chrome then left a sticky rail wherever the
    // page was scrolled to until the next scroll event, which read as the
    // rail vanishing. The grid's first column is the room it takes.
    <aside
      id="nav"
      className={cn(
        'fixed inset-y-0 left-0 z-20 flex w-(--sidebar-w) flex-col gap-[1.4rem]',
        'border-r border-r-(--border-soft) bg-background px-[0.7rem] pt-[1.1rem] pb-[0.9rem]',
        'nav-collapsed:px-[0.55rem]',
        // Below the breakpoint it is a drawer. `visibility`, not transform
        // alone: a rail merely moved off the left edge is still in the tab
        // order and still read out. The delay keeps it visible for the length
        // of the closing slide.
        'max-rail:fixed max-rail:inset-y-0 max-rail:left-0 max-rail:right-auto max-rail:z-[60]',
        'max-rail:h-[100dvh] max-rail:w-[min(17.5rem,82vw)] max-rail:gap-[1.1rem]',
        'max-rail:overflow-y-auto max-rail:border-r-border',
        'max-rail:pt-3 max-rail:pb-[1.4rem] max-rail:pl-[max(0.7rem,env(safe-area-inset-left))]',
        'max-rail:invisible max-rail:-translate-x-full',
        'max-rail:transition-[transform,visibility] max-rail:duration-[220ms]',
        'max-rail:ease-[cubic-bezier(0.4,0,0.2,1)] max-rail:delay-[0s,220ms]',
        'max-rail:data-[open=true]:visible max-rail:data-[open=true]:translate-x-0',
        'max-rail:data-[open=true]:delay-0',
      )}
      data-open={drawer.open ? 'true' : 'false'}
    >
      <RailHead collapsed={collapsed} onToggleCollapse={onToggleCollapse} drawer={drawer} />
      {app !== null ? <AppRail app={app} /> : <DirectoryNav modules={directory} />}
      <FleetNav modules={fleet} path={path} account={account} theme={theme} />
    </aside>
  )
}

/**
 * The top row: the wordmark, the desktop collapse chevron, and the phone
 * drawer's close button. Collapsed, the row has no room beside the logo, so it
 * becomes a column: logo above, chevron beneath.
 */
function RailHead({
  collapsed,
  onToggleCollapse,
  drawer,
}: {
  collapsed: boolean
  onToggleCollapse: () => void
  drawer: Drawer
}) {
  return (
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

      {/* Desktop only: `<` to collapse, `>` to expand. */}
      <button
        type="button"
        className={cn(
          ICON_BUTTON,
          'size-8 text-(--dim) max-rail:hidden nav-collapsed:[&>svg]:rotate-180',
        )}
        onClick={onToggleCollapse}
        aria-pressed={collapsed}
        aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
      >
        <NavIcon name="chevron" size={17} />
      </button>

      {/* Phone only: closes the drawer and hands focus back to its opener. */}
      <button
        ref={drawer.closeButton}
        type="button"
        className={cn(ICON_BUTTON, 'hidden max-rail:inline-flex')}
        aria-label="Close navigation"
        onClick={() => {
          drawer.hide(true)
        }}
      >
        <NavIcon name="close" size={18} />
      </button>
    </div>
  )
}

/**
 * Apps, then one row per module this box runs. Apps is the management
 * surface; every module below it is a read-only view of one subject area.
 */
function DirectoryNav({ modules }: { modules: ModuleManifest[] }) {
  return (
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

      {modules.map((m) => (
        <ModuleRow key={m.id} module={m} />
      ))}
    </nav>
  )
}

/**
 * The foot of the rail, pushed there with `mt-auto`: the modules about every
 * machine on the network (System), then the signed-in person — behind whose
 * menu are Profile, Settings, the theme and signing out. The menu's button
 * lights while either of its pages is open, as a row would.
 */
function FleetNav({
  modules,
  path,
  account,
  theme,
}: {
  modules: ModuleManifest[]
  path: string
  account: Promise<Account | null>
  theme: ThemeChoice
}) {
  return (
    <nav className={cn(NAV_LIST, 'mt-auto')} aria-label="This workshop">
      <span className={NAV_DIVIDER} aria-hidden="true" />
      {modules.map((m) => (
        <ModuleRow key={m.id} module={m} />
      ))}
      <AccountMenu
        account={account}
        theme={theme}
        active={path.startsWith('/settings') || path.startsWith('/profile')}
        triggerClassName={NAV_ITEM}
        activeClassName={NAV_ITEM_ACTIVE}
        labelClassName={NAV_LABEL}
      />
    </nav>
  )
}

/**
 * One module's row. The sub-tab is left off (`search={{}}`) so the page's
 * loader picks the module's first; naming it here would mean the rail and
 * the route disagreed the moment a tab was renamed. `data-label` is what the
 * collapsed rail's tooltip says. The icon is keyed by the module id.
 */
function ModuleRow({ module }: { module: ModuleManifest }) {
  return (
    <Link
      to="/c/$category"
      params={{ category: module.id }}
      search={{}}
      className={NAV_ITEM}
      activeProps={{ className: NAV_ITEM_ACTIVE }}
      data-label={module.label}
    >
      <NavIcon name={module.id as NavIconName} />
      <span className={NAV_LABEL}>{module.label}</span>
    </Link>
  )
}
