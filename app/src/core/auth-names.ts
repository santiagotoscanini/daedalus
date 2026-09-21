// The auth names a browser bundle may import.
//
// `core/auth.ts` imports `@tanstack/react-start/server`, which TanStack Start's
// import protection refuses in the client environment — `vite dev` never
// noticed, `vite build` fails on it. A component that only needs the group's
// NAME imports it from here; `core/auth.ts` re-exports it, so server code keeps
// one import.

/**
 * The Pocket ID group that may change this box.
 *
 * The real gate is one layer earlier — the derived Pocket ID client allows
 * `authGroups`, default [ "admins" ], so someone outside it never gets a
 * session and never reaches us. What `core/auth.ts` adds is a second check at
 * the thing that actually writes, so a widened client (an app shared with
 * "family", say) cannot silently become a licence to press Apply.
 */
export const ADMIN_GROUP = 'admins'
