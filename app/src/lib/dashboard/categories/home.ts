// The Home category: the household's own things — a tab per subject.
//
// It was one page of eight tiles, and the two biggest data stores on this box
// (the photo library and the file sync) each got four numbers and a link. A
// tile could not hold what every other category now answers about a service:
// what version is running, whether that is current, and what the service
// itself says is wrong.
//
// ── the rule on the tab row ────────────────────────────────────────────────
//
// Left of it: things the whole house shares — the automation, the photos, the
// files, the pantry, and the directory of who can open any of them. Right of
// it: applications that merely live here, used by one person. The split is
// about WHOSE data it is, which is the only axis on which Wealthfolio and
// Nextcloud differ; every other reading of "home" puts them in the same box.
//
// ── Pocket ID is here, not in a category of its own ────────────────────────
//
// It had one, back when it was the second half of the proxy's page and the
// argument was that an IdP is not networking. That argument was about traefik.
// Beside the rest of the household it is plainly one of these: the list of
// people, and of what each of them can open. Its loader lives in ../idp
// because the proxy's routing table still borrows the client list.

import { getJson } from '../../http'
import { key } from '../../keys'
import { promScalars } from '../../prom'
import { type VersionGap, versionGap } from '../github'
import { imageVersion, type RunningVersion } from '../images'
import { type IdpData, idpClients, loadIdp } from './idp'

type Ctx = { base: (app: string) => string; hc: string }

export type HomeData =
  | ({ tab: 'house' } & HouseData)
  | ({ tab: 'photos' } & PhotosData)
  | ({ tab: 'files' } & FilesData)
  | ({ tab: 'pantry' } & PantryData)
  | ({ tab: 'signin' } & IdpData)
  | ({ tab: 'projects' } & ProjectsData)
  | ({ tab: 'finance' } & FinanceData)
  | ({ tab: 'tools' } & ToolsData)

export async function loadHome(tab: string, ctx: Ctx): Promise<HomeData> {
  switch (tab) {
    case 'photos':
      return { tab: 'photos', ...(await loadPhotos(ctx)) }
    case 'files':
      return { tab: 'files', ...(await loadFiles(ctx)) }
    case 'pantry':
      return { tab: 'pantry', ...(await loadPantry(ctx)) }
    case 'signin': {
      const base = ctx.base('pocket-id')
      return { tab: 'signin', ...(await loadIdp(base, idpClients(base))) }
    }
    case 'projects':
      return { tab: 'projects', ...(await loadProjects(ctx)) }
    case 'finance':
      return { tab: 'finance', ...(await loadFinance()) }
    case 'tools':
      return { tab: 'tools', ...(await loadTools(ctx)) }
    default:
      return { tab: 'house', ...(await loadHouse(ctx)) }
  }
}

/* ── House: Home Assistant ────────────────────────────────────────────── */

/**
 * Home Assistant, read in two calls.
 *
 * `/api/states` returns every entity in one response, which is both the
 * cheapest way to get a dozen different numbers and the only way to get the
 * ones nobody exposes individually — how many lights are on, who is home,
 * which sensors have stopped answering. `/api/config` adds the version and the
 * loaded integrations, neither of which appears in the state machine.
 *
 * The version comes from the API rather than the image tag, and that is the
 * better source here: it is what the running process reports about itself,
 * where a tag is only what was asked for.
 */
type HouseData = {
  version: string | null
  gap: VersionGap
  reachable: boolean
  place: {
    name: string | null
    country: string | null
    timeZone: string | null
    /** `RUNNING`, or whatever it says while it is still starting. */
    state: string | null
  }
  /** Distinct integrations loaded, not the sub-platform rows under them. */
  integrations: number | null
  people: { name: string; home: boolean }[]
  lightsOn: number
  lightsTotal: number
  switchesOn: number
  entities: number
  automations: { total: number; on: number }
  unavailable: number
  /**
   * Which domains the dead entities are in.
   *
   * A bare count was the old answer and it cannot be acted on: 25 Tuya bulbs
   * have been unavailable since they lost their WiFi pairing, so the number is
   * never zero and never will be until somebody re-pairs them. Split by domain
   * it says whether the set has grown somewhere NEW, which is the only reading
   * of that number worth having.
   */
  unavailableBy: { label: string; value: number }[]
  domains: { label: string; value: number }[]
  temperatures: { label: string; value: number }[]
}

