// The auth names a browser bundle may import.
//
// `core/auth.ts` imports `@tanstack/react-start/server`, which TanStack Start's
// import protection refuses in the client environment — `vite dev` never
// noticed, `vite build` fails on it. A component that only needs the group's
// NAME imports it from here; `core/auth.ts` re-exports it, so server code keeps
// one import.

/**
 * The Pocket ID group that may change this box — checked by core/authz.ts,
 * whose header says how that check relates to the IdP's own.
 */
export const ADMIN_GROUP = 'admins'
