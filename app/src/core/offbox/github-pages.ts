import type { ExternalApp, PagesDetail, ProviderStatus, SiteState } from '../../lib/external-apps'
import { externalAppId } from '../../lib/external-apps'
import type { Ctx } from '../ctx'
import {
  describeGhFailure,
  ghApp,
  installationState,
  listInstallationRepos,
  otherInstallations,
} from '../github-app'

// GitHub Pages sites, discovered: every repository the App can see — on the
// owner's installation and on every other account or org it is installed on
// — that has Pages turned on, read through `/pages` (the App's `pages: read`).
//
// The repo listing says which repos HAVE Pages (`has_pages`, plain metadata);
// only `/pages` says where a site is served and whether it is up, so an
// installation that has not accepted `pages: read` yet contributes no rows
// and a `needs-permission` status instead of guesses from `homepage`.

/** GitHub's `/repos/{o}/{r}/pages` answer, the fields read here. */
type PagesSite = {
  html_url?: unknown
  cname?: unknown
  status?: unknown
  build_type?: unknown
  https_enforced?: unknown
  https_certificate?: { state?: unknown; expires_at?: unknown } | null
  source?: { branch?: unknown; path?: unknown } | null
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)

/** `/pages`' status → the row's state. GitHub's words: built, building, errored, null. */
export function pagesState(status: unknown): SiteState {
  if (status === 'built') return 'live'
  if (status === 'building') return 'building'
  if (status === 'errored') return 'failed'
  return 'unknown'
}

const DAY_MS = 86_400_000
const CERT_WARN_DAYS = 14

/** What is worth a look about a Pages site. Certificate states per GitHub's docs. */
export function pagesWarnings(site: PagesSite, now = Date.now()): string[] {
  const out: string[] = []
  const cname = str(site.cname)
  if (cname !== null && site.https_enforced !== true) out.push('HTTPS not enforced')
  const cert = site.https_certificate
  const state = str(cert?.state)
  if (cert && (state === 'errored' || state === 'bad_authz' || state === 'dns_changed')) {
    out.push(`certificate ${state.replace('_', ' ')}`)
  }
  const expires = Date.parse(str(cert?.expires_at) ?? '')
  if (Number.isFinite(expires)) {
    const days = Math.floor((expires - now) / DAY_MS)
    if (days < 0) out.push('certificate expired')
    else if (days < CERT_WARN_DAYS) out.push(`certificate expires in ${String(days)} d`)
  }
  return out
}

/** One repo's Pages site as a row; null when GitHub says it has none after all. */
export function pagesRow(
  repo: { fullName: string; name: string; description: string | null },
  site: PagesSite,
  deployed: ExternalApp['deployed'],
  /** The last publish's own word, for a site whose `/pages` status is null. */
  published: SiteState | null,
  now = Date.now(),
): ExternalApp | null {
  const htmlUrl = str(site.html_url)
  let host = str(site.cname)?.toLowerCase() ?? null
  if (host === null && htmlUrl !== null) {
    try {
      host = new URL(htmlUrl).host
    } catch {
      host = null
    }
  }
  if (host === null) return null
  return {
    id: externalAppId(host),
    name: repo.name,
    host,
    platform: 'GitHub Pages',
    description: repo.description,
    repo: repo.fullName,
    state:
      site.status === null || site.status === undefined
        ? (published ?? 'unknown')
        : pagesState(site.status),
    deployed,
    warnings: pagesWarnings(site, now),
    dashboardUrl: `https://github.com/${repo.fullName}/settings/pages`,
  }
}

type Installation = { as: number | null; account: string; missing: string[] }

/** The owner's installation, then every other one with a usable token. */
async function installations(
  ctx: Ctx,
): Promise<{ list: Installation[]; status: ProviderStatus[] }> {
  const [owner, others] = await Promise.all([installationState(ctx), otherInstallations(ctx)])
  const list: Installation[] = []
  const status: ProviderStatus[] = []
  const o = owner.data
  if (owner.available && o.state === 'ok') {
    list.push({ as: null, account: o.account?.login ?? 'owner', missing: o.missingPermissions })
  } else {
    status.push({
      platform: 'GitHub Pages',
      account: o.account?.login ?? null,
      state: o.state === 'not-installed' ? 'not-configured' : 'error',
      detail: o.reason ?? 'the GitHub App has no usable installation token',
    })
  }
  for (const i of others.data) {
    const account = i.account?.login ?? String(i.installationId)
    if (i.state === 'ok' && i.installationId !== null) {
      list.push({ as: i.installationId, account, missing: i.missingPermissions })
    } else if (i.state === 'untrusted') {
      // Someone installed the App and the operator has not said yes: no
      // token, no rows, and the place to say yes.
      status.push({
        platform: 'GitHub Pages',
        account,
        state: 'needs-permission',
        detail: 'installed the App but is not trusted yet',
      })
    } else {
      status.push({
        platform: 'GitHub Pages',
        account,
        state: 'error',
        detail: i.reason ?? 'no usable token for this installation',
      })
    }
  }
  return { list, status }
}

/** A deployment status's word → the row's state (GitHub's states for deployment statuses). */
export function deploymentState(state: unknown): SiteState {
  if (state === 'success') return 'live'
  if (state === 'in_progress' || state === 'queued' || state === 'pending') return 'building'
  if (state === 'failure' || state === 'error') return 'failed'
  return 'unknown'
}

type Publish = { deployed: ExternalApp['deployed']; state: SiteState | null }

/**
 * The last publish and how it went. A workflow-built site has no `/pages`
 * status at all (GitHub answers null), so its state is its latest
 * `github-pages` deployment's latest status; a branch-built one has its
 * last build.
 */