type HassState = { entity_id: string; state: string; attributes?: Record<string, unknown> }

async function loadHouse(ctx: Ctx): Promise<HouseData> {
  const h = { headers: { Authorization: `Bearer ${key('HASS_API_KEY')}` } }

  const [states, config] = await Promise.all([
    getJson<HassState[]>(`${ctx.hc}:8123/api/states`, h),
    getJson<{
      version?: string
      location_name?: string
      country?: string
      time_zone?: string
      state?: string
      components?: string[]
    }>(`${ctx.hc}:8123/api/config`, h),
  ])

  const version = config?.version ?? null

  return {
    version,
    // Calendar-versioned (`2026.7.4`), so the default three-segment tag
    // pattern matches and the comparison is ordinary.
    gap: await versionGap('home-assistant/core', version),
    ...summariseStates(states),
    place: {
      name: config?.location_name ?? null,
      country: config?.country ?? null,
      timeZone: config?.time_zone ?? null,
      state: config?.state ?? null,
    },
    // `components` lists both integrations and their platforms — `tuya` and
    // `tuya.button` are one integration, and counting rows would treble it.
    integrations:
      config?.components === undefined
        ? null
        : new Set(config.components.map((c) => c.split('.')[0])).size,
  }
}

const NO_HOUSE = {
  reachable: false,
  people: [] as { name: string; home: boolean }[],
  lightsOn: 0,
  lightsTotal: 0,
  switchesOn: 0,
  entities: 0,
  automations: { total: 0, on: 0 },
  unavailable: 0,
  unavailableBy: [] as { label: string; value: number }[],
  domains: [] as { label: string; value: number }[],
  temperatures: [] as { label: string; value: number }[],
}

function summariseStates(states: HassState[] | null): typeof NO_HOUSE {
  if (states === null) return NO_HOUSE

  const domainOf = (id: string) => id.split('.')[0] ?? '?'
  const inDomain = (d: string) => states.filter((s) => domainOf(s.entity_id) === d)
  const attr = (s: HassState, k: string) => s.attributes?.[k]
  const nameOf = (s: HassState) => {
    const friendly = attr(s, 'friendly_name')
    return typeof friendly === 'string' ? friendly : (s.entity_id.split('.')[1] ?? s.entity_id)
  }

  const tally = (rows: HassState[]) => {
    const m = new Map<string, number>()
    for (const s of rows) m.set(domainOf(s.entity_id), (m.get(domainOf(s.entity_id)) ?? 0) + 1)
    return [...m].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value)
  }

  const lights = inDomain('light')
  const automations = inDomain('automation')
  const dead = states.filter((s) => s.state === 'unavailable' || s.state === 'unknown')

  return {
    reachable: true,
    people: inDomain('person').map((s) => ({ name: nameOf(s), home: s.state === 'home' })),
    lightsOn: lights.filter((s) => s.state === 'on').length,
    lightsTotal: lights.length,
    switchesOn: inDomain('switch').filter((s) => s.state === 'on').length,
    entities: states.length,
    automations: {
      total: automations.length,
      on: automations.filter((s) => s.state === 'on').length,
    },
    unavailable: dead.length,
    unavailableBy: tally(dead).slice(0, 6),
    domains: tally(states).slice(0, 8),
    temperatures: states
      .filter(
        (s) =>
          attr(s, 'device_class') === 'temperature' &&
          Number.isFinite(Number(s.state)) &&
          s.state !== 'unavailable',
      )
      .map((s) => ({ label: nameOf(s), value: Number(s.state) }))
      .slice(0, 6),
  }
}

/* ── Photos: Immich ───────────────────────────────────────────────────── */

type PhotosData = {
  version: string | null
  gap: VersionGap
  photos: number | null
  videos: number | null
  usageBytes: number | null
  usagePhotos: number | null
  usageVideos: number | null
  users: {
    name: string
    photos: number
    videos: number
    usageBytes: number
    quotaBytes: number | null
  }[]
  /** The dataset Immich's library sits on. */
  disk: { usedBytes: number | null; freeBytes: number | null }
}

type ImmichUser = {
  userName?: string
  photos?: number
  videos?: number
  usage?: number
  quotaSizeInBytes?: number | null
}

