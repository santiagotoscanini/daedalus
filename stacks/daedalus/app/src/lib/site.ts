// The box's identity, injected by daedalus.nix as VITE_-prefixed env so the
// CLIENT bundle gets it too — validators and JSX need these, and a file read
// under /export is server-only. Vite replaces import.meta.env statically on
// the client and passes it through on the server, so both sides read the one
// nix-bound value and no hostname is ever typed out in TypeScript again.
//
// The fallbacks keep a bare `pnpm dev` on a laptop (and the test runner)
// working; on the box the env is always present. They are deliberately
// placeholder-shaped — a missing binding should look missing, not look like
// this box.

export const BASE_DOMAIN: string = import.meta.env.VITE_BASE_DOMAIN ?? 'localhost'

/** GitHub account the app repos and CI live under. */
export const OWNER: string = import.meta.env.VITE_GITHUB_OWNER ?? 'unknown-owner'

/** The box's own image registry (zot), as a bare host. */
export const REGISTRY_HOST: string = import.meta.env.VITE_REGISTRY_HOST ?? `registry.${BASE_DOMAIN}`

export const GRAFANA_URL: string =
  import.meta.env.VITE_GRAFANA_URL ?? `https://grafana.${BASE_DOMAIN}`

/** The platform-default image for a registry app. */
export const defaultImage = (name: string): string => `${REGISTRY_HOST}/${name}:latest`

/** REGISTRY_HOST, escaped for use inside a RegExp. */
export const REGISTRY_HOST_PATTERN: string = REGISTRY_HOST.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** `films.<baseDomain>` → `films`; names outside the domain pass through whole. */
export const stripBaseDomain = (host: string): string =>
  host.endsWith(`.${BASE_DOMAIN}`) ? host.slice(0, -(BASE_DOMAIN.length + 1)) : host
