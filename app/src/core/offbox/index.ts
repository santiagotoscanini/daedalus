import type {
  ExternalApp,
  PagesDetail,
  ProviderStatus,
  VercelDetail,
} from '../../lib/external-apps'
import { PLATFORMS } from '../../lib/external-apps'
import { listAppNames } from '../../lib/repo/apps'
import type { Ctx } from '../ctx'
import { ghApp } from '../github-app'
import { discoverPages, pagesDetail } from './github-pages'
import { discoverVercel, vercelDetail } from './vercel'

// The off-box list: what GitHub Pages and Vercel host right now, asked of
// both and merged. Every reader on the box (the Apps page, the icon
// endpoint, the workspace clone allowlist, the Actions page's repo list)
// goes through `listExternalApps`, so they all agree on one answer.
//
// Cached in the process and served stale while a refresh runs: a cold read
// costs a few dozen GitHub and Vercel calls, and the Apps page must not wait
// on them every five minutes. The first read after a restart is the only one
// that waits.

export type Offbox = {
  sites: ExternalApp[]
  status: ProviderStatus[]
  checkedAt: string
}

const TTL_MS = 5 * 60_000

// On globalThis so a Vite re-evaluation does not drop the cache.
const memo = globalThis as unknown as {
  daedalusOffbox?: { value: Offbox | null; at: number; running: Promise<Offbox> | null }
}
memo.daedalusOffbox ??= { value: null, at: 0, running: null }
const slot = memo.daedalusOffbox

/** A step that threw reads as that platform failing, never as the list failing. */
async function settled(
  platform: ProviderStatus['platform'],
  work: Promise<{ sites: ExternalApp[]; status: ProviderStatus[] }>,
): Promise<{ sites: ExternalApp[]; status: ProviderStatus[] }> {
  try {
    return await work
  } catch {
    return {
      sites: [],
      status: [
        {
          platform,
          account: null,
          state: 'error',
          detail: 'the check failed; it is asked again within five minutes',
        },
      ],
    }
  }
}

/** Fill a Vercel row's description from its GitHub repository, when the App can see it. */
async function describe(
  ctx: Ctx,
  site: ExternalApp,
  known: Map<string, string | null>,
): Promise<ExternalApp> {
  if (site.description !== null || site.repo === null) return site
  const key = site.repo.toLowerCase()
  if (known.has(key)) return { ...site, description: known.get(key) ?? null }
  const r = await ghApp<{ description?: unknown }>(ctx, `/repos/${site.repo}`)
  const d = r.status === 200 && typeof r.body?.description === 'string' ? r.body.description : null
  return { ...site, description: d === '' ? null : d }
}

const order = (p: ExternalApp['platform']) => PLATFORMS.findIndex((x) => x.id === p)

async function load(ctx: Ctx): Promise<Offbox> {
  const [pages, vercel, names] = await Promise.all([
    settled('GitHub Pages', discoverPages(ctx)),
    settled('Vercel', discoverVercel(ctx)),
    listAppNames().catch(() => [] as string[]),
  ])
  const taken = new Set(names)
  const seen = new Set<string>()
  const known = new Map(pages.sites.map((s) => [s.repo?.toLowerCase() ?? '', s.description]))
  const merged: ExternalApp[] = []
  for (const s of [...pages.sites, ...vercel.sites]) {
    // An id a registry app already holds would make /api/app-icon serve the
    // wrong icon; one host listed twice (a Pages CNAME that is also a Vercel
    // alias) is shown once, under the platform that answered first.
    if (taken.has(s.id) || seen.has(s.id)) continue
    seen.add(s.id)
    merged.push(s)
  }
  const sites = await Promise.all(merged.map((s) => describe(ctx, s, known)))
  sites.sort((a, b) => order(a.platform) - order(b.platform) || a.name.localeCompare(b.name))
  return { sites, status: [...pages.status, ...vercel.status], checkedAt: new Date().toISOString() }
}

function refresh(ctx: Ctx): Promise<Offbox> {
  slot.running ??= load(ctx)
    .then((v) => {
      slot.value = v
      slot.at = Date.now()
      return v
    })
    .finally(() => {
      slot.running = null
    })
  return slot.running
}

/** The off-box list and how each platform answered. Never throws. */
export async function offbox(ctx: Ctx): Promise<Offbox> {
  if (slot.value === null) {
    try {
      return await refresh(ctx)
    } catch {
      return { sites: [], status: [], checkedAt: new Date().toISOString() }
    }
  }
  if (Date.now() - slot.at > TTL_MS) void refresh(ctx).catch(() => undefined)
  return slot.value
}

export async function listExternalApps(ctx: Ctx): Promise<ExternalApp[]> {
  return (await offbox(ctx)).sites
}

export async function findExternalApp(ctx: Ctx, id: string): Promise<ExternalApp | null> {
  return (await listExternalApps(ctx)).find((e) => e.id === id) ?? null
}

export type OffboxDetail =
  | { kind: 'pages'; detail: PagesDetail }
  | { kind: 'vercel'; detail: VercelDetail }

/**
 * One site's detail, its platform asked afresh — the publishes, the domains,
 * and for Vercel the traffic and the firewall. Null when no platform lists
 * the id, or the platform no longer answers for it. The detail page and the
 * MCP `offbox.get` both read through here.
 */
export async function offboxDetail(
  ctx: Ctx,
  id: string,
): Promise<{ site: ExternalApp; detail: OffboxDetail | null } | null> {
  const site = await findExternalApp(ctx, id)
  if (site === null) return null
  if (site.platform === 'GitHub Pages') {
    const detail = site.repo === null ? null : await pagesDetail(ctx, site.repo)
    return { site, detail: detail === null ? null : { kind: 'pages', detail } }
  }
  const detail = await vercelDetail(ctx, site.name)
  return { site, detail: detail === null ? null : { kind: 'vercel', detail } }
}