async function loadPhotos(ctx: Ctx): Promise<PhotosData> {
  const h = { headers: { 'x-api-key': key('IMMICH_API_KEY') } }
  const base = ctx.base('immich')

  const [stats, ver, disk] = await Promise.all([
    getJson<{
      photos?: number
      videos?: number
      usage?: number
      usagePhotos?: number
      usageVideos?: number
      usageByUser?: ImmichUser[]
    }>(`${base}/api/server/statistics`, h),
    getJson<{ major?: number; minor?: number; patch?: number }>(`${base}/api/server/version`, h),
    // Immich's own /api/server/storage needs the `server.storage` permission
    // this key does not carry. The dataset underneath it is the same disk and
    // node_exporter already reports it, so the denominator is real rather
    // than invented.
    promScalars({
      size: 'node_filesystem_size_bytes{mountpoint="/s2/immich"}',
      avail: 'node_filesystem_avail_bytes{mountpoint="/s2/immich"}',
    }),
  ])

  const version =
    ver?.major === undefined
      ? null
      : `${String(ver.major)}.${String(ver.minor ?? 0)}.${String(ver.patch ?? 0)}`

  return {
    version,
    gap: await versionGap('immich-app/immich', version),
    photos: stats?.photos ?? null,
    videos: stats?.videos ?? null,
    usageBytes: stats?.usage ?? null,
    usagePhotos: stats?.usagePhotos ?? null,
    usageVideos: stats?.usageVideos ?? null,
    users: (stats?.usageByUser ?? []).map((u) => ({
      name: u.userName ?? '?',
      photos: u.photos ?? 0,
      videos: u.videos ?? 0,
      usageBytes: u.usage ?? 0,
      // Zero means "no quota" in Immich's API, which is a different claim
      // from a quota of nothing.
      quotaBytes:
        u.quotaSizeInBytes === null || u.quotaSizeInBytes === undefined || u.quotaSizeInBytes === 0
          ? null
          : u.quotaSizeInBytes,
    })),
    disk: {
      usedBytes: disk.size !== null && disk.avail !== null ? disk.size - disk.avail : null,
      freeBytes: disk.avail,
    },
  }
}

/* ── Files: Nextcloud ─────────────────────────────────────────────────── */

/**
 * Nextcloud's serverinfo app, which answers nearly everything in one call.
 *
 * The share breakdown is the part worth having and the tile had no room for:
 * a link share with no password is a URL that opens the file for anyone
 * holding it, and the count of those is a real fact about this box rather
 * than a statistic.
 */
type FilesData = {
  version: string | null
  gap: VersionGap
  freeBytes: number | null
  numFiles: number | null
  storages: number | null
  users: { total: number | null; disabled: number | null }
  shares: {
    total: number | null
    link: number | null
    linkNoPassword: number | null
    user: number | null
    group: number | null
    mail: number | null
  }
  active: { m5: number | null; h1: number | null; d1: number | null; d7: number | null }
  db: { type: string | null; version: string | null; sizeBytes: number | null }
  php: { version: string | null; opcacheHitRate: number | null }
  /** What it is using for distributed caching and locking. */
  cache: string | null
}

