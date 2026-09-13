/**
 * The scheme in force — `light` or `dark` — resolved from the operator's
 * stored choice, which may be `system`.
 *
 * `system` is the one case the server cannot answer: the OS preference lives
 * in the browser. Before hydration the inline THEME_BOOT script in
 * routes/__root.tsx resolves it onto `<html data-theme>` so the first paint
 * is right; after hydration THIS is what resolves it, so React's own idea of
 * the attribute agrees with the DOM. It has to: React owns `data-theme`,
 * and any re-render of the document — a failed hydration regenerating the
 * tree, a route change — writes React's value back. When that value was the
 * server's guess ("dark"), every click on the rail flipped a light system
 * back to dark.
 *
 * `useSyncExternalStore` rather than an effect because it has the two
 * snapshots this needs: the server one (the guess the HTML was rendered
 * with, so hydration matches) and the client one (the real answer), which
 * React swaps in immediately after hydrating — and it re-renders when the OS
 * preference changes under an open tab.
 */

import { useLoaderData } from '@tanstack/react-router'
import { useSyncExternalStore } from 'react'
import { useHydrated } from './hydrated'
import type { Scheme } from './theme'

export type ResolvedScheme = 'light' | 'dark'

/* The same question THEME_BOOT asks, so the two can never disagree. */
const LIGHT = '(prefers-color-scheme: light)'

function subscribe(onChange: () => void): () => void {
  const query = matchMedia(LIGHT)
  query.addEventListener('change', onChange)
  return () => {
    query.removeEventListener('change', onChange)
  }
}

/** What the server renders for a choice it cannot resolve. */
export function serverScheme(choice: Scheme): ResolvedScheme {
  return choice === 'system' ? 'dark' : choice
}

/** The real answer, available only where `matchMedia` is. */
function browserScheme(choice: Scheme): ResolvedScheme {
  if (choice !== 'system') return choice
  return matchMedia(LIGHT).matches ? 'light' : 'dark'
}

export function useResolvedScheme(choice: Scheme): ResolvedScheme {
  return useSyncExternalStore(
    subscribe,
    () => browserScheme(choice),
    // The "server" snapshot has to answer for two different moments, and they
    // want different things. On the server there is no OS preference to read,
    // so it is the guess. But React also calls this during HYDRATION, in the
    // browser — and by then THEME_BOOT has already replaced the guess on
    // `<html data-theme>` with the real answer. Returning the guess there
    // disagreed with the DOM on every machine whose preference is not `dark`,
    // which is one failed hydration of the whole document per page load, on
    // every page. It had been read as a `Date.now()` mismatch and written into
    // the operator's notes as a baseline to expect: two page errors a load,
    // masking every hydration bug that might come after it.
    () => (typeof document === 'undefined' ? serverScheme(choice) : browserScheme(choice)),
  )
}

/**
 * The scheme in force, for a component anywhere under the root route — the
 * embedded Grafana frames, which take a `theme` of their own and would
 * otherwise sit as a dark rectangle on a light page.
 *
 * ── why this is not just `useResolvedScheme` ──────────────────────────────
 *
 * The hook above is right for `<html data-theme>` and wrong for everything
 * else, and the difference is THEME_BOOT. That inline script runs before
 * hydration and rewrites the attribute to the real answer, so by the time
 * React hydrates, the DOM it is checking itself against already holds the
 * truth — which is why that hook's "server" snapshot has to answer with the
 * truth too.
 *
 * Nothing rewrites ordinary markup. A `?theme=dark` the server baked into an
 * iframe's `src` is still `dark` in the DOM at hydration, so a hook that
 * answers `light` there disagrees with the HTML — eleven "a tree hydrated but
 * some attributes … didn't match" warnings, one per embedded Grafana panel,
 * plus the geo map on an app's Access tab. Recoverable, unlike the document
 * regeneration THEME_BOOT's mismatch caused, but the same bug: React's first
 * client render disagreeing with the HTML it was handed.
 *
 * So this one answers with the guess through hydration and the truth after —
 * which is the honest order anyway, because the guess is what the HTML says.
 * The frames carry the resolved scheme in a `key`, so the correction remounts
 * them: one extra panel load, and only for `system` on a light machine.
 */
export function useScheme(): ResolvedScheme {
  const choice = useLoaderData({ from: '__root__', select: (d) => d.theme.scheme })
  const resolved = useResolvedScheme(choice)
  return useHydrated() ? resolved : serverScheme(choice)
}