async function lastPublish(
  ctx: Ctx,
  fullName: string,
  buildType: unknown,
  as: number | null,
): Promise<Publish> {
  if (buildType === 'workflow') {
    const r = await ghApp<{ id?: unknown; sha?: unknown; created_at?: unknown }[]>(
      ctx,
      `/repos/${fullName}/deployments?environment=github-pages&per_page=1`,
      {},
      as,
    )
    const d = r.status === 200 && Array.isArray(r.body) ? r.body[0] : undefined
    const at = str(d?.created_at)
    if (at === null || typeof d?.id !== 'number') return { deployed: null, state: null }
    const s = await ghApp<{ state?: unknown }[]>(
      ctx,
      `/repos/${fullName}/deployments/${String(d.id)}/statuses?per_page=1`,
      {},
      as,
    )
    const latest = s.status === 200 && Array.isArray(s.body) ? s.body[0] : undefined
    return {
      deployed: { at, sha: str(d.sha) },
      state: latest === undefined ? null : deploymentState(latest.state),
    }
  }
  const r = await ghApp<{ status?: unknown; commit?: unknown; created_at?: unknown }>(
    ctx,
    `/repos/${fullName}/pages/builds/latest`,
    {},
    as,
  )
  const at = r.status === 200 ? str(r.body?.created_at) : null
  return at === null
    ? { deployed: null, state: null }
    : { deployed: { at, sha: str(r.body?.commit) }, state: pagesState(r.body?.status) }
}

const SLUG = /^[\w.-]+\/[\w.-]+$/

/** Every Pages site the App can see, and one status per account it could not read. */
export async function discoverPages(
  ctx: Ctx,
): Promise<{ sites: ExternalApp[]; status: ProviderStatus[] }> {
  const { list, status } = await installations(ctx)
  const sites: ExternalApp[] = []
  await Promise.all(
    list.map(async (inst) => {
      if (inst.missing.includes('pages')) {
        status.push({
          platform: 'GitHub Pages',
          account: inst.account,
          state: 'needs-permission',
          detail: 'Pages: read is not accepted on this installation yet',
        })
        return
      }
      const repos = await listInstallationRepos(ctx, inst.as)
      if (!repos.ok) {
        status.push({
          platform: 'GitHub Pages',
          account: inst.account,
          state: 'error',
          detail: repos.reason,
        })
        return
      }
      const withPages = repos.repos.filter(
        (r) => r.hasPages && !r.archived && SLUG.test(r.fullName),
      )
      const rows = await Promise.all(
        withPages.map(async (repo) => {
          const r = await ghApp<PagesSite>(ctx, `/repos/${repo.fullName}/pages`, {}, inst.as)
          if (r.status !== 200 || r.body === null) {
            if (r.status !== 404) {
              status.push({
                platform: 'GitHub Pages',
                account: inst.account,
                state: 'error',
                detail: `${repo.fullName}: ${describeGhFailure(r)}`,
              })
            }
            return null
          }
          const published = await lastPublish(ctx, repo.fullName, r.body.build_type, inst.as)
          return pagesRow(repo, r.body, published.deployed, published.state)
        }),
      )
      for (const row of rows) if (row !== null) sites.push(row)
      status.push({ platform: 'GitHub Pages', account: inst.account, state: 'ok', detail: null })
    }),
  )
  return { sites, status }
}

/** Where to find a repo among the installations: the one whose token can read it. */
async function installationFor(ctx: Ctx, fullName: string): Promise<number | null | undefined> {
  const { list } = await installations(ctx)
  const owner = fullName.split('/')[0]?.toLowerCase()
  return list.find((i) => i.account.toLowerCase() === owner)?.as
}

/** The detail page's read of one Pages site: source, HTTPS and the last few publishes. */
export async function pagesDetail(ctx: Ctx, fullName: string): Promise<PagesDetail | null> {
  if (!SLUG.test(fullName)) return null
  const as = await installationFor(ctx, fullName)
  if (as === undefined) return null
  const r = await ghApp<PagesSite>(ctx, `/repos/${fullName}/pages`, {}, as)
  if (r.status !== 200 || r.body === null) return null
  const site = r.body
  const buildType =
    site.build_type === 'legacy' || site.build_type === 'workflow' ? site.build_type : null
  const branch = str(site.source?.branch)
  const deploys: PagesDetail['deploys'] = []
  if (buildType === 'workflow') {
    const d = await ghApp<
      { id?: unknown; sha?: unknown; created_at?: unknown; statuses_url?: unknown }[]
    >(ctx, `/repos/${fullName}/deployments?environment=github-pages&per_page=8`, {}, as)
    for (const x of d.status === 200 && Array.isArray(d.body) ? d.body : []) {
      const at = str(x.created_at)
      if (at === null) continue
      deploys.push({ at, sha: str(x.sha), state: 'deployed', url: null })
    }
  } else {
    const b = await ghApp<
      { status?: unknown; commit?: unknown; created_at?: unknown; url?: unknown }[]
    >(ctx, `/repos/${fullName}/pages/builds?per_page=8`, {}, as)
    for (const x of b.status === 200 && Array.isArray(b.body) ? b.body : []) {
      const at = str(x.created_at)
      if (at === null) continue
      deploys.push({ at, sha: str(x.commit), state: str(x.status) ?? 'unknown', url: null })
    }
  }
  return {
    buildType,
    source: branch === null ? null : { branch, path: str(site.source?.path) ?? '/' },
    httpsEnforced: site.https_enforced === true,
    certificate:
      site.https_certificate && str(site.https_certificate.state) !== null
        ? {
            state: str(site.https_certificate.state) ?? '',
            expiresAt: str(site.https_certificate.expires_at),
          }
        : null,
    deploys,
  }
}
