import type { Ctx } from '../../core/ctx'
import { type MailIdentity, siteMail } from '../../host/contract/domains/site'
import type { LokiStream } from '../../host/loki'
import { swrValue } from '../cache'

// The box's outbound mail relay, read back from what it logged.
//
// A reader two pages share and neither owns: Monitoring › Alerts, because
// every alert path ends at this relay, and Email, because it is how mail
// leaves the box. Each draws its own board from the one reading.
//
// A dead relay password makes the box QUIETER, not louder: the relay failing
// produces no alert about itself, because the notice would travel the path
// that just broke. Only msmtp's sends are counted (OnFailure units, smartd,
// anything using sendmail); Grafana's own alerts go to the relay through its
// built-in SMTP client and never reach this log. `lastSend` age is a neutral
// fact — on a healthy box alerts are rare, so weeks of silence is normal.
// Only `failures`, observed delivery errors, is bad news.

/** The whole history Loki will answer for: it refuses a range much past thirty days. */
export const RELAY_WINDOW_DAYS = 30

export type RelayFailure = { agoSeconds: number; unit: string; error: string }

export type MailRelay = {
  /** sender → alertTo and the relay host, from /export/site.json. Null = export missing. */
  identity: MailIdentity | null
  /** Newest successful SMTP handoff, and which unit had news. */
  lastSend: { agoSeconds: number; unit: string; recipients: string | null } | null
  /** Delivery attempts in the window. Null = Loki unreachable, NOT zero. */
  sent30d: number | null
  failed30d: number | null
  /** Newest first, capped — the drill-down behind failed30d. */
  failures: RelayFailure[]
  /**
   * A failure newer than the newest success: the relay may be broken right
   * now. Failures it has since recovered from are history, worth listing but
   * not a headline.
   */
  failing: boolean
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

/**
 * Comfortably past a real month of alert mail (~70 lines); at the cap the
 * two counts become lower bounds, which for "did anything fail" still reads
 * the right way.
 */
const MAIL_LIMIT = 200

/** Failures kept for the drill-down. */
const FAILURES_KEPT = 12

/**
 * One query, cached: a line filter over every stream for thirty days is a
 * multi-gigabyte scan Loki takes seconds over. Five minutes of staleness is
 * free on a board about a month of history; the two-clock cache keeps
 * serving the last good answer through a slow spell instead of hammering a
 * busy Loki (`null` = unreachable, so stale-serving applies).
 */
let cachedAttempts: (() => Promise<LokiStream[] | null>) | null = null
// Built on first use, because the Loki client arrives with the ctx and a
// module-level constant has none; the process has one Loki, so one cache.
const attempts = (ctx: Pick<Ctx, 'loki'>) => {
  cachedAttempts ??= swrValue({ ttlMs: 5 * 60_000, retryMs: 60_000 }, () =>
    ctx.loki.streamsOrNull(MSMTP_LINE, {
      minutes: RELAY_WINDOW_DAYS * 24 * 60,
      limit: MAIL_LIMIT,
    }),
  )
  return cachedAttempts()
}

/**
 * What the relay's lines say, at `now`. Pure: the reading below is this over
 * the cached query.
 */
export function relayDeliveries(
  streams: LokiStream[] | null,
  now: number,
): Omit<MailRelay, 'identity'> {
  if (streams === null) {
    // Loki did not answer — which on a board about silence must not be
    // allowed to render as a quiet month.
    return { lastSend: null, sent30d: null, failed30d: null, failures: [], failing: false }
  }

  const lines = streams
    .flatMap((s) =>
      s.values.map(([ns, line]) => ({
        agoSeconds: (now - Number(ns) / 1e6) / 1000,
        unit: s.stream.unit ?? '?',
        line,
      })),
    )
    .sort((a, b) => a.agoSeconds - b.agoSeconds)

  const ok = lines.filter((a) => a.line.includes('exitcode=EX_OK'))
  const failed = lines.filter((a) => !a.line.includes('exitcode=EX_OK'))
  const newest = ok[0]
  const newestFailure = failed[0]

  return {
    failing:
      newestFailure !== undefined &&
      (newest === undefined || newestFailure.agoSeconds < newest.agoSeconds),
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
    failures: failed.slice(0, FAILURES_KEPT).map((f) => ({
      agoSeconds: f.agoSeconds,
      unit: f.unit,
      // The message inside the quotes is the whole diagnosis ("cannot
      // connect…", "authentication failed…"); the rest of the line is the
      // same key=value preamble every send carries.
      error: /errormsg='([^']*)'?/.exec(f.line)?.[1] ?? f.line,
    })),
  }
}

export async function loadMailRelay(ctx: Pick<Ctx, 'loki'>): Promise<MailRelay> {
  const [identity, streams] = await Promise.all([siteMail(), attempts(ctx)])
  return { identity, ...relayDeliveries(streams, Date.now()) }
}
