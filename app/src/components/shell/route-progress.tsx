import { useRouterState } from '@tanstack/react-router'
import { cn } from '../../lib/cn'
import { useHydrated } from '../../lib/hydrated'

/**
 * A hairline at the top of the window while a route loader is in flight.
 *
 * The router keeps the previous page on screen until the loader resolves, and
 * a few routes await something before they can render at all — the app detail
 * page has to know the record exists before it can draw its frame, or decide
 * it is a 404. Those are tens of milliseconds, and the bar is what makes them
 * feel answered rather than ignored. Everything past that is a skeleton.
 *
 * CSS-animated rather than driven by real progress — a loader has no
 * measurable percentage, and a fake number that stalls at 80% is worse than an
 * honest indeterminate one.
 *
 * Never on the server, and never during hydration: the router is `pending`
 * while the server resolves the route, so SSR rendered this bar on every page
 * while the client, hydrating after the navigation was over, rendered nothing
 * — one failed hydration of the whole document per load (lib/hydrated.ts).
 */
export function RouteProgress() {
  const hydrated = useHydrated()
  const pending = useRouterState({ select: (s) => s.status === 'pending' })
  return hydrated && pending ? (
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
