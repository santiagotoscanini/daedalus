import { createRouter as createTanStackRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'

export function getRouter() {
  return createTanStackRouter({
    routeTree,
    scrollRestoration: true,
    // Preload on hover, and — the load-bearing half — actually USE what was
    // preloaded. This was `0`, which marks a preload stale the instant it
    // lands, so every hover fetched a loader result that the click then threw
    // away and fetched again. The two settings cancelled out: preloading on,
    // benefit zero, cost doubled.
    //
    // 15s of staleness is safe because nothing here goes stale silently: every
    // mutation calls `router.invalidate()` (see the apps detail page), and the
    // numbers this cache covers are 60s-resolution metrics to begin with.
    defaultPreload: 'intent',
    defaultPreloadStaleTime: 15_000,
    // Same window for an ordinary navigation, so bouncing between two tabs
    // does not re-run a fan-out that cannot have changed yet.
    defaultStaleTime: 15_000,

    // Feedback while a loader runs is a progress bar in the shell (__root),
    // deliberately NOT a `defaultPendingComponent`. A pending component
    // REPLACES the route's content, so switching dashboard tabs would blank two
    // dozen tiles and flash a spinner. Keeping the old content on screen with a
    // bar moving above it is calmer, and more honest: those numbers really are
    // the last ones that were read.
  })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
