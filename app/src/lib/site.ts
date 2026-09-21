// The box's identity, as a value — never as a module constant.
//
// An image is built once and run on every box, so nothing here may be known at
// build time: no `import.meta.env`, which Vite inlines into both bundles, and
// no top-level read of anything. The server reads a `Site` per request from
// its container env (host/site.ts, `ctx.site` in a module loader); the browser
// receives that same value in the root loader's data and reads it with
// `useSite()` (lib/site-context.tsx). Everything below is a pure function of
// the `Site` it is handed, which is what keeps this file client-safe.
//
// The fallbacks keep a bare checkout and the test runner working; on a box the
// bindings are always present. They are deliberately placeholder-shaped — a
// missing binding should look missing, not look like some particular box.

export type Site = {
  /** The domain every published host is exactly one label under. */
  baseDomain: string
  /** GitHub account the app repos live under. */
  owner: string
  /** The box's own image registry (zot), as a bare host. */
  registryHost: string
  grafanaUrl: string
}

/** What the box bound, before the fallbacks. Absent and empty read the same. */
export type SiteBindings = { [K in keyof Site]?: string | undefined }

const bound = (v: string | undefined): string | undefined => (v === '' ? undefined : v)

/** A whole `Site` from whatever was bound. The two derived hosts follow the domain that was. */
export function siteFrom(bindings: SiteBindings): Site {
  const baseDomain = bound(bindings.baseDomain) ?? 'localhost'
  return {
    baseDomain,
    owner: bound(bindings.owner) ?? 'unknown-owner',
    registryHost: bound(bindings.registryHost) ?? `registry.${baseDomain}`,
    grafanaUrl: bound(bindings.grafanaUrl) ?? `https://grafana.${baseDomain}`,
  }
}

/** Nothing bound: what a component outside the root provider, or a test, reads. */
export const UNBOUND_SITE: Site = siteFrom({})

/** The platform-default image for a registry app. */
export const defaultImage = (site: Site, name: string): string =>
  `${site.registryHost}/${name}:latest`

/** The registry host, escaped for use inside a RegExp. */
export const registryHostPattern = (site: Site): string =>
  site.registryHost.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** `films.<baseDomain>` → `films`; names outside the domain pass through whole. */
export const stripBaseDomain = (site: Site, host: string): string =>
  host.endsWith(`.${site.baseDomain}`) ? host.slice(0, -(site.baseDomain.length + 1)) : host

/** `<owner>/<name>`: where a registry app's repository lives. */
export const appRepo = (site: Site, name: string): string => `${site.owner}/${name}`
