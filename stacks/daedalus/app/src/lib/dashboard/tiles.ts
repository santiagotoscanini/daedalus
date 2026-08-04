// The Dashboard tab's tile catalogue.
//
// One entry per box on the old homepage's Home and Infra tabs, carrying the
// same numbers from the same APIs. The Apps tab is deliberately absent: those
// services already have a richer page under /apps, and duplicating them here
// would be two places to look at the same thing.
//
// ── why the catalogue lives in TypeScript ─────────────────────────────────
//
// Homepage's tiles are declared per-stack (`fleet.webApps.<n>.homepage.widget`)
// because homepage is a config-driven widget ENGINE — the stack describes a
// URL and a list of field paths, and the container does the fetching. daedalus
// has no such engine: each of these services shapes its response differently
// enough (a cookie login here, a session id there, a sum over an array
// somewhere else) that "the mapping" is code, not data. Splitting the code
// across 30 stack modules and shipping it as strings would be a worse version
// of what is written plainly here.
//
// What DOES stay declarative is the part that moves: hostnames come from the
// nix manifest (`webAppHosts`), so renaming a webApp moves its tile with it.
// The only literals below are the must-keep host ports (CLAUDE.md's table),
// which are structural and already restated in every stack that owns one.
//
// ── adding a tile ─────────────────────────────────────────────────────────
//
// Add an entry to TILES. `link` names a webApp (resolved through the manifest)
// or gives an absolute URL for something off-box. `gatus` is the endpoint key
// gatus already probes — that is the status dot, so it means "is it actually
// serving", not "is the container running". `load` returns the stats and must
// never throw: use the helpers in ./clients, which return null instead.

import {
  basicAuth,
  getJson,
  lokiScalar,
  piholeSid,
  promScalar,
  promScalars,
  qbtCookie,
} from './clients'
import { DASH, bytes, flag, key, num, rate, text } from './format'

export type Stat = { label: string; value: string }

export type TileDef = {
  key: string
  name: string
  group: GroupName
  description: string
  link: { app: string; path?: string } | { url: string }
  /** gatus endpoint key, minus the `web-apps_` prefix. */
  gatus?: string
  /** Longer free text under the stats — "now playing", the VPN's exit city. */
  load?: (ctx: Ctx) => Promise<{ stats: Stat[]; note?: string }>
}

export type Ctx = {
  /** `https://<hostname>` for a webApp, from the nix manifest. */
  base: (app: string) => string
  /** The host, as containers see it. Where the must-keep host ports live. */
  hc: string
}

export type GroupName =
  | 'AI & Automation'
  | 'Home'
  | 'Media'
  | 'Books'
  | 'Gaming'
  | 'Network'
  | 'Monitoring'

export type CategoryName = 'ai' | 'media' | 'home' | 'network' | 'system' | 'monitoring'

/**
 * Group → the category page it belongs to, and (where the category has
 * sub-tabs) which one.
 *
 * A group with no `tab` shows on every tab of its category. Only Media has
 * sub-tabs today, and its two groups map one-to-one onto them.
 */
export const GROUPS: {
  name: GroupName
  category: CategoryName
  tab?: string
  icon: string
}[] = [
  { name: 'AI & Automation', category: 'ai', icon: '◈' },
  { name: 'Home', category: 'home', icon: '⌂' },
  { name: 'Gaming', category: 'home', icon: '⛶' },
  { name: 'Media', category: 'media', tab: 'tv', icon: '▶' },
  { name: 'Books', category: 'media', tab: 'books', icon: '❏' },
  { name: 'Network', category: 'network', icon: '⇄' },
  { name: 'Monitoring', category: 'monitoring', icon: '◎' },
]

// Value formatting is shared with the category boards — see ./format.
function stat(label: string, value: string): Stat {
  return { label, value }
}

// ── shared shapes ──────────────────────────────────────────────────────────

type GluetunIp = { public_ip?: string; region?: string; country?: string; city?: string }

/** Both gluetun instances read identically; only the control port differs. */
async function gluetunStats(port: number, withPort: boolean) {
  const base = `http://host.containers.internal:${String(port)}`
  const [ip, fw] = await Promise.all([
    getJson<GluetunIp>(`${base}/v1/publicip/ip`),
    // /v1/portforward, not the /v1/openvpn/portforwarded homepage's tiles use:
    // that path is a 301 now, and `redirect: 'manual'` (correctly) does not
    // chase redirects, so following homepage here would silently read nothing.
    withPort ? getJson<{ port?: number }>(`${base}/v1/portforward`) : null,
  ])
  const stats = [
    stat('Public IP', text(ip?.public_ip)),
    stat('Region', text(ip?.region)),
    stat('Country', flag(ip?.country)),
  ]
  // The forwarded port is the signal that torrents can actually seed — a
  // tunnel that is up but lost its port forward looks healthy and is not.
  if (withPort) stats.push(stat('Fwd port', fw?.port ? String(fw.port) : DASH))
  return { stats, note: ip?.city ? `Exit: ${ip.city}` : undefined }
}

// ── the catalogue ──────────────────────────────────────────────────────────

