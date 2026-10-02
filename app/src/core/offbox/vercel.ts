import type { ExternalApp, ProviderStatus, SiteState, VercelDetail } from '../../lib/external-apps'
import { externalAppId } from '../../lib/external-apps'
import { getJsonResult } from '../../lib/http'
import type { Ctx } from '../ctx'

// Vercel projects, discovered: everything the box's Vercel token can see, in
// every scope it reaches — the personal account and each team — one row per
// project, served at its first custom production domain.
//
// Vercel has no read-only token; the one the operator pastes in Settings ›
// Integrations can write, and this module only ever GETs. The token stays
// inside `vercel()`: never in a result, an error or a log.

export const VERCEL_API = 'https://api.vercel.com'

/** A scope the token reaches: the personal account (teamId null) or a team. */
export type VercelScope = { teamId: string | null; slug: string; name: string }

type Failure = { status: number | null; error: string | null }
type Got<T> = { ok: true; value: T } | { ok: false; reason: Failure }

/** One GET as the token, `teamId` added when the scope is a team. */
async function vercel<T>(
  ctx: Ctx,
  path: string,
  scope: VercelScope | null,
  query: Record<string, string> = {},
): Promise<Got<T>> {
  const token = ctx.secret('VERCEL_API_TOKEN')
  if (token === '') return { ok: false, reason: { status: null, error: 'not-configured' } }
  const params = new URLSearchParams(query)
  if (scope?.teamId) params.set('teamId', scope.teamId)
  const qs = params.toString()
  return getJsonResult<T>(`${VERCEL_API}${path}${qs === '' ? '' : `?${qs}`}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
}

/** A failed call, as a sentence that is safe to show. */
export function describeVercelFailure(f: Failure): string {
  if (f.error === 'not-configured') return 'no Vercel token is configured'
  if (f.status === null) return 'Vercel did not answer'
  if (f.status === 401) return 'Vercel does not recognise the token (expired or revoked?)'
  if (f.status === 403) return 'the token is not allowed to read this'
  if (f.status === 429) return 'Vercel’s rate limit is spent; it is asked again shortly'
  return `Vercel answered ${String(f.status)}`
}

type User = { user?: { username?: unknown; name?: unknown; defaultTeamId?: unknown } }
type Teams = { teams?: { id?: unknown; slug?: unknown; name?: unknown }[] }

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)

/**
 * Who the token is and which scopes it reaches. A team-scoped token refuses
 * `/v2/user`'s personal scope for projects but still names its user; the
 * team list is what it can actually read.
 */
export async function vercelScopes(
  ctx: Ctx,
): Promise<{ ok: true; user: string; scopes: VercelScope[] } | { ok: false; reason: string }> {
  const [user, teams] = await Promise.all([
    vercel<User>(ctx, '/v2/user', null),
    vercel<Teams>(ctx, '/v2/teams', null, { limit: '50' }),
  ])
  if (!user.ok) return { ok: false, reason: describeVercelFailure(user.reason) }
  const username = str(user.value.user?.username) ?? 'personal'
  const scopes: VercelScope[] = []
  for (const t of teams.ok ? (teams.value.teams ?? []) : []) {
    const id = str(t.id)
    const slug = str(t.slug)
    if (id !== null && slug !== null) scopes.push({ teamId: id, slug, name: str(t.name) ?? slug })
  }
  // The personal scope last: on accounts where it is also a team (Vercel's
  // default team), the team entry above already reads the same projects and
  // dedup by project id keeps the first.
  scopes.push({ teamId: null, slug: username, name: username })
  return { ok: true, user: username, scopes }
}

/** When the token expires (ISO), or null when it never does or Vercel would not say. */
export async function vercelTokenExpiry(ctx: Ctx): Promise<string | null> {
  const r = await vercel<{ token?: { expiresAt?: unknown } }>(ctx, '/v5/user/tokens/current', null)
  const at = r.ok ? r.value.token?.expiresAt : undefined
  return typeof at === 'number' && Number.isFinite(at) ? new Date(at).toISOString() : null
}

/** `/v10/projects`' project, the fields read here. */
type Project = {
  id?: unknown
  name?: unknown
  framework?: unknown
  link?: { type?: unknown; org?: unknown; repo?: unknown } | null
  targets?: {
    production?: {
      readyState?: unknown
      createdAt?: unknown
      alias?: unknown
      meta?: { githubCommitSha?: unknown } | null
    } | null
  } | null
  alias?: { domain?: unknown; target?: unknown }[]
  webAnalytics?: { enabledAt?: unknown; disabledAt?: unknown } | null
  paused?: unknown
}

/** readyState of the production deployment → the row's state. */
export function vercelState(readyState: unknown): SiteState {
  if (readyState === 'READY') return 'live'
  if (readyState === 'BUILDING' || readyState === 'QUEUED' || readyState === 'INITIALIZING') {
    return 'building'
  }
  if (readyState === 'ERROR' || readyState === 'CANCELED') return 'failed'
  return 'unknown'
}

/** The production domains, custom ones first, `*.vercel.app` last. */
export function productionDomains(p: Project): string[] {
  const fromTarget = Array.isArray(p.targets?.production?.alias)
    ? (p.targets?.production?.alias as unknown[])
    : []
  const fromAlias = (p.alias ?? [])
    .filter((a) => a.target === 'PRODUCTION' || a.target === undefined)
    .map((a) => a.domain)
  const all = [...fromTarget, ...fromAlias]
    .map((d) => str(d)?.toLowerCase() ?? null)
    .filter((d): d is string => d !== null)
  const unique = [...new Set(all)]
  const custom = unique.filter((d) => !d.endsWith('.vercel.app'))
  return [...custom, ...unique.filter((d) => d.endsWith('.vercel.app'))]
}

export const projectRepo = (p: Project): string | null => {
  if (p.link?.type !== 'github') return null
  const org = str(p.link.org)
  const repo = str(p.link.repo)
  return org !== null && repo !== null ? `${org}/${repo}` : null
}

/** One project as a row; null when it is not shaped like one. */
export function vercelRow(p: Project, scope: VercelScope, warnings: string[]): ExternalApp | null {
  const name = str(p.name)
  if (name === null || str(p.id) === null) return null
  const host = productionDomains(p)[0] ?? `${name}.vercel.app`
  const prod = p.targets?.production ?? null
  const createdAt = typeof prod?.createdAt === 'number' ? prod.createdAt : null
  return {
    id: externalAppId(host),
    name,
    host,
    platform: 'Vercel',
    description: null,
    repo: projectRepo(p),
    state: p.paused === true ? 'unknown' : vercelState(prod?.readyState),
    deployed:
      createdAt === null
        ? null
        : { at: new Date(createdAt).toISOString(), sha: str(prod?.meta?.githubCommitSha) },
    warnings: p.paused === true ? ['paused', ...warnings] : warnings,
    dashboardUrl: `https://vercel.com/${scope.slug}/${name}`,
  }
}

