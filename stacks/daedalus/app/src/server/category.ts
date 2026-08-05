import { createServerFn } from '@tanstack/react-start'

import type { AiData } from '../lib/dashboard/categories/ai'
import type { GamingData } from '../lib/dashboard/categories/gaming'
import type { BooksData, TvData } from '../lib/dashboard/categories/media'
import type { HomeData } from '../lib/dashboard/categories/home'
import type { MonitoringData } from '../lib/dashboard/categories/monitoring'
import type { NetworkData } from '../lib/dashboard/categories/network'
import type { SystemData } from '../lib/dashboard/categories/system'
import { CATEGORIES } from '../lib/dashboard/nav'
import type { CategoryName } from '../lib/dashboard/tiles'

// The loaders behind every category page.
//
// Server-side only, and necessarily so: every per-service API key in
// /run/daedalus-dashboard/env is read here and none of it may cross to the
// browser. What the client receives is numbers that have already been read,
// summed and formatted.
//
// One category and one sub-tab per request. The alternative — load everything
// and let the client pick — would mean ~90 upstream calls to render a page
// showing a fifth of them, on a box where several of those upstreams are
// services that charge real seconds for a cold connection.
//
// ── two functions, not one ────────────────────────────────────────────────
//
// A category page is two independent fan-outs: the boards (this category's own
// panels) and the tiles (the per-service directory beneath them). They share
// nothing, they finish at different times, and the route streams each in
// behind its own skeleton — so they are separate entry points rather than one
// call the page has to wait out. The page's own frame (title, lede, sub-tabs)
// needs neither: it comes from the static CATEGORIES table on the client and
// is on screen before either request is answered.

export type {
  AiData,
  BooksData,
  GamingData,
  HomeData,
  MonitoringData,
  NetworkData,
  SystemData,
  TvData,
}

/** The service directory that sits under every category's own panels. */
export type Tile = {
  key: string
  name: string
  group: string
  description: string
  href: string
  up: boolean | null
  stats: { label: string; value: string }[]
  note: string | null
}

export type CategoryTiles = {
  groups: { name: string; icon: string; tiles: Tile[] }[]
  /** Services in this category that gatus says are not answering. */
  down: string[]
}

export type CategoryPayload = Body

/** `https://<hostname>` per webApp, plus the host as containers see it. */
async function makeCtx(): Promise<{ base: (app: string) => string; hc: string }> {
  const { webAppHosts } = await import('../lib/nix-manifest')
  const hosts = await webAppHosts()
  return {
    // A missing webApp is a catalogue bug, not a runtime condition — the
    // manifest carries every published hostname. Falling back to the bare
    // name yields an obviously-broken link rather than a crashed page.
    base: (app: string) => `https://${hosts[app] ?? app}`,
    hc: 'http://host.containers.internal',
  }
}

/** Resolve a requested sub-tab against what the category actually declares. */
function resolveTab(category: CategoryName, tab: string): string {
  const spec = CATEGORIES.find((c) => c.id === category)
  if (spec === undefined) return ''
  return spec.tabs.some((t) => t.id === tab) ? tab : (spec.tabs[0]?.id ?? '')
}

export const fetchCategoryBoards = createServerFn()
  .inputValidator((input: { category: CategoryName; tab: string }) => input)
  .handler(async ({ data }): Promise<CategoryPayload> => {
    return loadCategory(data.category, resolveTab(data.category, data.tab), await makeCtx())
  })

export const fetchCategoryTiles = createServerFn()
  .inputValidator((input: { category: CategoryName; tab: string }) => input)
  .handler(async ({ data }): Promise<CategoryTiles> => {
    const { GROUPS, TILES } = await import('../lib/dashboard/tiles')
    const { pool, promVector } = await import('../lib/dashboard/clients')
    return loadTiles(data.category, resolveTab(data.category, data.tab), {
      GROUPS,
      TILES,
      pool,
      promVector,
      ctx: await makeCtx(),
    })
  })

