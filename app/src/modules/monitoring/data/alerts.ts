import type { Ctx } from '../../../core/ctx'
import { siteMail } from '../../../host/contract/domains/site'
import type { LokiStream } from '../../../host/loki'
import { swrValue } from '../../../lib/cache'
import { type VersionGap, versionGap } from '../../../lib/dashboard/github'
import { basicAuth, getJson } from '../../../lib/http'

// The Alerts tab: Grafana's ruler (every rule here is Grafana-managed), where
// a firing alert goes, and the mail relay read back out of Loki — the one
// delivery path that cannot alert about its own failure.

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
  /**
   * The relay itself, read back from what it logged.
   *
   * A dead Gmail app password makes this box QUIETER, not louder — every
   * alert path ends in msmtp, and msmtp failing produces no alert about
   * itself. `lastSend` age is a neutral fact: on a healthy box alerts are
   * rare, so weeks of silence is a normal state. Only `failures` — observed
   * delivery errors — is bad news.
   */
  mail: {
    /** sender → alertTo, from /export/site.json. Null = export missing. */
    identity: { sender: string; alertTo: string } | null
    /** Newest successful SMTP handoff, and which unit had news. */
    lastSend: { agoSeconds: number; unit: string; recipients: string | null } | null
    /** Delivery attempts in the window. Null = Loki unreachable, NOT zero. */
    sent30d: number | null
    failed30d: number | null
    /** Newest first, capped — the drill-down behind failed30d. */
    failures: { agoSeconds: number; unit: string; error: string }[]
  }
  gap: VersionGap
}

type GrafanaRule = {
  name?: string
  state?: string
  annotations?: Record<string, string>
  alerts?: { labels?: Record<string, string> }[]
}

/**
 * msmtp logs exactly one syslog line per delivery attempt — starting `host=`
 * and ending `exitcode=EX_*` (EX_OK on success, `errormsg='…' exitcode=EX_*`
 * on failure) — and journald files it under the SENDING unit, so one line
 * answers both "did it go" and "who was trying to say something". There is
 * no msmtp unit to watch: the relay is a sendmail binary run inside whatever
 * unit had news, which is why this selects on the line's shape.
 *
 * The `^host=` anchor is load-bearing, not decorative: a bare substring
 * filter MATCHES ITS OWN ECHO. Loki logs warned/sharded queries with the
 * query text embedded, alloy ships that journal line straight back in, and
 * the next render finds its own previous question and reports it as a
 * successful send (observed: `user@1000.service`, one minute old, forever).
 * An echoed line always carries the logger's preamble first, so the anchor
 * cannot match it.
 */
const MSMTP_LINE = '{unit=~".+"} |~ "^host=.* exitcode=EX_"'

/** Loki refuses a range much past thirty days — this is the whole history we can ask for. */
const MAIL_WINDOW_MIN = 30 * 24 * 60

/**
 * Comfortably past a real month of alert mail (~70 lines); at the cap the
 * two counts become lower bounds, which for "did anything fail" still reads
 * the right way.
 */
const MAIL_LIMIT = 200

/**
 * One query, cached: a line filter over every stream for thirty days is a
 * multi-gigabyte scan Loki takes seconds over, and this page asked it four
 * near-identical times per render before the numbers ever settled. Five
 * minutes of staleness is free on a board about a month of history; the
 * two-clock cache keeps serving the last good answer through a slow spell
 * instead of hammering a busy Loki (`null` = unreachable, so stale-serving
 * applies).
 */
let cachedMailAttempts: (() => Promise<LokiStream[] | null>) | null = null
// Built on first use, because the Loki client arrives with the ctx and a
// module-level constant has none; the process has one Loki, so one cache.
const mailAttempts = (ctx: Ctx) => {
  cachedMailAttempts ??= swrValue({ ttlMs: 5 * 60_000, retryMs: 60_000 }, () =>
    ctx.loki.streamsOrNull(MSMTP_LINE, { minutes: MAIL_WINDOW_MIN, limit: MAIL_LIMIT }),
  )
  return cachedMailAttempts()
}

async function loadMail(ctx: Ctx): Promise<AlertsData['mail']> {
  const [identity, streams] = await Promise.all([siteMail(), mailAttempts(ctx)])
  if (streams === null) {
    // Loki did not answer — which on a board about silence must not be
    // allowed to render as a quiet month.
    return { identity, lastSend: null, sent30d: null, failed30d: null, failures: [] }
  }

  const now = Date.now()
  const attempts = streams
    .flatMap((s) =>
      s.values.map(([ns, line]) => ({
        agoSeconds: (now - Number(ns) / 1e6) / 1000,
        unit: s.stream.unit ?? '?',
        line,
      })),
    )
    .sort((a, b) => a.agoSeconds - b.agoSeconds)

  const ok = attempts.filter((a) => a.line.includes('exitcode=EX_OK'))
  const failed = attempts.filter((a) => !a.line.includes('exitcode=EX_OK'))
  const newest = ok[0]

  return {
    identity,
    lastSend:
      newest === undefined
        ? null
        : {
            agoSeconds: newest.agoSeconds,
            unit: newest.unit,
            recipients: /(?:^|\s)recipients=(\S+)/.exec(newest.line)?.[1] ?? null,
          },
    sent30d: ok.length,
    failed30d: failed.length,
    failures: failed.slice(0, 12).map((f) => ({
      agoSeconds: f.agoSeconds,
      unit: f.unit,
      // The message inside the quotes is the whole diagnosis ("cannot
      // connect…", "authentication failed…"); the rest of the line is the
      // same key=value preamble every send carries.
      error: /errormsg='([^']*)'?/.exec(f.line)?.[1] ?? f.line,
    })),
  }
}

/**
 * Grafana's ruler, not prometheus's.
 *
 * Every alert rule on this box is a Grafana-managed one — stacks/monitoring
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
    loadMail(ctx),
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