type ProjectDomain = { name?: unknown; verified?: unknown; redirect?: unknown }
type DomainConfig = { misconfigured?: unknown }

/** Custom production domains not verified, or pointing somewhere else. */
async function domainWarnings(ctx: Ctx, p: Project, scope: VercelScope): Promise<string[]> {
  const id = str(p.id)
  if (id === null) return []
  const r = await vercel<{ domains?: ProjectDomain[] }>(ctx, `/v9/projects/${id}/domains`, scope)
  if (!r.ok) return []
  const out: string[] = []
  const custom = (r.value.domains ?? []).filter((d) => {
    const n = str(d.name)
    return n !== null && !n.endsWith('.vercel.app') && str(d.redirect) === null
  })
  await Promise.all(
    custom.map(async (d) => {
      const n = str(d.name) ?? ''
      if (d.verified === false) out.push(`${n} not verified`)
      const c = await vercel<DomainConfig>(
        ctx,
        `/v6/domains/${encodeURIComponent(n)}/config`,
        scope,
      )
      if (c.ok && c.value.misconfigured === true) out.push(`${n} misconfigured`)
    }),
  )
  return out.sort()
}

const PAGE = '100'
const MAX_PAGES = 5

async function projectsIn(ctx: Ctx, scope: VercelScope): Promise<Got<Project[]>> {
  const out: Project[] = []
  let from: string | null = null
  for (let page = 0; page < MAX_PAGES; page++) {
    const r: Got<{ projects?: Project[]; pagination?: { next?: unknown } }> = await vercel(
      ctx,
      '/v10/projects',
      scope,
      from === null ? { limit: PAGE } : { limit: PAGE, from },
    )
    if (!r.ok) return r
    out.push(...(r.value.projects ?? []))
    const next: unknown = r.value.pagination?.next
    if (next === null || next === undefined) break
    from = String(next)
  }
  return { ok: true, value: out }
}

/** Every project the token can see, and one status per scope. */
export async function discoverVercel(
  ctx: Ctx,
): Promise<{ sites: ExternalApp[]; status: ProviderStatus[] }> {
  if (ctx.secret('VERCEL_API_TOKEN') === '') {
    return {
      sites: [],
      status: [
        {
          platform: 'Vercel',
          account: null,
          state: 'not-configured',
          detail: 'no Vercel token — add one in Settings › Integrations',
        },
      ],
    }
  }
  const who = await vercelScopes(ctx)
  if (!who.ok) {
    return {
      sites: [],
      status: [{ platform: 'Vercel', account: null, state: 'error', detail: who.reason }],
    }
  }
  const seen = new Set<string>()
  const sites: ExternalApp[] = []
  const status: ProviderStatus[] = []
  const answered = await Promise.all(
    who.scopes.map(async (s) => ({ s, r: await projectsIn(ctx, s) })),
  )
  for (const { s, r } of answered) {
    if (!r.ok) {
      // A team-scoped token cannot list the personal scope; that is its
      // scope working, not a failure worth a line.
      if (s.teamId === null && r.reason.status === 403 && who.scopes.length > 1) continue
      status.push({
        platform: 'Vercel',
        account: s.slug,
        state: 'error',
        detail: describeVercelFailure(r.reason),
      })
      continue
    }
    const fresh = r.value.filter((p) => {
      const id = str(p.id)
      if (id === null || seen.has(id)) return false
      seen.add(id)
      return true
    })
    const rows = await Promise.all(
      fresh.map(async (p) => vercelRow(p, s, await domainWarnings(ctx, p, s))),
    )
    for (const row of rows) if (row !== null) sites.push(row)
    status.push({ platform: 'Vercel', account: s.slug, state: 'ok', detail: null })
  }
  return { sites, status }
}