async function loadFiles(ctx: Ctx): Promise<FilesData> {
  const body = await getJson<{
    ocs?: {
      data?: {
        nextcloud?: {
          system?: {
            version?: string
            freespace?: number
            'memcache.distributed'?: string
          }
          storage?: {
            num_users?: number
            num_disabled_users?: number
            num_files?: number
            num_storages?: number
          }
          shares?: {
            num_shares?: number
            num_shares_link?: number
            num_shares_link_no_password?: number
            num_shares_user?: number
            num_shares_groups?: number
            num_shares_mail?: number
          }
        }
        server?: {
          php?: {
            version?: string
            opcache?: { opcache_statistics?: { opcache_hit_rate?: number } }
          }
          database?: { type?: string; version?: string; size?: string | number }
        }
        activeUsers?: {
          last5minutes?: number
          last1hour?: number
          last24hours?: number
          last7days?: number
        }
      }
    }
  }>(`${ctx.base('nextcloud')}/ocs/v2.php/apps/serverinfo/api/v1/info?format=json`, {
    headers: { 'NC-Token': key('NEXTCLOUD_KEY'), 'OCS-APIRequest': 'true' },
  })

  const d = body?.ocs?.data
  const nc = d?.nextcloud
  const version = nc?.system?.version ?? null
  // Nextcloud reports four segments (`34.0.2.1`); GitHub tags three (`v34.0.2`).
  // The comparison walks segment by segment, so the extra one is a tiebreak
  // rather than a mismatch.
  const size = d?.server?.database?.size
  const dbSize = size === undefined ? null : Number(size)

  return {
    version,
    gap: await versionGap('nextcloud/server', version),
    freeBytes: nc?.system?.freespace ?? null,
    numFiles: nc?.storage?.num_files ?? null,
    storages: nc?.storage?.num_storages ?? null,
    users: {
      total: nc?.storage?.num_users ?? null,
      disabled: nc?.storage?.num_disabled_users ?? null,
    },
    shares: {
      total: nc?.shares?.num_shares ?? null,
      link: nc?.shares?.num_shares_link ?? null,
      linkNoPassword: nc?.shares?.num_shares_link_no_password ?? null,
      user: nc?.shares?.num_shares_user ?? null,
      group: nc?.shares?.num_shares_groups ?? null,
      mail: nc?.shares?.num_shares_mail ?? null,
    },
    active: {
      m5: d?.activeUsers?.last5minutes ?? null,
      h1: d?.activeUsers?.last1hour ?? null,
      d1: d?.activeUsers?.last24hours ?? null,
      d7: d?.activeUsers?.last7days ?? null,
    },
    db: {
      type: d?.server?.database?.type ?? null,
      // "PostgreSQL 18.4 on x86_64-pc-linux-musl, compiled by …" — the first
      // two words are the answer and the rest is a build banner.
      version: (d?.server?.database?.version ?? '').split(' ').slice(0, 2).join(' ') || null,
      sizeBytes: dbSize === null || Number.isNaN(dbSize) ? null : dbSize,
    },
    php: {
      version: d?.server?.php?.version ?? null,
      opcacheHitRate: d?.server?.php?.opcache?.opcache_statistics?.opcache_hit_rate ?? null,
    },
    cache: nc?.system?.['memcache.distributed'] ?? null,
  }
}

/* ── Pantry: Grocy ────────────────────────────────────────────────────── */

type PantryData = {
  version: string | null
  releaseDate: string | null
  gap: VersionGap
  missing: number | null
  due: number | null
  overdue: number | null
  expired: number | null
  /** Distinct products with stock on hand. */
  inStock: number | null
  chores: { total: number | null; overdue: number | null }
  tasks: { total: number | null; overdue: number | null }
}

async function loadPantry(ctx: Ctx): Promise<PantryData> {
  const h = { headers: { 'GROCY-API-KEY': key('GROCY_API_KEY') } }
  const base = ctx.base('grocy')
  const today = new Date().toISOString().slice(0, 10)

  const [volatile, info, stock, chores, tasks] = await Promise.all([
    getJson<{
      missing_products?: unknown[]
      due_products?: unknown[]
      overdue_products?: unknown[]
      expired_products?: unknown[]
    }>(`${base}/api/stock/volatile?days=3`, h),
    getJson<{ grocy_version?: { Version?: string; ReleaseDate?: string } }>(
      `${base}/api/system/info`,
      h,
    ),
    getJson<unknown[]>(`${base}/api/stock`, h),
    getJson<{ next_estimated_execution_time?: string }[]>(`${base}/api/chores`, h),
    getJson<{ due_date?: string; done?: number }[]>(`${base}/api/tasks`, h),
  ])

  const overdueBy = <T>(rows: T[] | null, at: (r: T) => string | undefined) =>
    rows === null ? null : rows.filter((r) => (at(r) ?? '') !== '' && (at(r) ?? '') < today).length

  return {
    version: info?.grocy_version?.Version ?? null,
    releaseDate: info?.grocy_version?.ReleaseDate ?? null,
    gap: await versionGap('grocy/grocy', info?.grocy_version?.Version ?? null),
    missing: volatile?.missing_products?.length ?? null,
    due: volatile?.due_products?.length ?? null,
    overdue: volatile?.overdue_products?.length ?? null,
    expired: volatile?.expired_products?.length ?? null,
    inStock: stock?.length ?? null,
    chores: {
      total: chores?.length ?? null,
      overdue: overdueBy(chores, (c) => c.next_estimated_execution_time?.slice(0, 10)),
    },
    tasks: {
      total: tasks === null ? null : tasks.filter((t) => t.done !== 1).length,
      overdue: overdueBy(tasks, (t) => t.due_date?.slice(0, 10)),
    },
  }
}

