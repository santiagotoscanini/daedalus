import { Outlet, useRouterState } from '@tanstack/react-router'
import { type ReactNode, useState } from 'react'
import type { Account } from '../../core/settings/types'
import { cn } from '../../lib/cn'
import type { ModuleManifest } from '../../lib/modules/manifest'
import type { ThemeChoice } from '../../lib/theme'
import { ControllerBanner } from '../controller-banner'
import { EngineOverrideBanner } from '../engine-override-banner'
import { PendingApplyBar } from '../pending-apply-bar'
import { useAppRailContext } from './app-rail'
import { CommandPalette, usePaletteHotkey } from './command-palette'
import { PhoneBar } from './phone-bar'
import { PhoneDrawer } from './phone-drawer'
import { Rail } from './rail'
import { useDrawer, useRailCollapse } from './use-rail'
import { useRailBadges } from './use-rail-badges'

// The frame around every page: the navigation rail and the page area.
//
//   ┌──────────┬───────────────────────────────┐
//   │  Rail    │  main                         │   desktop: a two-column grid,
//   │          │    EngineOverrideBanner       │   the first column as wide as
//   │          │    ControllerBanner           │
//   │          │    {children}   ← the page    │   --sidebar-w (theme.css)
//   │          │    PendingApplyBar            │
//   └──────────┴───────────────────────────────┘
//
//   phone: PhoneBar on top; the rail's body is a drawer over the page
//   (PhoneDrawer); --sidebar-w is 0.
//
// Rendered by __root.tsx's document. The pieces live beside this file:
// use-rail.ts (collapse + drawer state), rail.tsx, app-rail.tsx,
// phone-bar.tsx, phone-drawer.tsx, styles.ts.

type ShellProps = {
  children: ReactNode
  theme: ThemeChoice
  account: Promise<Account | null>
  modules: ModuleManifest[]
  engineOverride: boolean
}

export function Shell({ children, theme, account, modules, engineOverride }: ShellProps) {
  const path = useRouterState({ select: (s) => s.location.pathname })
  const { collapsed, toggle } = useRailCollapse()
  const drawer = useDrawer(path)
  // Inside an app the rail changes subject: that app's sections, with a way
  // back. Matched here (not in the route) because the rail is the shell's.
  const app = useAppRailContext()
  const badges = useRailBadges()
  const [palette, setPalette] = useState(false)
  usePaletteHotkey(setPalette)
  const onOpenPalette = () => setPalette(true)
  const rail = {
    modules,
    badges,
    app,
    path,
    account,
    theme,
    collapsed,
    onToggleCollapse: toggle,
    onOpenPalette,
  }

  return (
    // Grid on a desktop, block on a phone. Block, not a one-column grid: as a
    // grid with `min-height: 100vh` a short page left spare height divided
    // between the rows, floating the phone bar down the middle of it.
    <div className="grid min-h-screen grid-cols-[var(--sidebar-w)_1fr] max-rail:block">
      <CommandPalette
        open={palette}
        onOpenChange={setPalette}
        modules={modules}
        theme={theme}
        onToggleRail={toggle}
      />
      <PhoneBar drawer={drawer} onOpenPalette={onOpenPalette} />
      <PhoneDrawer drawer={drawer} {...rail} />
      <Rail {...rail} />
      <main
        className={cn(
          'col-start-2 min-w-0 bg-background px-[clamp(1rem,3.2vw,3rem)] pt-8 pb-28 max-rail:pt-6 max-rail:pb-32',
          // The content is a panel inset into the canvas the rail sits on,
          // one grey lighter: the rail reads as chrome, the page as the work.
          'rail:my-2 rail:mr-2 rail:min-h-[calc(100vh-1rem)] rail:rounded-[14px] rail:border rail:border-hairline rail:shadow-board',
          // A whisper of the accent at the panel's head — light, not paint.
          '[background-image:radial-gradient(44rem_22rem_at_15%_-6rem,var(--glow-a),transparent_70%),radial-gradient(48rem_24rem_at_95%_-8rem,var(--glow-b),transparent_70%)] bg-no-repeat',
        )}
      >
        {/* A measure for very wide windows: past it the boards would only
            grow emptier, so the column stops and centres. */}
        <div className="mx-auto w-full max-w-[112rem]">
          <EngineOverrideBanner on={engineOverride} />
          <ControllerBanner />
          {children ?? <Outlet />}
        </div>
        <PendingApplyBar />
      </main>
    </div>
  )
}
