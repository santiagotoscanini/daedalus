import type { Ctx } from '../../../core/ctx'
import { monitoredJobsList } from '../../../host/contract/domains/jobs'
import {
  loadMailRelay,
  loadRelayLog,
  type MailRelay,
  RELAY_WINDOW_DAYS,
  type RelayDelivery,
  type RelayLog,
} from '../../../lib/dashboard/mail-relay'
import { localDay } from '../../../lib/format'
import { loadOwnMailers, type OwnMailers } from './senders'

// Communications › the relay tab: the account every system mail leaves through, read
// back from msmtp's own log (lib/dashboard/mail-relay.ts, which Monitoring ›
// Alerts shares), its setup as nix exported it, and who else sends with it.

/** One day of the window, the box's local day. */
export type RelayDay = { day: string; sent: number; failed: number }

/** One unit that ran msmtp in the window, and how it went. */
export type RelayCaller = {
  unit: string
  /** For a failure notice, the unit whose failure it reported. */
  about: string | null
  sent: number
  failed: number
  /** Milliseconds since the epoch. */
  lastAt: number
}

/** The mailers that hand msmtp their mail, as nix declared them. */
export type SystemMailers = {
  /** Null: the export does not say. */
  smartd: boolean | null
  zed: boolean | null
  /** The units whose failure mails (fleet.monitoredJobs, `email = true`), sorted. */
  onFailure: string[]
}

export type RelayData = {
  /** How far back the log goes, in days. */
  windowDays: number
  relay: MailRelay
  /** Every delivery in the window. Null: Loki did not answer. */
  log: RelayLog | null
  days: RelayDay[]
  callers: RelayCaller[]
  system: SystemMailers
  own: OwnMailers
}

/** The window's days and its callers, from its deliveries. Pure. */
export function relayStats(
  deliveries: RelayDelivery[],
  now: number,
): { days: RelayDay[]; callers: RelayCaller[] } {
  const days: RelayDay[] = Array.from({ length: RELAY_WINDOW_DAYS }, (_, i) => ({
    day: localDay(now - (RELAY_WINDOW_DAYS - 1 - i) * 86_400_000),
    sent: 0,
    failed: 0,
  }))
  const byDay = new Map(days.map((d) => [d.day, d]))
  const callers = new Map<string, RelayCaller>()
  for (const d of deliveries) {
    const day = byDay.get(localDay(d.at))
    if (day !== undefined) {
      if (d.ok) day.sent += 1
      else day.failed += 1
    }
    const c = callers.get(d.unit) ?? {
      unit: d.unit,
      about: d.about,
      sent: 0,
      failed: 0,
      lastAt: d.at,
    }
    if (d.ok) c.sent += 1
    else c.failed += 1
    c.lastAt = Math.max(c.lastAt, d.at)
    callers.set(d.unit, c)
  }
  return {
    days,
    callers: [...callers.values()].sort(
      (a, b) => b.sent + b.failed - (a.sent + a.failed) || b.lastAt - a.lastAt,
    ),
  }
}

export async function loadRelay(ctx: Ctx): Promise<RelayData> {
  const [relay, log, jobs, own] = await Promise.all([
    loadMailRelay(ctx),
    loadRelayLog(ctx),
    monitoredJobsList(),
    loadOwnMailers(ctx),
  ])
  const stats = relayStats(log?.deliveries ?? [], Date.now())
  return {
    windowDays: RELAY_WINDOW_DAYS,
    relay,
    log,
    days: log === null ? [] : stats.days,
    callers: stats.callers,
    system: {
      smartd: relay.identity?.notifiers.smartd ?? null,
      zed: relay.identity?.notifiers.zed ?? null,
      onFailure: jobs
        .filter((j) => j.email)
        .map((j) => j.unit)
        .sort(),
    },
    own,
  }
}