type Body =
  | { kind: 'ai'; data: AiData }
  | { kind: 'tv'; data: TvData }
  | { kind: 'books'; data: BooksData }
  | { kind: 'home'; data: HomeData }
  | { kind: 'network'; data: NetworkData }
  | { kind: 'system'; data: SystemData }
  | { kind: 'monitoring'; data: MonitoringData }
  | { kind: 'gaming'; data: GamingData }

async function loadCategory(
  category: CategoryName,
  tab: string,
  ctx: { base: (app: string) => string; hc: string },
): Promise<Body> {
  switch (category) {
    case 'ai': {
      const { loadAi } = await import('../lib/dashboard/categories/ai')
      return { kind: 'ai', data: await loadAi(ctx) }
    }
    case 'media': {
      const { loadBooks, loadTv } = await import('../lib/dashboard/categories/media')
      return tab === 'books' ?
          { kind: 'books', data: await loadBooks(ctx) }
        : { kind: 'tv', data: await loadTv(ctx) }
    }
    case 'home': {
      const { loadHome } = await import('../lib/dashboard/categories/home')
      return { kind: 'home', data: await loadHome(ctx) }
    }
    case 'network': {
      const { loadNetwork } = await import('../lib/dashboard/categories/network')
      return { kind: 'network', data: await loadNetwork(ctx) }
    }
    case 'system': {
      const { loadSystem } = await import('../lib/dashboard/categories/system')
      return { kind: 'system', data: await loadSystem(ctx) }
    }
    case 'monitoring': {
      const { loadMonitoring } = await import('../lib/dashboard/categories/monitoring')
      return { kind: 'monitoring', data: await loadMonitoring(ctx) }
    }
    case 'gaming': {
      const { loadGaming } = await import('../lib/dashboard/categories/gaming')
      return { kind: 'gaming', data: await loadGaming(tab) }
    }
  }
}

type TileModules = {
  GROUPS: typeof import('../lib/dashboard/tiles')['GROUPS']
  TILES: typeof import('../lib/dashboard/tiles')['TILES']
  pool: typeof import('../lib/dashboard/clients')['pool']
  promVector: typeof import('../lib/dashboard/clients')['promVector']
  ctx: { base: (app: string) => string; hc: string }
}

async function loadTiles(
  category: CategoryName,
  tab: string,
  m: TileModules,
): Promise<CategoryTiles> {
  const groups = m.GROUPS.filter(
    (g) => g.category === category && (g.tab === undefined || g.tab === tab),
  )
  const names = new Set(groups.map((g) => g.name))
  const wanted = m.TILES.filter((t) => names.has(t.group))

  // Status comes from gatus, in one query for every tile: it probes the real
  // public URL from outside. `container_up` would answer a different question
  // — the unit being active does not mean the service is answering, and every
  // Type=oneshot podman unit on this box can be green over a dead container.
  const probes = await m.promVector('gatus_results_endpoint_success')
  const health = new Map(
    probes.map((p) => [(p.metric.key ?? '').replace(/^web-apps_/, ''), p.value[1] === '1']),
  )

  const loaded = await m.pool(
    wanted.map((t) => async () => {
      // The catch is the backstop for a `load` that throws despite the
      // helpers: one bad upstream must not blank the page, because "which one
      // is broken" is the whole reason to look at this.
      const result =
        t.load === undefined ? { stats: [], note: undefined } : (
          await t.load(m.ctx).catch(() => ({ stats: [], note: undefined }))
        )
      return {
        key: t.key,
        name: t.name,
        group: t.group as string,
        description: t.description,
        href: 'url' in t.link ? t.link.url : `${m.ctx.base(t.link.app)}${t.link.path ?? ''}`,
        // null = nothing probes this (the off-box services, and the link-only
        // bookmarks). Rendered as "no probe", not as down.
        up: t.gatus === undefined ? null : (health.get(t.gatus) ?? null),
        stats: result.stats,
        note: result.note ?? null,
      }
    }),
  )

  return {
    groups: groups.map((g) => ({
      name: g.name,
      icon: g.icon,
      tiles: loaded.filter((t) => t.group === g.name),
    })),
    down: loaded.filter((t) => t.up === false).map((t) => t.name),
  }
}