/* ── Projects: Plane ──────────────────────────────────────────────────── */

/**
 * Plane, read from two APIs with different rules.
 *
 * `/api/instances/` is the instance's own description of itself — version,
 * edition, and which sign-in methods are switched on — and it needs no
 * credential at all. Everything INSIDE a workspace needs a token generated
 * from Plane's own settings, and that token is scoped to one workspace: the
 * public API publishes no endpoint that lists them (`/api/v1/workspaces/` is a
 * 404), so the slug travels beside the key rather than being derived from it.
 *
 * Community edition has no OIDC, which is why this one app on the box is not
 * behind the Pocket ID gate — `is_email_password_enabled` below is that
 * decision, read back rather than restated.
 */

/** How many work items are read per project to tally the state breakdown. */
const ISSUES_SCANNED = 100

type PlaneProject = {
  id: string
  name: string
  /** The prefix on every work item's key — `VOYRA-7`. */
  identifier: string | null
  members: number | null
  /** Work items per state GROUP, in board order. */
  states: { label: string; value: number }[]
  items: number | null
  /**
   * How many were actually read, when that is fewer than `items`.
   *
   * Null when the scan covered everything, so the caption appears only where
   * it is true. Carried rather than restated in the view: a second copy of
   * the cap is how a page comes to claim a sample size it did not take.
   */
  scanned: number | null
  cycles: {
    name: string
    startDate: string | null
    endDate: string | null
    total: number
    completed: number
    started: number
    /** Running now, by its own dates. */
    current: boolean
  }[]
  modules: number | null
}

type ProjectsData = {
  version: string | null
  latest: string | null
  gap: VersionGap
  instanceName: string | null
  edition: string | null
  signIn: { signup: boolean | null; magicLink: boolean | null; emailPassword: boolean | null }
  smtp: boolean | null
  /** Null when there is no token, which is a different state from none found. */
  workspace: { slug: string; projects: PlaneProject[] } | null
}

/**
 * Plane's five state groups, in the order its own board shows them.
 *
 * Groups rather than states: the names are per-project and renameable, the
 * groups are Plane's own fixed vocabulary, so counting by group is the one
 * tally that survives somebody renaming "Todo".
 */
const STATE_GROUPS = ['backlog', 'unstarted', 'started', 'completed', 'cancelled'] as const

async function loadProjects(ctx: Ctx): Promise<ProjectsData> {
  const base = ctx.base('plane')

  const [body, workspace] = await Promise.all([
    getJson<{
      config?: {
        enable_signup?: boolean
        is_magic_login_enabled?: boolean
        is_email_password_enabled?: boolean
        is_smtp_configured?: boolean
      }
      instance?: {
        instance_name?: string
        current_version?: string
        latest_version?: string
        edition?: string
      }
    }>(`${base}/api/instances/`),
    loadWorkspace(base),
  ])

  // Plane reports its own `latest_version` too, but it phones home to do it —
  // the same GitHub comparison every other tab makes is both consistent and
  // independent of whether this box is allowed to reach Plane's servers.
  const version = (body?.instance?.current_version ?? '').replace(/^v/, '') || null

  return {
    version,
    latest: body?.instance?.latest_version ?? null,
    gap: await versionGap('makeplane/plane', version),
    instanceName: body?.instance?.instance_name ?? null,
    edition: body?.instance?.edition ?? null,
    signIn: {
      signup: body?.config?.enable_signup ?? null,
      magicLink: body?.config?.is_magic_login_enabled ?? null,
      emailPassword: body?.config?.is_email_password_enabled ?? null,
    },
    smtp: body?.config?.is_smtp_configured ?? null,
    workspace,
  }
}

