import type { Ctx } from '../../../core/ctx'
import { type VersionGap, versionGap } from '../../../lib/dashboard/github'
import { loadMailRelay, type MailRelay } from '../../../lib/dashboard/mail-relay'
import { basicAuth, getJson } from '../../../lib/http'

// The Alerts tab: Grafana's ruler (every rule here is Grafana-managed), where
// a firing alert goes, and the mail relay read back out of Loki — the one
// delivery path that cannot alert about its own failure (the reader is
// lib/dashboard/mail-relay.ts, which the Communications page shares).

export type AlertsData = {
  rules: number | null
  firing: number | null
  pending: number | null
  /** Every rule currently firing or pending, named — a count sends you hunting. */
  active: { name: string; folder: string; severity: string; summary: string }[]
  byFolder: { label: string; value: number }[]
  grafana: { dashboards: number | null; datasources: number | null; version: string | null }
  /** Where a firing alert actually goes. */
  delivery: { contactPoints: number | null; mail: boolean }
  /** The relay itself, read back from what it logged. */
  mail: MailRelay
  gap: VersionGap
}

type GrafanaRule = {
  name?: string
  state?: string
  annotations?: Record<string, string>
  alerts?: { labels?: Record<string, string> }[]
}

/**
 * Grafana's ruler, not prometheus's.
 *
 * Every alert rule on this box is a Grafana-managed one — nix/modules/monitoring
 * provisions them from files — so prometheus's own /rules endpoint is empty
 * and would report "0 alerts" on a box with thirty.
 */
export async function loadAlerts(ctx: Ctx): Promise<AlertsData> {
  const h = {
    headers: { Authorization: basicAuth(ctx.secret('GRAFANA_USER'), ctx.secret('GRAFANA_PASS')) },
  }

  const [body, stats, contacts, health, mail] = await Promise.all([
    getJson<{ data?: { groups?: { file?: string; name?: string; rules?: GrafanaRule[] }[] } }>(
      'http://grafana:3000/api/prometheus/grafana/api/v1/rules',
      h,
    ),
    getJson<{ dashboards?: number; datasources?: number }>(
      'http://grafana:3000/api/admin/stats',
      h,
    ),
    getJson<unknown[]>('http://grafana:3000/api/v1/provisioning/contact-points', h),
    getJson<{ version?: string }>('http://grafana:3000/api/health', h),
    loadMailRelay(ctx),
  ])

  const groups = body?.data?.groups ?? []
  // `file` is the folder title in Grafana's ruler response; `name` is the
  // evaluation group inside it. The folder is the useful grouping — it is what
  // the sidebar shows and what the provisioning files are organised by.
  const flat = groups.flatMap((g) =>
    (g.rules ?? []).map((r) => ({ folder: g.file ?? '?', rule: r })),
  )

  const byFolder = new Map<string, number>()
  for (const { folder } of flat) byFolder.set(folder, (byFolder.get(folder) ?? 0) + 1)

  // sameMajor, because Grafana maintains several release lines at once and
  // publishes them interleaved by date: 13.1.3, then 13.0.6, then 12.4.8. A box
  // on 13.x compared against the flat list is told it is behind a 12.x patch,
  // which is not an upgrade in any sense.
  const gap = await versionGap('grafana/grafana', health?.version ?? null, { sameMajor: true })

  return {
    gap,
    rules: body === null ? null : flat.length,
    firing: body === null ? null : flat.filter((r) => r.rule.state === 'firing').length,
    pending: body === null ? null : flat.filter((r) => r.rule.state === 'pending').length,
    active: flat
      .filter((r) => r.rule.state === 'firing' || r.rule.state === 'pending')
      .map(({ folder, rule }) => ({
        name: rule.name ?? '?',
        folder,
        // Severity is a label on the generated alert INSTANCE, not on the rule
        // — an inactive rule has no instances at all, which is why this is
        // only read for the active ones.
        severity: rule.alerts?.[0]?.labels?.severity ?? 'unknown',
        summary: rule.annotations?.summary ?? rule.annotations?.description ?? '',
      })),
    byFolder: [...byFolder]
      .map(([label, value]) => ({ label, value }))
      .sort((a, b) => b.value - a.value),
    grafana: {
      dashboards: stats?.dashboards ?? null,
      datasources: stats?.datasources ?? null,
      version: health?.version ?? null,
    },
    delivery: { contactPoints: contacts?.length ?? null, mail: true },
    mail,
  }
}
