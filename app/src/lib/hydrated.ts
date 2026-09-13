/**
 * "Am I past hydration?" — the one question a server-rendered component has to
 * be able to ask before it renders anything the server could not have known.
 *
 * React's rule for hydration is stricter than it first looks: the markup the
 * client produces on its FIRST render must match the HTML byte for byte, and
 * "first render" happens in the browser, where `matchMedia`, `Date.now()` and
 * the local timezone are all available and all tempting. Reading any of them
 * there is how a tree that rendered fine on the server disagrees with itself a
 * beat later.
 *
 * `useSyncExternalStore` answers it exactly, and an effect does not:
 * `getServerSnapshot` is what React uses for the server render AND for the
 * hydration pass, so one value covers both moments, and the swap to the client
 * snapshot happens as part of hydration finishing rather than one paint after
 * it. A `useState(false)` + `useEffect` pair would flash the server value for a
 * frame; this does not.
 *
 * The store never changes, so nothing ever calls the subscriber — the whole
 * mechanism is the two snapshots.
 */

import { useSyncExternalStore } from 'react'

const subscribeNever = () => () => {}
const onClient = () => true
const onServer = () => false

/** `false` on the server and through hydration, `true` from then on. */
export function useHydrated(): boolean {
  return useSyncExternalStore(subscribeNever, onClient, onServer)
}
