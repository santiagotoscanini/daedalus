import type { Ctx } from '../../core/ctx'
import { type MailIdentity, siteMail } from '../../host/contract/domains/site'
import type { LokiStream } from '../../host/loki'
import { swrValue } from '../cache'

// The box's outbound mail relay, read back from what it logged.
//
// A reader two pages share and neither owns: Monitoring › Alerts, because
// every alert path ends at this relay, and Email, because it is how mail
// leaves the box. Each draws its own boards from the one reading: Alerts the
// summary (`loadMailRelay`), Email every delivery as well (`loadRelayLog`).
//
// A dead relay password makes the box QUIETER, not louder: the relay failing
// produces no alert about itself, because the notice would travel the path
// that just broke. Only msmtp's sends are here (OnFailure units, smartd,
// anything using sendmail); Grafana and healthchecks talk SMTP themselves and
// never reach this log. `lastSend` age is a neutral fact — on a healthy box
// alerts are rare, so weeks of silence is normal. Only `failures`, observed
// delivery errors, is bad news.

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

/** One attempt, as msmtp's syslog line and journald's unit label describe it. */
export type RelayDelivery = {
  /** Milliseconds since the epoch. */
  at: number
  /** The unit msmtp ran inside: whoever had something to say. */
  unit: string
  /**
   * For a `notify-email@<unit>.service` send, the unit whose failure the mail
   * reported (`<unit>`): what the mail was about.
   */
  about: string | null
  recipients: string[]
  /** `mailsize`: the message as handed to the relay. Absent on a failure before DATA. */
  bytes: number | null
  /** The relay's last SMTP reply: `250`, and its text (the provider's queue id rides it). */
  smtpStatus: number | null
  smtpMessage: string | null
  /** sysexits name: EX_OK, EX_TEMPFAIL, EX_NOPERM… */
  exitCode: string
  ok: boolean
  /** msmtp's own diagnosis (`errormsg`), on a failure. */
  error: string | null
}

export type RelayLog = {
  /** Every attempt in the window, newest first. */
  deliveries: RelayDelivery[]
  /** The window held more lines than one read returns: counts are lower bounds. */
  capped: boolean
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
 * Far past a real month of the box's mail (~60–70 lines); at the cap the
 * counts become lower bounds and say so (`capped`).
 */
const MAIL_LIMIT = 1000

/** Failures kept for Monitoring's drill-down. */
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

/** The keys msmtp writes, in the order it writes them. */
const KEY_AT =
  /(?:^|\s)(host|tls|auth|user|from|recipients|mailsize|smtpstatus|smtpmsg|errormsg|exitcode)=/g

/**
 * A line's `key=value` fields. A quoted value runs to the next key rather
 * than to the next quote: msmtp does not escape a quote inside `smtpmsg` or
 * `errormsg`, so the key that follows is the only reliable end.
 */
export function msmtpFields(line: string): Record<string, string> {
  const marks = [...line.matchAll(KEY_AT)]
  const out: Record<string, string> = {}
  marks.forEach((m, i) => {
    const start = m.index + m[0].length
    const end = marks[i + 1]?.index ?? line.length
    const raw = line.slice(start, end).trim()
    const key = m[1]
    if (key === undefined) return
    out[key] = raw.startsWith("'")
      ? raw.slice(1, raw.length > 1 && raw.endsWith("'") ? -1 : undefined)
      : raw
  })
  return out
}

const NOTIFY = /^notify-email@(.+)\.service$/

const intOrNull = (v: string | undefined): number | null => {
  const n = v === undefined ? Number.NaN : Number(v)
  return Number.isInteger(n) ? n : null
}

/** Every attempt in `streams`, newest first. Pure: the reading below is this over the cached query. */
export function parseDeliveries(streams: LokiStream[]): RelayDelivery[] {
  return streams
    .flatMap((s) =>
      s.values.map(([ns, line]): RelayDelivery => {
        const f = msmtpFields(line)
        const unit = s.stream.unit ?? '?'
        const exitCode = f.exitcode ?? ''
        const ok = exitCode === 'EX_OK'
        return {
          at: Number(ns) / 1e6,
          unit,
          about: NOTIFY.exec(unit)?.[1] ?? null,
          recipients: (f.recipients ?? '').split(',').filter((r) => r !== ''),
          bytes: intOrNull(f.mailsize),
          smtpStatus: intOrNull(f.smtpstatus),
          smtpMessage: f.smtpmsg ?? null,
          exitCode,
          ok,
          // The message inside the quotes is the whole diagnosis ("cannot
          // connect…", "authentication failed…"); a failure that carries none
          // keeps its line, which is then the only diagnosis there is.
          error: ok ? null : (f.errormsg ?? line),
        }
      }),
    )
    .sort((a, b) => b.at - a.at)
}

/** What the relay's lines say, at `now`. Pure. */
export function relayDeliveries(
  streams: LokiStream[] | null,
  now: number,
): Omit<MailRelay, 'identity'> {
  if (streams === null) {
    // Loki did not answer — which on a board about silence must not be
    // allowed to render as a quiet month.
    return { lastSend: null, sent30d: null, failed30d: null, failures: [], failing: false }
  }

  const all = parseDeliveries(streams)
  const ok = all.filter((d) => d.ok)
  const failed = all.filter((d) => !d.ok)
  const newest = ok[0]
  const newestFailure = failed[0]
  const agoSeconds = (d: RelayDelivery) => (now - d.at) / 1000

  return {
    failing: newestFailure !== undefined && (newest === undefined || newestFailure.at > newest.at),
    lastSend:
      newest === undefined
        ? null
        : {
            agoSeconds: agoSeconds(newest),
            unit: newest.unit,
            recipients: newest.recipients.length === 0 ? null : newest.recipients.join(','),
          },
    sent30d: ok.length,
    failed30d: failed.length,
    failures: failed.slice(0, FAILURES_KEPT).map((f) => ({
      agoSeconds: agoSeconds(f),
      unit: f.unit,
      error: f.error ?? '',
    })),
  }
}

export async function loadMailRelay(ctx: Pick<Ctx, 'loki'>): Promise<MailRelay> {
  const [identity, streams] = await Promise.all([siteMail(), attempts(ctx)])
  return { identity, ...relayDeliveries(streams, Date.now()) }
}

/** Every attempt in the window. Null: Loki did not answer. */
export async function loadRelayLog(ctx: Pick<Ctx, 'loki'>): Promise<RelayLog | null> {
  const streams = await attempts(ctx)
  if (streams === null) return null
  const deliveries = parseDeliveries(streams)
  return { deliveries, capped: deliveries.length >= MAIL_LIMIT }
}