// ── the detail page ────────────────────────────────────────────────────────

type Deployment = {
  created?: unknown
  readyState?: unknown
  state?: unknown
  target?: unknown
  url?: unknown
  inspectorUrl?: unknown
  meta?: { githubCommitSha?: unknown; githubCommitMessage?: unknown } | null
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** Find the project behind a row: the scope whose list holds a project of this name. */
async function locate(ctx: Ctx, name: string): Promise<{ p: Project; scope: VercelScope } | null> {
  const who = await vercelScopes(ctx)
  if (!who.ok) return null
  for (const scope of who.scopes) {
    const r = await vercel<Project>(ctx, `/v9/projects/${encodeURIComponent(name)}`, scope)
    if (r.ok) return { p: r.value, scope }
  }
  return null
}

export async function vercelDetail(
  ctx: Ctx,
  projectName: string,
  now = Date.now(),
): Promise<VercelDetail | null> {
  const found = await locate(ctx, projectName)
  if (found === null) return null
  const { p, scope } = found
  const id = str(p.id) ?? projectName
  const analyticsOn =
    str(p.webAnalytics?.enabledAt) !== null || typeof p.webAnalytics?.enabledAt === 'number'
  const [deps, doms, fw, a7, a30] = await Promise.all([
    vercel<{ deployments?: Deployment[] }>(ctx, '/v6/deployments', scope, {
      projectId: id,
      limit: '10',
    }),
    vercel<{ domains?: ProjectDomain[] }>(ctx, `/v9/projects/${id}/domains`, scope),
    vercel<{
      total?: unknown
      blockingIps?: unknown
      challengingIps?: unknown
      byAction?: unknown
    }>(ctx, '/v1/security/firewall/events/summary', scope, {
      projectId: id,
      startTimestamp: String(now - 86_400_000),
      endTimestamp: String(now),
    }),
    ...[7, 30].map((days) =>
      analyticsOn
        ? vercel<{ data?: { pageviews?: unknown; visitors?: unknown } }>(
            ctx,
            '/v1/query/web-analytics/visits/count',
            scope,
            { projectId: id, since: String(now - days * 86_400_000), until: String(now) },
          )
        : Promise.resolve(null),
    ),
  ])
  const domains: VercelDetail['domains'] = []
  for (const d of doms.ok ? (doms.value.domains ?? []) : []) {
    const name = str(d.name)
    if (name === null) continue
    let misconfigured: boolean | null = null
    if (!name.endsWith('.vercel.app') && str(d.redirect) === null) {
      const c = await vercel<DomainConfig>(
        ctx,
        `/v6/domains/${encodeURIComponent(name)}/config`,
        scope,
      )
      misconfigured = c.ok ? c.value.misconfigured === true : null
    }
    domains.push({ name, verified: d.verified !== false, misconfigured, redirect: str(d.redirect) })
  }
  const analytics: VercelDetail['analytics'] = []
  for (const [days, r] of [
    [7, a7],
    [30, a30],
  ] as const) {
    if (r?.ok)
      analytics.push({
        days,
        pageviews: num(r.value.data?.pageviews),
        visitors: num(r.value.data?.visitors),
      })
  }
  const byAction: Record<string, number> = {}
  if (fw.ok && fw.value.byAction !== null && typeof fw.value.byAction === 'object') {
    for (const [k, v] of Object.entries(fw.value.byAction as Record<string, unknown>))
      byAction[k] = num(v)
  }
  return {
    framework: str(p.framework),
    domains,
    deploys: (deps.ok ? (deps.value.deployments ?? []) : []).map((d) => ({
      at: new Date(num(d.created)).toISOString(),
      state: str(d.readyState) ?? str(d.state) ?? 'UNKNOWN',
      target: str(d.target),
      sha: str(d.meta?.githubCommitSha),
      message: str(d.meta?.githubCommitMessage),
      url: str(d.url) === null ? null : `https://${str(d.url)}`,
      inspectorUrl: str(d.inspectorUrl),
    })),
    analytics: analytics.length === 0 ? null : analytics,
    firewall: fw.ok
      ? {
          total: num(fw.value.total),
          blockingIps: num(fw.value.blockingIps),
          challengingIps: num(fw.value.challengingIps),
          byAction,
        }
      : null,
  }
}
