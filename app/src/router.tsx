import { createRouter as createTanStackRouter } from '@tanstack/react-router'
import { attachRouter } from './lib/known'
import { routeTree } from './routeTree.gen'

export function getRouter() {
  const router = createTanStackRouter({
    routeTree,
    scrollRestoration: true,
    // Preload on hover, and keep the preloaded result long enough for the
    // click to use it: a preload stale time of 0 marks it stale the instant
    // it lands, so the click fetches everything a second time.
    //
    // 15s of staleness is safe because a mutation reloads through
    // `router.invalidate()` (components/use-action.ts), which ignores it.
    defaultPreload: 'intent',
    defaultPreloadStaleTime: 15_000,
    // Same window for an ordinary navigation, so bouncing between two tabs
    // does not re-run a fan-out that cannot have changed yet.
    defaultStaleTime: 15_000,

    // No `defaultPendingComponent`: a pending component REPLACES the whole
    // route. The pages return their slow work as an unawaited promise and
    // render a skeleton shaped like the panel that is coming (components/
    // skeleton.tsx), so a loader is only "pending" for the small awaited part
    // — covered by the progress bar in __root, never worth blanking a page
    // that is already on screen.
  })
  // The loaders' memory (lib/known.ts) reloads through this router when a
  // remembered answer turns out to have changed, and reads fresh whenever
  // the app itself asks for a reload.
  attachRouter(router)
  return router
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
