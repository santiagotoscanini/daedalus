import { Outlet, useRouterState } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import type { Account } from '../../core/settings/types'
import type { ModuleManifest } from '../../lib/modules/manifest'
import type { ThemeChoice } from '../../lib/theme'
import { EngineOverrideBanner } from '../engine-override-banner'
import { PendingApplyBar } from '../pending-apply-bar'
import { useAppRailContext } from './app-rail'
import { PhoneBar, Scrim } from './phone-bar'
import { Rail } from './rail'
import { useDrawer, useRailCollapse } from './use-rail'

// The frame around every page: the navigation rail and the page area.
//
//   ┌──────────┬───────────────────────────────┐
//   │  Rail    │  main                         │   desktop: a two-column grid,
//   │          │    EngineOverrideBanner       │   the first column as wide as
//   │          │    {children}   ← the page    │   --sidebar-w (theme.css)
//   │          │    PendingApplyBar            │
//   └──────────┴───────────────────────────────┘
//
//   phone: PhoneBar on top; the Rail is a drawer over the page, with a Scrim
//   behind it; --sidebar-w is 0.
//
// Rendered by __root.tsx's document. The pieces live beside this file:
// use-rail.ts (collapse + drawer behaviour), rail.tsx, app-rail.tsx,
// phone-bar.tsx, styles.ts.

type ShellProps = {
  children: ReactNode
  theme: ThemeChoice
  account: Promise<Account | null>
  modules: ModuleManifest[]
  engineOverride: string | null
}

export function Shell({ children, theme, account, modules, engineOverride }: ShellProps) {
  const path = useRouterState({ select: (s) => s.location.pathname })
  const { collapsed, toggle } = useRailCollapse()
  const drawer = useDrawer(path)
  // Inside an app the rail changes subject: that app's sections, with a way
  // back. Matched here (not in the route) because the rail is the shell's.
  const app = useAppRailContext()

  return (
    // Grid on a desktop, block on a phone. Block, not a one-column grid: as a
    // grid with `min-height: 100vh` a short page left spare height divided
    // between the rows, floating the phone bar down the middle of it.
    <div className="grid min-h-screen grid-cols-[var(--sidebar-w)_1fr] max-rail:block">
      <PhoneBar drawer={drawer} />
      <Scrim drawer={drawer} />
      <Rail
        modules={modules}
        app={app}
        path={path}
        account={account}
        theme={theme}
        collapsed={collapsed}
        onToggleCollapse={toggle}
        drawer={drawer}
      />
      <main className="col-start-2 min-w-0 px-[clamp(1rem,3.5vw,2.75rem)] pt-[1.9rem] pb-28 max-rail:pb-32">
        <EngineOverrideBanner path={engineOverride} />
        {children ?? <Outlet />}
        <PendingApplyBar />
      </main>
    </div>
  )
}