export const TILES: TileDef[] = [
  // ══ AI & Automation ══════════════════════════════════════════════════════
  {
    key: 'lemonade',
    name: 'Lemonade',
    group: 'AI & Automation',
    description: 'Local LLM model server on the gaming PC',
    // Off-box (the gaming PC), so there is no webApp and no gatus probe —
    // the URL is injected as LEMONADE_URL by stacks/daedalus/daedalus.nix.
    link: { url: process.env.LEMONADE_URL ?? '' },
    load: async () => {
      const base = process.env.LEMONADE_URL ?? ''
      const [health, stats] = await Promise.all([
        getJson<{
          all_models_loaded?: { model_name?: string; last_use?: number }[]
          model_loaded?: string
          version?: string
        }>(`${base}/api/v1/health`),
        getJson<{
          tokens_per_second?: number
          time_to_first_token?: number
          request_count_total?: number
          output_tokens_total?: number
        }>(`${base}/api/v1/stats`),
      ])
      // The model actually being used, not the first one in the array. Six
      // models sit resident at once here, so `[0]` names whichever Lemonade
      // happened to list first — "Hot" is only a useful word if it means the
      // most recently touched.
      const hot = [...(health?.all_models_loaded ?? [])].sort(
        (a, b) => (b.last_use ?? 0) - (a.last_use ?? 0),
      )[0]
      return {
        stats: [
          stat('Models', num(health?.all_models_loaded?.length)),
          stat('Hot', text(health?.model_loaded ?? hot?.model_name)),
          stat('Tok/s last', num(stats?.tokens_per_second, 1)),
          // Reported in seconds; milliseconds is the unit anyone reads TTFT in.
          stat(
            'TTFT last',
            stats?.time_to_first_token === undefined ?
              DASH
            : `${num(stats.time_to_first_token * 1000)} ms`,
          ),
          stat('Reqs total', num(stats?.request_count_total)),
          stat('Out tok total', num(stats?.output_tokens_total)),
        ],
        note: health?.version ? `v${health.version}` : undefined,
      }
    },
  },
  {
    key: 'litellm',
    name: 'LiteLLM',
    group: 'AI & Automation',
    description: 'OpenAI-compatible LLM gateway',
    link: { app: 'litellm', path: '/ui' },
    gatus: 'litellm',
    load: async () => {
      // Over app-db-net, which daedalus already joins for its own database —
      // the same bridge litellm lives on, so no traefik hop and no key in a URL.
      const h = { headers: { Authorization: `Bearer ${process.env.LITELLM_API_KEY ?? ''}` } }
      const url = (from: string) =>
        `http://litellm:4000/user/daily/activity/aggregated?start_date=${from}&end_date=2030-12-31`
      const today = new Date().toISOString().slice(0, 10)
      type Activity = {
        metadata?: {
          total_api_requests?: number
          total_failed_requests?: number
          total_tokens?: number
        }
      }
      // Two ranges, not one response read twice. Homepage's tile labels
      // `results[0]` "today", but results[0] is the FIRST day in the range —
      // with start_date=2020 that is the oldest day with traffic, not today.
      const [all, day] = await Promise.all([
        getJson<Activity>(url('2020-01-01'), h),
        getJson<Activity>(url(today), h),
      ])
      return {
        stats: [
          stat('Reqs today', num(day?.metadata?.total_api_requests)),
          stat('Failed today', num(day?.metadata?.total_failed_requests)),
          stat('Tokens today', num(day?.metadata?.total_tokens)),
          stat('Reqs all', num(all?.metadata?.total_api_requests)),
          stat('Failed all', num(all?.metadata?.total_failed_requests)),
          stat('Tokens all', num(all?.metadata?.total_tokens)),
        ],
      }
    },
  },
  {
    key: 'n8n',
    name: 'n8n',
    group: 'AI & Automation',
    description: 'Workflow automation',
    link: { app: 'n8n' },
    gatus: 'n8n',
    load: async (ctx) => {
      const h = { headers: { 'X-N8N-API-KEY': key('N8N_API_KEY') } }
      const base = ctx.base('n8n')
      // Workflow NAMES, resolved from the API. Homepage's tile carries a
      // hand-written id→name remap that goes stale the moment a workflow is
      // renamed or added; there is an endpoint for this.
      const [runs, flows] = await Promise.all([
        getJson<{ data?: { workflowId: string; status: string; startedAt: string }[] }>(
          `${base}/api/v1/executions?limit=3`,
          h,
        ),
        getJson<{ data?: { id: string; name: string }[] }>(`${base}/api/v1/workflows`, h),
      ])
      const names = new Map((flows?.data ?? []).map((f) => [f.id, f.name]))
      const list = runs?.data ?? []
      return {
        stats: list.map((e) =>
          stat(names.get(e.workflowId) ?? e.workflowId.slice(0, 8), e.status),
        ),
        note:
          list.length === 0 ? 'No recent executions'
            // An execution record carries only `workflowId`, so names need the
            // /workflows endpoint — which 403s unless the API key was minted
            // with the `workflow:read` scope. Say so, rather than showing
            // opaque ids and letting them look like the intended output.
          : flows === null ? 'Workflow names need an n8n API key with workflow:read'
          : undefined,
      }
    },
  },
  {
    key: 'open-webui',
    name: 'Open WebUI',
    group: 'AI & Automation',
    description: 'Chat with local models',
    link: { app: 'open-webui' },
    gatus: 'open-webui',
    load: async (ctx) => {
      const h = { headers: { Authorization: `Bearer ${key('OPENWEBUI_KEY')}` } }
      const base = ctx.base('open-webui')
      const [usage, ver] = await Promise.all([
        getJson<{ user_count?: number; model_ids?: string[] }>(`${base}/api/usage`, h),
        getJson<{ current?: string; latest?: string }>(`${base}/api/version/updates`, h),
      ])
      return {
        stats: [
          stat('Active 3m', num(usage?.user_count)),
          stat('Generating', num(usage?.model_ids?.length)),
          stat('Version', text(ver?.current)),
          stat('Latest', text(ver?.latest)),
        ],
      }
    },
  },

  // ══ Home ═════════════════════════════════════════════════════════════════
  {
    key: 'pocket-id',
    name: 'Pocket ID',
    group: 'Home',
    description: 'OIDC provider — passkey SSO for all web UIs',
    link: { app: 'pocket-id' },
    gatus: 'pocket-id',
    load: async (ctx) => {
      const h = { headers: { 'X-API-KEY': key('POCKETID_KEY') } }
      const base = ctx.base('pocket-id')
      type Paged = { pagination?: { totalItems?: number } }
      const [clients, users] = await Promise.all([
        getJson<Paged>(`${base}/api/oidc/clients`, h),
        getJson<Paged>(`${base}/api/users`, h),
      ])
      return {
        stats: [
          stat('SSO clients', num(clients?.pagination?.totalItems)),
          stat('Users', num(users?.pagination?.totalItems)),
        ],
      }
    },
  },
  {
    key: 'immich',
    name: 'Immich',
    group: 'Home',
    description: 'Photo + video backup',
    link: { app: 'immich' },
    gatus: 'immich',
    load: async (ctx) => {
      const s = await getJson<{
        photos?: number
        videos?: number
        usage?: number
        usageByUser?: unknown[]
      }>(`${ctx.base('immich')}/api/server/statistics`, {
        headers: { 'x-api-key': key('IMMICH_API_KEY') },
      })
      return {
        stats: [
          stat('Users', num(s?.usageByUser?.length)),
          stat('Photos', num(s?.photos)),
          stat('Videos', num(s?.videos)),
          // Library size, not disk free: /api/server/storage needs the
          // `server.storage` permission this API key does not carry, and an
          // invented denominator would be worse than the real numerator.
          stat('Library', bytes(s?.usage)),
        ],
      }
    },
  },
  {
    key: 'nextcloud',
    name: 'Nextcloud',
    group: 'Home',
    description: 'Files, calendar, contacts — primary household sync',
    link: { app: 'nextcloud' },
    gatus: 'nextcloud',
    load: async (ctx) => {
      const body = await getJson<{
        ocs?: {
          data?: {
            nextcloud?: {
              system?: { freespace?: number }
              storage?: { num_files?: number }
              shares?: { num_shares?: number }
            }
            activeUsers?: { last5minutes?: number }
          }
        }
      }>(`${ctx.base('nextcloud')}/ocs/v2.php/apps/serverinfo/api/v1/info?format=json`, {
        headers: { 'NC-Token': key('NEXTCLOUD_KEY'), 'OCS-APIRequest': 'true' },
      })
      const nc = body?.ocs?.data?.nextcloud
      return {
        stats: [
          stat('Free space', bytes(nc?.system?.freespace)),
          stat('Active users', num(body?.ocs?.data?.activeUsers?.last5minutes)),
          stat('Files', num(nc?.storage?.num_files)),
          stat('Shares', num(nc?.shares?.num_shares)),
        ],
      }
    },
  },
  {
    key: 'home-assistant',
    name: 'Home Assistant',
    group: 'Home',
    description: 'Home automation hub',
    // Host netns (mDNS/SSDP discovery) — :8123 is firewall-closed but reachable
    // from a container as host.containers.internal, which is how homepage
    // dials it too.
    link: { app: 'home-assistant' },
    gatus: 'home-assistant',
    load: async (ctx) => {
      const states = await getJson<{ entity_id: string; state: string }[]>(
        `${ctx.hc}:8123/api/states`,
        { headers: { Authorization: `Bearer ${key('HASS_API_KEY')}` } },
      )
      if (states === null) return { stats: [] }
      const on = (prefix: string, want: string) =>
        states.filter((s) => s.entity_id.startsWith(prefix) && s.state === want).length
      return {
        stats: [
          stat('People home', num(on('person.', 'home'))),
          stat('Lights on', num(on('light.', 'on'))),
          stat('Switches on', num(on('switch.', 'on'))),
          stat('Entities', num(states.length)),
        ],
      }
    },
  },
  {
    key: 'grocy',
    name: 'Grocy',
    group: 'Home',
    description: 'Household inventory & chores',
    link: { app: 'grocy' },
    gatus: 'grocy',
    load: async (ctx) => {
      const v = await getJson<{
        missing_products?: unknown[]
        due_products?: unknown[]
        overdue_products?: unknown[]
        expired_products?: unknown[]
      }>(`${ctx.base('grocy')}/api/stock/volatile?days=3`, {
        headers: { 'GROCY-API-KEY': key('GROCY_API_KEY') },
      })
      return {
        stats: [
          stat('Missing', num(v?.missing_products?.length)),
          stat('Due', num(v?.due_products?.length)),
          stat('Overdue', num(v?.overdue_products?.length)),
          stat('Expired', num(v?.expired_products?.length)),
        ],
      }
    },
  },
  {
    key: 'plane',
    name: 'Plane',
    group: 'Home',
    description: 'Projects, cycles and work items',
    link: { app: 'plane' },
    gatus: 'plane',
    load: async (ctx) => {
      const b = await getJson<{
        instance?: { current_version?: string; latest_version?: string }
      }>(`${ctx.base('plane')}/api/instances/`)
      return {
        stats: [
          stat('Version', text(b?.instance?.current_version)),
          stat('Latest', text(b?.instance?.latest_version)),
        ],
      }
    },
  },
  {
    key: 'wealthfolio',
    name: 'Wealthfolio',
    group: 'Home',
    description: 'Personal finance',
    link: { app: 'wealthfolio', path: '/api/v1/auth/oidc/login' },
    gatus: 'wealthfolio',
  },
  {
    key: 'stirling-pdf',
    name: 'Stirling-PDF',
    group: 'Home',
    description: 'PDF toolbox (split, merge, OCR)',
    link: { app: 'stirling-pdf' },
    gatus: 'stirling-pdf',
    load: async (ctx) => {
      const b = await getJson<{ status?: string; version?: string }>(
        `${ctx.base('stirling-pdf')}/api/v1/info/status`,
      )
      return { stats: [stat('Status', text(b?.status)), stat('Version', text(b?.version))] }
    },
  },

  // ══ Media ════════════════════════════════════════════════════════════════
  {
    key: 'seerr',
    name: 'Seerr',
    group: 'Media',
    description: 'Media requests & discovery',
    link: { app: 'seerr' },
    gatus: 'seerr',
    load: async (ctx) => {
      const c = await getJson<{
        pending?: number
        approved?: number
        available?: number
        processing?: number
      }>(`${ctx.base('seerr')}/api/v1/request/count`, {
        headers: { 'X-Api-Key': key('SEERR_API_KEY') },
      })
      return {
        stats: [
          stat('Pending', num(c?.pending)),
          stat('Approved', num(c?.approved)),
          stat('Available', num(c?.available)),
          stat('Processing', num(c?.processing)),
        ],
      }
    },
  },
  {
    key: 'jellyfin',
    name: 'Jellyfin',
    group: 'Media',
    description: 'Movies, TV, music — household media server',
    link: { app: 'jellyfin' },
    gatus: 'jellyfin',
    load: async (ctx) => {
      const h = { headers: { 'X-Emby-Token': key('JELLYFIN_API_KEY') } }
      const base = ctx.base('jellyfin')
      const [counts, sessions] = await Promise.all([
        getJson<{ MovieCount?: number; SeriesCount?: number; EpisodeCount?: number }>(
          `${base}/Items/Counts`,
          h,
        ),
        getJson<
          {
            UserName?: string
            NowPlayingItem?: { Name?: string; SeriesName?: string }
            PlayState?: { IsPaused?: boolean }
          }[]
        >(`${base}/Sessions`, h),
      ])
      // Only sessions actually playing something. Every poller that has ever
      // asked Jellyfin a question holds an idle session for a while, so
      // `sessions.length` would report an audience that is not there.
      const playing = (sessions ?? []).filter((s) => s.NowPlayingItem !== undefined)
      return {
        stats: [
          stat('Movies', num(counts?.MovieCount)),
          stat('Series', num(counts?.SeriesCount)),
          stat('Episodes', num(counts?.EpisodeCount)),
          stat('Playing', num(playing.length)),
        ],
        note:
          playing.length === 0 ? undefined : (
            playing
              .map((s) => {
                const item = s.NowPlayingItem
                const title =
                  item?.SeriesName === undefined ? item?.Name : `${item.SeriesName} — ${item.Name}`
                return `${s.UserName ?? 'someone'}: ${title ?? 'something'}${
                  s.PlayState?.IsPaused === true ? ' (paused)' : ''
                }`
              })
              .join(' · ')
          ),
      }
    },
  },
  {
    key: 'sonarr',
    name: 'Sonarr',
    group: 'Media',
    description: 'TV shows',
    link: { app: 'sonarr' },
    gatus: 'sonarr',
    load: async (ctx) => {
      // gluetun owns the netns, so only gluetun publishes ports — the *arrs
      // are reachable at the host port and nowhere else. Same URL homepage uses.
      const base = `${ctx.hc}:8989/api/v3`
      const k = `apikey=${key('SONARR_API_KEY')}`
      const [wanted, queue, series] = await Promise.all([
        getJson<{ totalRecords?: number }>(`${base}/wanted/missing?pageSize=1&${k}`),
        getJson<{ totalRecords?: number }>(`${base}/queue?${k}`),
        getJson<unknown[]>(`${base}/series?${k}`),
      ])
      return {
        stats: [
          stat('Wanted', num(wanted?.totalRecords)),
          stat('Queued', num(queue?.totalRecords)),
          stat('Series', num(series?.length)),
        ],
      }
    },
  },
  {
    key: 'radarr',
    name: 'Radarr',
    group: 'Media',
    description: 'Movies',
    link: { app: 'radarr' },
    gatus: 'radarr',
    load: async (ctx) => {
      const base = `${ctx.hc}:7878/api/v3`
      const k = `apikey=${key('RADARR_API_KEY')}`
      const [wanted, queue, movies] = await Promise.all([
        getJson<{ totalRecords?: number }>(`${base}/wanted/missing?pageSize=1&${k}`),
        getJson<{ totalRecords?: number }>(`${base}/queue?${k}`),
        getJson<unknown[]>(`${base}/movie?${k}`),
      ])
      return {
        stats: [
          stat('Wanted', num(wanted?.totalRecords)),
          stat('Queued', num(queue?.totalRecords)),
          stat('Movies', num(movies?.length)),
        ],
      }
    },
  },
  {
    key: 'prowlarr',
    name: 'Prowlarr',
    group: 'Media',
    description: 'Indexer aggregator',
    link: { app: 'prowlarr' },
    gatus: 'prowlarr',
    load: async (ctx) => {
      const base = `${ctx.hc}:9696/api/v1`
      const k = `apikey=${key('PROWLARR_API_KEY')}`
      type IndexerStat = {
        numberOfQueries?: number
        numberOfGrabs?: number
        numberOfFailedQueries?: number
        numberOfFailedGrabs?: number
      }
      const [stats, indexers] = await Promise.all([
        getJson<{ indexers?: IndexerStat[] }>(`${base}/indexerstats?${k}`),
        getJson<{ enable: boolean }[]>(`${base}/indexer?${k}`),
      ])
      // indexerstats is per-indexer; the tile wants the fleet-wide totals.
      const sum = (f: (i: IndexerStat) => number | undefined): number | null =>
        stats?.indexers === undefined ?
          null
        : stats.indexers.reduce((acc, i) => acc + (f(i) ?? 0), 0)
      return {
        stats: [
          stat('Indexers', num(indexers?.filter((i) => i.enable).length)),
          stat('Queries', num(sum((i) => i.numberOfQueries))),
          stat('Grabs', num(sum((i) => i.numberOfGrabs))),
          stat('Fail queries', num(sum((i) => i.numberOfFailedQueries))),
        ],
      }
    },
  },
  {
    key: 'metube',
    name: 'MeTube',
    group: 'Media',
    description: 'yt-dlp web UI',
    link: { app: 'metube' },
    gatus: 'metube',
    load: async (ctx) => {
      // Through traefik on a scoped bypass (`GET /history`, stacks/metube):
      // metube is on traefik-net only, and daedalus is deliberately not.
      const h = await getJson<{ queue?: unknown[]; pending?: unknown[]; done?: unknown[] }>(
        `${ctx.base('metube')}/history`,
      )
      return {
        stats: [
          stat('Queued', num(h?.queue?.length)),
          stat('Pending', num(h?.pending?.length)),
          stat('Done', num(h?.done?.length)),
        ],
      }
    },
  },
  {
    key: 'qbittorrent',
    name: 'qBittorrent',
    group: 'Media',
    description: 'BitTorrent (via gluetun/ProtonVPN)',
    link: { app: 'qbittorrent' },
    gatus: 'qbittorrent',
    load: async (ctx) => {
      const base = `${ctx.hc}:8090`
      const cookie = await qbtCookie(base)
      if (cookie === null) return { stats: [] }
      const h = { headers: { Cookie: cookie } }
      const [transfer, torrents] = await Promise.all([
        getJson<{ dl_info_speed?: number; up_info_speed?: number }>(
          `${base}/api/v2/transfer/info`,
          h,
        ),
        getJson<{ state: string }[]>(`${base}/api/v2/torrents/info`, h),
      ])
      const inState = (re: RegExp) => (torrents ?? []).filter((t) => re.test(t.state)).length
      return {
        stats: [
          stat('Leech', torrents === null ? DASH : num(inState(/downl|stalledDL|metaDL/i))),
          stat('Seed', torrents === null ? DASH : num(inState(/upl|stalledUP/i))),
          stat('Download', rate(transfer?.dl_info_speed)),
          stat('Upload', rate(transfer?.up_info_speed)),
        ],
      }
    },
  },
  {
    key: 'nzbget',
    name: 'NZBGet',
    group: 'Media',
    description: 'Usenet downloader (via gluetun)',
    link: { app: 'nzbget' },
    gatus: 'nzbget',
    load: async (ctx) => {
      // /jsonrpc is already on nzbget's forward-auth bypass (stacks/tv).
      const b = await getJson<{
        result?: {
          DownloadRate?: number
          RemainingSizeMB?: number
          DownloadedSizeMB?: number
          DownloadPaused?: boolean
        }
      }>(`${ctx.base('nzbget')}/jsonrpc/status`)
      const r = b?.result
      return {
        stats: [
          stat('Rate', rate(r?.DownloadRate)),
          stat('Remaining', r?.RemainingSizeMB === undefined ? DASH : bytes(r.RemainingSizeMB * 1024 * 1024)),
          stat(
            'Downloaded',
            r?.DownloadedSizeMB === undefined ? DASH : bytes(r.DownloadedSizeMB * 1024 * 1024),
          ),
        ],
        note: r?.DownloadPaused === true ? 'Paused' : undefined,
      }
    },
  },
  {
    key: 'gluetun',
    name: 'Gluetun',
    group: 'Media',
    description: 'ProtonVPN WireGuard tunnel',
    link: { url: 'https://grafana.toscanini.me/d/s2-network' },
    load: () => gluetunStats(8000, true),
  },
  {
    key: 'bazarr',
    name: 'Bazarr',
    group: 'Media',
    description: 'Subtitles',
    link: { app: 'bazarr' },
    gatus: 'bazarr',
    load: async (ctx) => {
      const h = { headers: { 'X-API-KEY': key('BAZARR_API_KEY') } }
      const base = `${ctx.hc}:6767/api`
      const [eps, movies] = await Promise.all([
        getJson<{ total?: number }>(`${base}/episodes/wanted`, h),
        getJson<{ total?: number }>(`${base}/movies/wanted`, h),
      ])
      return {
        stats: [
          stat('Missing episodes', num(eps?.total)),
          stat('Missing movies', num(movies?.total)),
        ],
      }
    },
  },
  {
    key: 'cleanuparr',
    name: 'Cleanuparr',
    group: 'Media',
    description: 'Download-queue cleanup & malware blocking',
    link: { app: 'cleanuparr' },
    gatus: 'cleanuparr',
    load: async () => {
      // Counted out of its own log lines: cleanuparr publishes no metrics, and
      // 2.10.1 closed the API homepage used to read. Same LogQL as its tile.
      const over = (needle: string) =>
        lokiScalar(
          `sum(count_over_time({container="cleanuparr"} |= \`${needle}\` [7d])) or vector(0)`,
        )
      const [removed, blocked, searches] = await Promise.all([
        over('Removing item with max strikes'),
        over('blocked item keeps coming back'),
        over('Replacement search triggered'),
      ])
      return {
        stats: [
          stat('Removed 7d', num(removed)),
          stat('Blocked 7d', num(blocked)),
          stat('Searches 7d', num(searches)),
        ],
      }
    },
  },
  {
    key: 'janitorr',
    name: 'Janitorr',
    group: 'Media',
    description: 'Media retention (dry-run) — log review',
    link: {
      url: 'https://grafana.toscanini.me/a/grafana-lokiexplore-app/explore?from=now-7d&to=now&var-ds=loki-default&var-filters=container%7C%3D%7Cjanitorr',
    },
    load: async () => {
      const n = await lokiScalar(
        'sum(count_over_time({container="janitorr"} |= `Deleting` [7d])) or vector(0)',
      )
      return { stats: [stat('Would delete 7d', num(n))], note: 'Dry-run — nothing is deleted' }
    },
  },

  // ══ Books ════════════════════════════════════════════════════════════════
  {
    key: 'calibre-web',
    name: 'Calibre-Web',
    group: 'Books',
    description: 'Ebook library',
    link: { app: 'calibre-web' },
    gatus: 'calibre-web',
    load: async (ctx) => {
      // /opds is on calibre-web's forward-auth bypass and takes its own basic
      // auth (stacks/calibre-web) — the same credentials homepage's widget uses.
      const b = await getJson<{
        books?: number
        authors?: number
        categories?: number
        series?: number
      }>(`${ctx.base('calibre-web')}/opds/stats`, {
        headers: { Authorization: basicAuth(key('CALIBREWEB_USER'), key('CALIBREWEB_PASS')) },
      })
      return {
        stats: [
          stat('Books', num(b?.books)),
          stat('Authors', num(b?.authors)),
          stat('Categories', num(b?.categories)),
          stat('Series', num(b?.series)),
        ],
      }
    },
  },
  {
    key: 'shelfmark',
    name: 'Shelfmark',
    group: 'Books',
    description: "Book downloader (Anna's Archive, via VPN)",
    link: { app: 'shelfmark' },
    gatus: 'shelfmark',
    load: async (ctx) => {
      // Shares the downloads stack's gluetun netns → host port, like the *arrs.
      const s = await getJson<Record<string, Record<string, unknown>>>(
        `${ctx.hc}:8084/api/status`,
      )
      const n = (k: string) => (s === null ? DASH : num(Object.keys(s[k] ?? {}).length))
      return {
        stats: [
          stat('Downloading', n('downloading')),
          stat('Queued', n('queued')),
          stat('Done', n('complete')),
          stat('Errors', n('error')),
        ],
      }
    },
  },

  // ══ Gaming ═══════════════════════════════════════════════════════════════
  {
    key: 'factorio',
    name: 'Factorio Admin',
    group: 'Gaming',
    description: 'Server manager',
    link: { app: 'factorio-admin' },
    gatus: 'factorio-admin',
  },

  // ══ Network ══════════════════════════════════════════════════════════════
  {
    key: 'cloudflared',
    name: 'Cloudflare Tunnel',
    group: 'Network',
    description: 'Outbound CF Tunnel',
    link: {
      url: `https://dash.cloudflare.com/${process.env.CF_ACCOUNT_ID ?? ''}/tunnels/${
        process.env.CF_TUNNEL_ID ?? ''
      }/overview`,
    },
    load: async () => {
      const b = await getJson<{
        result?: { status?: string; connections?: unknown[] }
      }>(
        `https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID ?? ''}/cfd_tunnel/${
          process.env.CF_TUNNEL_ID ?? ''
        }`,
        { headers: { Authorization: `Bearer ${key('CF_API_TOKEN')}` } },
      )
      return {
        stats: [
          stat('Status', text(b?.result?.status)),
          stat('Connections', num(b?.result?.connections?.length)),
        ],
      }
    },
  },
  {
    key: 'traefik',
    name: 'Traefik',
    group: 'Network',
    description: 'Reverse proxy — all *.toscanini.me routes',
    link: { app: 'traefik-dashboard' },
    gatus: 'traefik-dashboard',
    load: async () => {
      // The :8080 API entrypoint, over the iso-daedalus-net bridge traefik
      // already shares with this container. The public dashboard hostname is
      // oidc-gated, as it should be.
      type Count = { total?: number }
      const b = await getJson<{
        http?: { routers?: Count; services?: Count; middlewares?: Count }
      }>('http://traefik:8080/api/overview')
      return {
        stats: [
          stat('Routers', num(b?.http?.routers?.total)),
          stat('Services', num(b?.http?.services?.total)),
          stat('Middlewares', num(b?.http?.middlewares?.total)),
        ],
      }
    },
  },
  {
    key: 'wg-easy',
    name: 'WireGuard',
    group: 'Network',
    description: 'VPN admin',
    link: { app: 'wg-easy' },
    gatus: 'wg-easy',
    load: async () => {
      // Prometheus, not wg-easy's API: v2 requires TOTP on /api/session, so a
      // credential login cannot work unattended. The exporter is already
      // scraped and carries exactly the numbers the tile wants.
      const m = await promScalars({
        connected: 'wireguard_connected_peers',
        enabled: 'wireguard_enabled_peers',
        total: 'wireguard_configured_peers',
      })
      return {
        stats: [
          stat('Connected', num(m.connected)),
          stat('Enabled', num(m.enabled)),
          stat('Total', num(m.total)),
        ],
      }
    },
  },
  {
    key: 'pihole',
    name: 'Pi-hole',
    group: 'Network',
    description: 'LAN DNS, DHCP, ad-blocking',
    link: { app: 'pihole' },
    gatus: 'pihole',
    load: async (ctx) => {
      const base = ctx.base('pihole')
      const sid = await piholeSid(base)
      const b = await getJson<{
        queries?: { total?: number; blocked?: number; percent_blocked?: number }
        gravity?: { domains_being_blocked?: number }
      }>(`${base}/api/stats/summary`, sid === null ? {} : { headers: { sid } })
      return {
        stats: [
          stat('Queries', num(b?.queries?.total)),
          stat('Blocked', num(b?.queries?.blocked)),
          stat(
            'Blocked %',
            b?.queries?.percent_blocked === undefined ?
              DASH
            : `${b.queries.percent_blocked.toFixed(2)}%`,
          ),
          stat('Gravity', num(b?.gravity?.domains_being_blocked)),
        ],
      }
    },
  },
  {
    key: 'myspeed',
    name: 'MySpeed',
    group: 'Network',
    description: 'Internet speed tracker',
    link: { app: 'myspeed' },
    gatus: 'myspeed',
    load: async () => {
      // Prometheus rather than MySpeed's API: it already exports
      // myspeed_{ping,download,upload} for the latest hourly test
      // (stacks/myspeed), so the tile needs no forward-auth bypass.
      const m = await promScalars({
        ping: 'myspeed_ping',
        download: 'myspeed_download',
        upload: 'myspeed_upload',
      })
      return {
        stats: [
          stat('Ping', m.ping === null ? DASH : `${num(m.ping)} ms`),
          stat('Download', m.download === null ? DASH : `${num(m.download)} Mbps`),
          stat('Upload', m.upload === null ? DASH : `${num(m.upload)} Mbps`),
        ],
      }
    },
  },
  {
    key: 'router',
    name: 'Router',
    group: 'Network',
    description: 'LAN router admin (192.168.0.1)',
    link: {
      url: `${process.env.ROUTER_URL ?? 'http://192.168.0.1'}/webpages/index.html#networkMap`,
    },
  },
  {
    key: 'cf-dns',
    name: 'Cloudflare DNS',
    group: 'Network',
    description: 'DNS records for toscanini.me',
    link: {
      url: `https://dash.cloudflare.com/${process.env.CF_ACCOUNT_ID ?? ''}/toscanini.me/dns/records`,
    },
  },
  {
    key: 'namecheap',
    name: 'Namecheap',
    group: 'Network',
    description: 'Domain registrar — toscanini.me',
    link: {
      url: 'https://ap.www.namecheap.com/Domains/DomainControlPanel/toscanini.me/advancedns',
    },
  },
  {
    key: 'protonvpn',
    name: 'ProtonVPN',
    group: 'Network',
    description: 'Re-export WireGuard config when gluetun peers fail',
    link: { url: 'https://account.protonvpn.com/downloads' },
  },

  // ══ Monitoring ═══════════════════════════════════════════════════════════
  {
    key: 'grafana',
    name: 'Grafana',
    group: 'Monitoring',
    description: 'Dashboards',
    link: { app: 'grafana', path: '/dashboards' },
    gatus: 'grafana',
    load: async () => {
      // Over the `monitoring` bridge daedalus already joins for prometheus.
      const h = { headers: { Authorization: basicAuth(key('GRAFANA_USER'), key('GRAFANA_PASS')) } }
      const [stats, rules] = await Promise.all([
        getJson<{ dashboards?: number; datasources?: number; alerts?: number }>(
          'http://grafana:3000/api/admin/stats',
          h,
        ),
        getJson<{ data?: { groups?: { rules?: { state?: string }[] }[] } }>(
          'http://grafana:3000/api/prometheus/grafana/api/v1/rules',
          h,
        ),
      ])
      const all = (rules?.data?.groups ?? []).flatMap((g) => g.rules ?? [])
      return {
        stats: [
          stat('Dashboards', num(stats?.dashboards)),
          stat('Data sources', num(stats?.datasources)),
          stat('Alert rules', num(stats?.alerts)),
          stat('Firing', rules === null ? DASH : num(all.filter((r) => r.state === 'firing').length)),
        ],
      }
    },
  },
  {
    key: 'loki',
    name: 'Logs',
    group: 'Monitoring',
    description: 'All services — journald → Loki',
    link: {
      url: 'https://grafana.toscanini.me/a/grafana-lokiexplore-app/explore?from=now-1h&to=now&var-ds=loki-default',
    },
    load: async () => {
      const [lines, warn, err] = await Promise.all([
        lokiScalar('sum(count_over_time({level=~".+"}[1h])) or vector(0)'),
        lokiScalar('sum(count_over_time({level="warning"}[1h])) or vector(0)'),
        lokiScalar('sum(count_over_time({level="error"}[1h])) or vector(0)'),
      ])
      return {
        stats: [stat('Lines 1h', num(lines)), stat('Warn 1h', num(warn)), stat('Errors 1h', num(err))],
      }
    },
  },
  {
    key: 'prometheus',
    name: 'Prometheus',
    group: 'Monitoring',
    description: 'TSDB — 30d / 100GB retention',
    link: { app: 'prometheus' },
    gatus: 'prometheus',
    load: async () => {
      const targets = await getJson<{ data?: { activeTargets?: { health: string }[] } }>(
        `${process.env.PROMETHEUS_URL ?? 'http://prometheus:9090'}/api/v1/targets?state=any`,
      )
      const t = targets?.data?.activeTargets
      const series = await promScalar('prometheus_tsdb_head_series')
      return {
        stats: [
          stat('Targets up', t === undefined ? DASH : num(t.filter((x) => x.health === 'up').length)),
          stat(
            'Targets down',
            t === undefined ? DASH : num(t.filter((x) => x.health !== 'up').length),
          ),
          stat('Series', num(series)),
        ],
      }
    },
  },
  {
    key: 'gatus',
    name: 'Gatus',
    group: 'Monitoring',
    description: 'Outside-in uptime + cert expiry',
    link: { app: 'gatus', path: '/oidc/login' },
    gatus: 'gatus',
    load: async () => {
      // Gatus's own API is oidc-gated; its metrics are not, and they are the
      // same numbers. This is also what the homepage tile read.
      const m = await promScalars({
        up: 'count(gatus_results_endpoint_success == 1) or vector(0)',
        down: 'count(gatus_results_endpoint_success == 0) or vector(0)',
        uptime: '100 * avg(avg_over_time(gatus_results_endpoint_success[24h]))',
      })
      return {
        stats: [
          stat('Up', num(m.up)),
          stat('Down', num(m.down)),
          stat('Uptime 24h', m.uptime === null ? DASH : `${m.uptime.toFixed(2)}%`),
        ],
      }
    },
  },
  {
    key: 'healthchecks',
    name: 'Healthchecks',
    group: 'Monitoring',
    description: "Cron / job dead-man's-switch",
    link: { app: 'healthchecks' },
    gatus: 'healthchecks',
    load: async (ctx) => {
      const b = await getJson<{ checks?: { status: string }[] }>(
        `${ctx.base('healthchecks')}/api/v1/checks/`,
        { headers: { 'X-Api-Key': key('HEALTHCHECKS_API_KEY') } },
      )
      const c = b?.checks
      const inState = (s: string) => (c ?? []).filter((x) => x.status === s).length
      return {
        stats: [
          stat('Up', c === undefined ? DASH : num(inState('up'))),
          stat('Down', c === undefined ? DASH : num(inState('down'))),
          stat('Late', c === undefined ? DASH : num(inState('grace'))),
          stat('Total', num(c?.length)),
        ],
      }
    },
  },
]
