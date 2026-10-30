import type { Ctx } from '../../../core/ctx'
import type { LokiStream } from '../../../host/loki'
import { swrValue } from '../../../lib/cache'
import { RELAY_WINDOW_DAYS } from '../../../lib/dashboard/mail-relay'
import { basicAuth } from '../../../lib/http'
import { listAppsLight } from '../../../lib/repo/apps'

// The services that send through the relay's account with an SMTP client of
// their own, so their mail never passes msmtp: what each one's own log or API
// says it sent. Each reading is there only when the service is.
//
//   healthchecks  `sendalerts` prints one line per notification it tries:
//                 `  <channel> (email) OK in 2.2s`, or `… Error in 2.2s: <why>`
//                 (hc/api/management/commands/sendalerts.py), so both counts
//                 are real.
//   Grafana       logs a failed delivery (`Notify for alerts failed`, with
//                 `email` in its error) and nothing for a delivered one, so
//                 its count is of failures; its email contact points come
//                 from the provisioning API.
//   apps          the per-app `mail.enable` switch: the fact, no count.

export type HealthchecksMail = { sent: number; failed: number }

export type GrafanaFailure = { at: number; error: string }

export type GrafanaMail = {
  /** Email receivers across Grafana's contact points. Null: Grafana did not answer. */
  contactPoints: number | null
  /** Failed email deliveries in the window. Null: Loki did not answer. */
  failed: number | null
  /** The newest failure: when, and Grafana's error. */
  lastFailure: GrafanaFailure | null
}

export type OwnMailers = {
  healthchecks: HealthchecksMail | null
  grafana: GrafanaMail | null
  /** Apps with the relay switched on, by name. */
  apps: string[]
}

const WINDOW_MIN = RELAY_WINDOW_DAYS * 24 * 60

const HC_LINES = '{container="healthchecks"} |~ `^\\s+\\S+ \\(email\\) `'
const GF_FAILS = '{container="grafana"} |= "Notify for alerts failed" |= "email"'

/** healthchecks' delivery lines, counted. Pure. */
export function healthchecksMail(streams: LokiStream[]): HealthchecksMail {
  const lines = streams.flatMap((s) => s.values.map(([, line]) => line))
  const sent = lines.filter((l) => /\(email\) OK\b/.test(l)).length
  return { sent, failed: lines.length - sent }
}

/** Grafana's failed email deliveries, newest first. Pure. */
export function grafanaFailures(streams: LokiStream[]): GrafanaFailure[] {
  return streams
    .flatMap((s) =>
      s.values.map(([ns, line]) => ({
        at: Number(ns) / 1e6,
        // logfmt's `err="…"`: the one quoted field that is the diagnosis.
        error: /\berr="((?:[^"\\]|\\.)*)"/.exec(line)?.[1]?.replace(/\\"/g, '"') ?? line,
      })),
    )
    .sort((a, b) => b.at - a.at)
}

type Reads = Pick<Ctx, 'loki' | 'http' | 'secret' | 'modules'>

/** Five minutes, like the relay's own read: a month of history does not move by the second. */
const cache = <T>(load: () => Promise<T>) => swrValue({ ttlMs: 5 * 60_000, retryMs: 60_000 }, load)

let hcCached: (() => Promise<LokiStream[] | null>) | null = null
let gfCached: (() => Promise<LokiStream[] | null>) | null = null

async function grafanaMail(ctx: Reads): Promise<GrafanaMail> {
  gfCached ??= cache(() => ctx.loki.streamsOrNull(GF_FAILS, { minutes: WINDOW_MIN, limit: 500 }))
  const [points, fails] = await Promise.all([
    ctx.http.getJson<{ type?: string }[]>(
      'http://grafana:3000/api/v1/provisioning/contact-points',
      {
        headers: {
          Authorization: basicAuth(ctx.secret('GRAFANA_USER'), ctx.secret('GRAFANA_PASS')),
        },
      },
    ),
    gfCached(),
  ])
  const failures = fails === null ? null : grafanaFailures(fails)
  return {
    contactPoints: points === null ? null : points.filter((p) => p.type === 'email').length,
    failed: failures === null ? null : failures.length,
    lastFailure: failures?.[0] ?? null,
  }
}

export async function loadOwnMailers(ctx: Reads): Promise<OwnMailers> {
  hcCached ??= cache(() => ctx.loki.streamsOrNull(HC_LINES, { minutes: WINDOW_MIN, limit: 2000 }))
  const [hc, grafana, apps] = await Promise.all([
    ctx.modules.enabled('healthchecks') ? hcCached() : Promise.resolve(null),
    ctx.modules.enabled('monitoring') ? grafanaMail(ctx) : Promise.resolve(null),
    listAppsLight().catch(() => []),
  ])
  return {
    healthchecks: hc === null ? null : healthchecksMail(hc),
    grafana,
    apps: apps.filter((a) => a.mail).map((a) => a.name),
  }
}
