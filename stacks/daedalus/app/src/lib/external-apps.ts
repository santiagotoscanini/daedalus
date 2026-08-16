// Live projects hosted OFF this box — GitHub Pages, Vercel — so the app list
// shows everything that is running somewhere, not only what this server runs.
//
// A hand-edited literal, deliberately: nothing on the box builds, serves or
// monitors these, so there is no registry row or nix manifest entry to derive
// them from. This array IS the source of truth — add an entry to add a card.
// The hostname rule ("nix binds every hostname") does not apply here for the
// same reason: the nix side has never heard of these hosts.

import { OWNER } from './site'

/**
 * The hosting platforms, in the order their sections render. The UI keys its
 * brand icons off `id` (components live with the JSX, not here), so adding a
 * platform means an entry here plus a mark in the route's PLATFORM_ICONS.
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

export type ExternalApp = {
  /**
   * Keys the icon endpoint and its cache, so it must be unique AND must not
   * collide with a registry app name — /api/app-icon resolves registry apps
   * first, and a collision would silently serve the wrong icon. That is why
   * the landing page is `daedalus-landing`, never bare `daedalus`.
   */
  id: string
  name: string
  /** Bare public hostname; every link and icon probe is https://<host>. */
  host: string
  platform: Platform
  description: string
  /**
   * Full owner/name GitHub slug — full, unlike registry apps' `OWNER/<name>`
   * convention, because these live wherever they live (the santree pair is
   * under an org). Hand-maintained like everything else in this file; it is
   * what the repo link and the workspace clone button act on. Null means
   * "no repo to offer" and the row simply shows neither.
   */
  repo: string | null
}

export const EXTERNAL_APPS: ExternalApp[] = [
  {
    id: 'santree',
    name: 'santree',
    host: 'santree.toscanini.me',
    platform: 'GitHub Pages',
    description: 'Your backlog, shipped in parallel — Claude agents across your repo’s tickets.',
    repo: 'santree-ai/santree',
  },
  {
    id: 'santree-cli',
    name: 'santree-cli',
    host: 'santree-cli.toscanini.me',
    platform: 'GitHub Pages',
    description: 'A CLI for managing Git worktrees with integrated AI assistance.',
    repo: 'santree-ai/santree-cli',
  },
  {
    id: 'daedalus-landing',
    name: 'daedalus',
    host: 'daedalus.toscanini.me',
    platform: 'GitHub Pages',
    description: 'The Daedalus landing page — the app itself runs on this box, above.',
    // The flake repo: website/ in it is what Pages serves. A clone of it in
    // ~/projects is a second checkout beside the live /etc/nixos one — fine
    // for working on the landing page, but system changes belong in the
    // live checkout, which is the one a rebuild reads.
    repo: `${OWNER}/daedalus`,
  },
  {
    id: 'portfolio',
    name: 'toscanini.me',
    host: 'toscanini.me',
    platform: 'Vercel',
    description: 'Personal portfolio.',
    repo: `${OWNER}/personal-portfolio`,
  },
]

export const externalApp = (id: string): ExternalApp | null =>
  EXTERNAL_APPS.find((e) => e.id === id) ?? null
