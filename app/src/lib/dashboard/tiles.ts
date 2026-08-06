// The service directory under every category page.
//
// One entry per service on the box, carrying a couple of live numbers and a
// link through to the thing itself. Apps are deliberately absent: they have a
// richer page under /apps, and duplicating them here would be two places to
// look at the same thing.
//
// ── why the catalogue lives in TypeScript ─────────────────────────────────
//
// Every one of these services shapes its response differently enough — a
// cookie login here, a session id there, a sum over an array somewhere else —
// that "the mapping" is code, not data. A config-driven version would mean
// splitting that code across 30 stack modules and shipping it as strings,
// which is a worse version of what is written plainly here.
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
  promScalar,
  promScalars,
} from './clients'
import { DASH, bytes, key, num, text } from './format'

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
  // No 'AI & Automation'. That group held exactly four tiles — Lemonade,
  // LiteLLM, n8n, Open WebUI — and each of those now has a whole tab of its
  // own on the AI page, opening with the same name, status dot, description
  // and link the tile carried. A directory that repeats the tab row above it
  // is not a directory, it is the same page twice.
  // No 'Network' either, and for the same reason: five of its nine tiles were
  // a service that now has a tab, and the other four were bare links that
  // belong on the tab whose subject they are.
  // No 'Media' or 'Books': thirteen tiles, every one of them a service that is
  // now a tab. A tile could hold three numbers and a link, which was never
  // enough to answer either question anybody had about these — what version is
  // running, and what does the service itself say is wrong.
  | 'Home'
  | 'Monitoring'

export type CategoryName =
  | 'ai'
  | 'media'
  | 'home'
  | 'gaming'
  | 'network'
  | 'security'
  | 'system'
  | 'monitoring'

/**
 * Group → the category page it belongs to, and (where the category has
 * sub-tabs) which one.
 *
 * A group with no `tab` shows on every tab of its category. Neither surviving
 * group is in a category with sub-tabs, so the field is unused today — it is
 * kept because the loader still honours it and the next directory to be scoped
 * to one tab should not have to reintroduce it.
 */
export const GROUPS: {
  name: GroupName
  category: CategoryName
  tab?: string
  icon: string
}[] = [
  { name: 'Home', category: 'home', icon: '⌂' },
  { name: 'Monitoring', category: 'monitoring', icon: '◎' },
]

// Value formatting is shared with the category boards — see ./format.
function stat(label: string, value: string): Stat {
  return { label, value }
}

// ── the catalogue ──────────────────────────────────────────────────────────

export const TILES: TileDef[] = [
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
    // from a container as host.containers.internal, which is how this dials it.
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
      // same numbers.
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
