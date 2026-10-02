// Live projects hosted OFF this box — GitHub Pages, Vercel — so the app list
// shows everything that is running somewhere, not only what this server runs.
//
// Nothing here is typed in. The rows are DISCOVERED (core/offbox/): every
// repository the GitHub App can see that has Pages turned on, on every
// account or org it is installed on, and every project the Vercel token can
// see. Nix never consumes the list — nothing on the box builds, serves or
// monitors these sites — so it is neither site configuration nor a
// preference: it is whatever the two platforms say right now.
//
// This file is the client-safe half: the shape a row reaches the page in,
// and the id rule.

/**
 * The hosting platforms, in the order their sections render. The UI keys its
 * brand icons off `id` (components live with the JSX, not here), so adding a
 * platform means an entry here plus a mark in PLATFORM_ICONS
 * (components/apps/app-card.tsx) — a compile error until it has one.
 */
export const PLATFORMS = [
  {
    id: 'GitHub Pages',
    description: 'static sites, built by Actions and served from github.io',
  },
  {
    id: 'Vercel',
    description: 'deployed from git, served on Vercel’s edge',
  },
] as const

export type Platform = (typeof PLATFORMS)[number]['id']

/** Where a site stands, as its platform reports it. */
export type SiteState = 'live' | 'building' | 'failed' | 'unknown'

export type ExternalApp = {
  /**
   * Keys the icon endpoint, its cache and the detail route, so it must be
   * unique AND must not collide with a registry app name — /api/app-icon
   * resolves registry apps first. Derived from the host by `externalAppId`:
   * a host always carries a dot, so its id always carries a hyphen where a
   * bare app name would not, and discovery drops a row that collides anyway.
   */
  id: string
  name: string
  /** Bare public hostname; every link and icon probe is https://<host>. */
  host: string
  platform: Platform
  /** The repository's own description; null when it has none. */
  description: string | null
  /**
   * Full owner/name GitHub slug — what the repo link, the Actions page and
   * the workspace clone button act on. Null for a Vercel project that is not
   * linked to a GitHub repository.
   */
  repo: string | null
  state: SiteState
  /** The last publish the platform recorded; null when it reports none. */
  deployed: { at: string; sha: string | null } | null
  /** Things worth a look — an expiring certificate, a domain not verified. Short phrases. */
  warnings: string[]
  /** The site's page on its platform (repo Pages settings, Vercel project). */
  dashboardUrl: string
}

/** Why a platform contributed no rows, or fewer than it might. One per account. */
export type ProviderStatus = {
  platform: Platform
  /** The GitHub account/org, or the Vercel scope; null before anything is known. */
  account: string | null
  state: 'ok' | 'not-configured' | 'needs-permission' | 'error'
  /** A sentence safe to show; null when state is ok. */
  detail: string | null
}

/** `docs.example.org` → `docs-example-org`: the id a host's row is filed under. */
export const externalAppId = (host: string): string =>
  host
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

/** The detail page's read of a Pages site (core/offbox/github-pages.ts). */
export type PagesDetail = {
  buildType: 'legacy' | 'workflow' | null
  source: { branch: string; path: string } | null
  httpsEnforced: boolean
  certificate: { state: string; expiresAt: string | null } | null
  /** Most recent first; each a publish GitHub recorded. */
  deploys: { at: string; sha: string | null; state: string; url: string | null }[]
}

/** The detail page's read of a Vercel project (core/offbox/vercel.ts). */
export type VercelDetail = {
  framework: string | null
  domains: {
    name: string
    verified: boolean
    misconfigured: boolean | null
    redirect: string | null
  }[]
  deploys: {
    at: string
    state: string
    target: string | null
    sha: string | null
    message: string | null
    url: string | null
    inspectorUrl: string | null
  }[]
  /** Null when Web Analytics is off for the project (or the plan lacks it). */
  analytics: { days: number; pageviews: number; visitors: number }[] | null
  /** The last 24 h of firewall actions; null when Vercel would not say. */
  firewall: {
    total: number
    blockingIps: number
    challengingIps: number
    byAction: Record<string, number>
  } | null
}