async function loadWorkspace(base: string): Promise<ProjectsData['workspace']> {
  const token = key('PLANE_KEY')
  const slug = key('PLANE_WORKSPACE')
  if (token === '' || slug === '') return null

  const h = { headers: { 'X-API-Key': token } }
  const ws = `${base}/api/v1/workspaces/${slug}`

  const list = await getJson<{
    results?: {
      id?: string
      name?: string
      identifier?: string
      total_members?: number
      total_modules?: number
    }[]
  }>(`${ws}/projects/`, h)
  if (list === null) return null

  const projects = await Promise.all(
    (list.results ?? []).map(async (p): Promise<PlaneProject> => {
      const id = p.id ?? ''
      const [states, issues, cycles] = await Promise.all([
        getJson<
          { id?: string; group?: string }[] | { results?: { id?: string; group?: string }[] }
        >(`${ws}/projects/${id}/states/`, h),
        getJson<{ total_count?: number; results?: { state?: string }[] }>(
          `${ws}/projects/${id}/issues/?per_page=${String(ISSUES_SCANNED)}`,
          h,
        ),
        getJson<{ results?: PlaneCycle[] } | PlaneCycle[]>(`${ws}/projects/${id}/cycles/`, h),
      ])

      // Both endpoints answer either bare or paginated depending on the
      // release; unwrapping here keeps that out of every call site.
      const stateRows = Array.isArray(states) ? states : (states?.results ?? [])
      const groupOf = new Map(stateRows.map((s) => [s.id ?? '', s.group ?? '']))

      const tally = new Map<string, number>()
      for (const i of issues?.results ?? []) {
        const g = groupOf.get(i.state ?? '') ?? 'unstarted'
        tally.set(g, (tally.get(g) ?? 0) + 1)
      }

      const cycleRows = Array.isArray(cycles) ? cycles : (cycles?.results ?? [])
      const now = Date.now()

      return {
        id,
        name: p.name ?? '?',
        identifier: p.identifier ?? null,
        members: p.total_members ?? null,
        modules: p.total_modules ?? null,
        items: issues?.total_count ?? null,
        scanned: (issues?.total_count ?? 0) > ISSUES_SCANNED ? ISSUES_SCANNED : null,
        // Every group, including the empty ones — a board with nothing in
        // progress says that by having a zero there, not by omitting the row.
        states: STATE_GROUPS.map((g) => ({ label: g, value: tally.get(g) ?? 0 })),
        cycles: cycleRows
          .map((c) => {
            const start = Date.parse(c.start_date ?? '')
            const end = Date.parse(c.end_date ?? '')
            return {
              name: c.name ?? '?',
              startDate: c.start_date?.slice(0, 10) ?? null,
              endDate: c.end_date?.slice(0, 10) ?? null,
              total: c.total_issues ?? 0,
              completed: c.completed_issues ?? 0,
              started: c.started_issues ?? 0,
              current: Number.isFinite(start) && Number.isFinite(end) && now >= start && now <= end,
              sortAt: Number.isFinite(start) ? start : 0,
            }
          })
          .sort((a, b) => a.sortAt - b.sortAt)
          .map(({ sortAt: _sortAt, ...c }) => c),
      }
    }),
  )

  return { slug, projects }
}

type PlaneCycle = {
  name?: string
  start_date?: string
  end_date?: string
  total_issues?: number
  completed_issues?: number
  started_issues?: number
}

/* ── Finance: Wealthfolio ─────────────────────────────────────────────── */

/**
 * Wealthfolio, which publishes nothing to read.
 *
 * Every path under its hostname returns the single-page app; the API behind it
 * is session-authenticated, and the session is a browser's. So this tab is the
 * version, the gap and the log — deliberately, rather than by omission. The
 * alternative was to leave it as a tile carrying a name and a link, which is
 * what it had before and which answered nothing.
 */
type FinanceData = { running: RunningVersion; gap: VersionGap }

async function loadFinance(): Promise<FinanceData> {
  const running = await imageVersion('wealthfolio')
  return { running, gap: await versionGap('afadil/wealthfolio', running.version) }
}

/* ── Tools: Stirling-PDF ──────────────────────────────────────────────── */

type ToolsData = {
  version: string | null
  gap: VersionGap
  /** What its own health endpoint says, in its own word. */
  status: string | null
}

async function loadTools(ctx: Ctx): Promise<ToolsData> {
  const body = await getJson<{ version?: string; status?: string }>(
    `${ctx.base('stirling-pdf')}/api/v1/info/status`,
  )
  const version = body?.version ?? null
  return {
    version,
    gap: await versionGap('Stirling-Tools/Stirling-PDF', version),
    status: body?.status ?? null,
  }
}
