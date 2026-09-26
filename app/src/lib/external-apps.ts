// Live projects hosted OFF this box — GitHub Pages, Vercel — so the app list
// shows everything that is running somewhere, not only what this server runs.
//
// Nothing on the box builds, serves or monitors these, so there is no
// registry row or nix manifest entry to derive them from, and nix never
// consumes the list — which makes it a preference, not site configuration.
// It lives in the settings store under `apps.external` (core/settings/
// external-apps.ts reads and writes it; Settings › Projects is the editor),
// and it is the operator's data: this file carries no rows, only the shape
// and the rules a new row is held to. An image is built once and runs on
// every box, so a row written here would be one box's projects on all of
// them. The hostname rule ("nix binds every hostname") does not apply for
// the same reason: the nix side has never heard of these hosts.

import { hostnameShapeError } from './site-fields'

/**
 * The hosting platforms, in the order their sections render. The UI keys its
 * brand icons off `id` (components live with the JSX, not here), so adding a
 * platform means an entry here plus a mark in PLATFORM_ICONS
 * (routes/apps.index.tsx) — a compile error until it has one.
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

export const isPlatform = (v: unknown): v is Platform => PLATFORMS.some((p) => p.id === v)

export type ExternalApp = {
  /**
   * Keys the icon endpoint and its cache, so it must be unique AND must not
   * collide with a registry app name — /api/app-icon resolves registry apps
   * first, and a collision would silently serve the wrong icon. Derived from
   * the host by `externalAppId`, never typed: a host always carries a dot, so
   * its id always carries a hyphen where a bare app name would not.
   */
  id: string
  name: string
  /** Bare public hostname; every link and icon probe is https://<host>. */
  host: string
  platform: Platform
  description: string
  /**
   * Full owner/name GitHub slug — full, unlike registry apps' `OWNER/<name>`
   * convention, because these live wherever they live, an org included. It
   * is what the repo link and the workspace clone button act on. Null means
   * "no repo to offer" and the row simply shows neither.
   */
  repo: string | null
}

/** What the editor sends: a row less the id the store derives for it. */
export type ExternalAppInput = Omit<ExternalApp, 'id'>

export const EXTERNAL_NAME_MAX = 64
export const EXTERNAL_DESCRIPTION_MAX = 200

/** `docs.example.org` → `docs-example-org`: the id a host's row is filed under. */
export const externalAppId = (host: string): string =>
  host
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

/** `owner/name`, as GitHub spells a repository. */
const REPO_SLUG = /^[a-z\d](?:[a-z\d-]*[a-z\d])?\/[\w.-]+$/i

/**
 * Why a row may not be added, or null when it may.
 *
 * `taken` is every id already in use — the stored rows' and the registry's
 * app names — so the collision the `id` field warns about is refused at the
 * door rather than discovered as the wrong icon. The server runs this over
 * the real lists; the form runs it over what it was handed, for the red box.
 */
export function externalAppError(input: ExternalAppInput, taken: readonly string[]): string | null {
  const name = input.name.trim()
  if (name === '') return 'a name is required.'
  if (name.length > EXTERNAL_NAME_MAX) {
    return `a name is at most ${String(EXTERNAL_NAME_MAX)} characters.`
  }
  const host = input.host.trim()
  const shape = hostnameShapeError(host)
  if (shape !== null) return shape
  if (!host.includes('.'))
    return 'a public hostname needs at least two labels, like docs.example.org.'
  if (!isPlatform(input.platform)) return 'not a platform this build knows.'
  if (input.description.trim() === '') return 'a description is required.'
  if (input.description.trim().length > EXTERNAL_DESCRIPTION_MAX) {
    return `a description is at most ${String(EXTERNAL_DESCRIPTION_MAX)} characters.`
  }
  if (input.repo !== null && !REPO_SLUG.test(input.repo.trim())) {
    return 'a repository is owner/name, as GitHub spells it — or leave it empty.'
  }
  if (taken.includes(externalAppId(host))) return `${host} is already listed.`
  return null
}

/** The row `externalAppError` accepted, trimmed and filed under its id. */
export function externalAppFrom(input: ExternalAppInput): ExternalApp {
  const host = input.host.trim().toLowerCase()
  const repo = input.repo?.trim() ?? ''
  return {
    id: externalAppId(host),
    name: input.name.trim(),
    host,
    platform: input.platform,
    description: input.description.trim(),
    repo: repo === '' ? null : repo,
  }
}

/**
 * The guard a stored list is read back through. Structural, field by field:
 * a row written by an older shape, or by hand with a platform this build
 * does not know, degrades to no rows at all rather than reaching a component.
 */
export function isExternalAppList(v: unknown): v is ExternalApp[] {
  if (!Array.isArray(v)) return false
  return v.every((e: unknown) => {
    if (e === null || typeof e !== 'object') return false
    const o = e as Record<string, unknown>
    return (
      typeof o.id === 'string' &&
      typeof o.name === 'string' &&
      typeof o.host === 'string' &&
      typeof o.description === 'string' &&
      isPlatform(o.platform) &&
      (o.repo === null || typeof o.repo === 'string')
    )
  })
}
