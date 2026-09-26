import { createRootRoute, HeadContent, Scripts } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import appCss from '../app.css?url'
import { ErrorPanel, NotFoundPanel } from '../components/error'
import { NAV_BOOT, THEME_BOOT } from '../components/shell/boot'
import { RouteProgress } from '../components/shell/route-progress'
import { Shell } from '../components/shell/shell'
import { known } from '../lib/known'
import { useResolvedScheme } from '../lib/scheme'
import { SiteProvider } from '../lib/site-context'
import { presetById, themeCss } from '../lib/theme'
import { fetchAccount } from '../server/profile'
import { fetchShell } from '../server/shell'

// The root route: the HTML document every page renders inside, and what it
// needs before it can draw. The frame itself — the rail, the phone drawer,
// the page area — is components/shell/.

export const Route = createRootRoute({
  // The theme is the one thing the shell cannot render without, so it is
  // loaded here rather than by the page: every route renders inside this
  // document, and a per-route load would repaint the palette on navigation.
  //
  // The signed-in account is the opposite case: it asks Pocket ID, so it is
  // handed over as a promise and streams in behind the page — the rail's
  // account button draws a placeholder until then, and no page waits on it.
  //
  // The rail's rows are the third: which modules the box still runs is a
  // server-side answer (it reads the box's export), and a rail that streamed
  // in would shift every row under the cursor. Awaited, like the theme.
  //
  // The box's identity is the fourth, and awaited for a different reason: it
  // is what every hostname and repo link on the page is spelled from, and it
  // is a run-time fact of the box, never of the build. Awaited, it is in the
  // server's HTML and in the dehydrated data, so the browser's first render
  // spells them the same way.
  //
  // The fifth is the engine-override notice: one file read, and a notice
  // about the whole box that must not stream in under the page it is about.
  //
  // The four awaited ones are ONE server call (server/shell.ts), and past
  // the first load they are answered from this browser's memory and
  // refreshed behind the page (lib/known.ts): a navigation never waits on
  // the shell it is already showing.
  loader: async () => ({
    ...(await known('shell', fetchShell)),
    account: fetchAccount(),
  }),
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      // `viewport-fit=cover` so the drawer and the sticky top bar can reach
      // under a phone's rounded corners; the padding puts them back.
      { name: 'viewport', content: 'width=device-width, initial-scale=1, viewport-fit=cover' },
      { title: 'daedalus' },
      { name: 'description', content: 'S2 control plane' },
      // Behind a Pocket ID gate on the LAN; there is nothing here for a
      // crawler even if one could reach it.
      { name: 'robots', content: 'noindex, nofollow' },
    ],
    // Icons are plain files under public/ plus the link tags for them —
    // TanStack Start has no file-based icon convention, so every variant is
    // declared here.
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
  notFoundComponent: NotFoundPanel,
  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: ReactNode }) {
  const { theme, account, site, modules, engineOverride } = Route.useLoaderData()
  const scheme = useResolvedScheme(theme.scheme)
  const css = themeCss(presetById(theme.presetId))

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
        <SiteProvider site={site}>
          <Shell theme={theme} account={account} modules={modules} engineOverride={engineOverride}>
            {children}
          </Shell>
        </SiteProvider>
        <Scripts />
      </body>
    </html>
  )
}
