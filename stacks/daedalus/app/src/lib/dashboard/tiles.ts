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
import { DASH, key, num } from './format'

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
  // No 'Home' either: eight tiles, and the two biggest data stores on the box
  // — the photo library and the file sync — got four numbers and a link each.
  // Every one of them is a tab on the Home page now.
  | 'Monitoring'

export type CategoryName =
  | 'ai'
  | 'media'
  | 'home'
  | 'gaming'
  | 'network'
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
  { name: 'Monitoring', category: 'monitoring', icon: '◎' },
]

// Value formatting is shared with the category boards — see ./format.
function stat(label: string, value: string): Stat {
  return { label, value }
}

// ── the catalogue ──────────────────────────────────────────────────────────

export const TILES: TileDef[] = [
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
