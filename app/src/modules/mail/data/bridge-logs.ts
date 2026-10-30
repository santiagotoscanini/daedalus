import type { Ctx } from '../../../core/ctx'
import type { LokiStream } from '../../../host/loki'

// Proton Mail Bridge's own warnings and errors, read back from Loki over the
// last day.
//
// Bridge logs through logrus's text formatter with colour on, so a line
// arrives as `\e[33mWARN\e[0m[Oct 30 10:44:53.336] Message   key="value" …`
// and alloy's level label reads it as `unknown`: the level is parsed here,
// from the line. Lines are grouped by level and message, so a warning Bridge
// repeats every few minutes is one row with a count rather than a screenful.
//
// One message is routine and says so: go-proton-api logs a `401` with
// `Invalid access token` (a warning, then an error) when the session token it
// holds has expired, then refreshes it and retries — about every half hour on
// a healthy account. `failed to refresh auth` is the one that is not: the
// session was revoked and the account must sign in again.

const LOG_WINDOW_HOURS = 24

/** Comfortably past a day of a healthy Bridge (a few hundred lines); at the cap the counts are lower bounds. */
const LOG_LIMIT = 2000

const LINES = '{stack="proton-bridge"} |~ `(WARN|ERRO|FATA|PANI)\\S*\\[`'

export type LogLevel = 'warn' | 'error'

/** What a group of lines means for whoever reads it. */
export type LogVerdict = 'routine' | 'sign-in' | null

export type BridgeLogGroup = {
  level: LogLevel
  message: string
  /** The newest line's `error` field, when it carries one: usually the whole diagnosis. */
  detail: string | null
  count: number
  /** Milliseconds since the epoch, of the newest line. */
  lastAt: number
  verdict: LogVerdict
}

export type BridgeLogs = {
  /** How far back the lines go. */
  windowHours: number
  /** Lines in the window, routine ones apart. */
  warnings: number
  errors: number
  routine: number
  /** Newest first. */
  groups: BridgeLogGroup[]
  /** The window held more lines than one read returns: the counts are lower bounds. */
  capped: boolean
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: the escape is what is being removed
const ANSI = /\u001b\[[0-9;]*m/g
const HEAD = /^(WARN|WARNING|ERRO|ERROR|FATA|FATAL|PANI|PANIC)\[[^\]]*\]\s*(.*)$/
/** The first `key=` after the message: logrus pads the message, then writes its fields. */
const FIELDS_AT = /\s+(?=[A-Za-z_][\w.]*=)/
const FIELD = /([A-Za-z_][\w.]*)=("(?:[^"\\]|\\.)*"|\S+)/g

const unquote = (v: string): string => {
  if (!v.startsWith('"')) return v
  try {
    return String(JSON.parse(v))
  } catch {
    return v.slice(1, -1)
  }
}

export type BridgeLogLine = { level: LogLevel; message: string; fields: Record<string, string> }

/** One logrus line, or null for a line that is not a warning or worse. */
export function parseBridgeLine(raw: string): BridgeLogLine | null {
  const m = HEAD.exec(raw.replace(ANSI, '').trim())
  if (m === null) return null
  const rest = m[2] ?? ''
  const cut = FIELDS_AT.exec(rest)
  const message = (cut === null ? rest : rest.slice(0, cut.index)).trim()
  const fields: Record<string, string> = {}
  const tail = cut === null ? '' : rest.slice(cut.index)
  for (const f of tail.matchAll(FIELD)) {
    if (f[1] !== undefined && f[2] !== undefined) fields[f[1]] = unquote(f[2])
  }
  return { level: m[1]?.startsWith('WARN') === true ? 'warn' : 'error', message, fields }
}

/** Whether a line is the half-hourly token refresh, the revoked session, or neither. */
export function verdictOf(line: BridgeLogLine): LogVerdict {
  const all = `${line.message} ${Object.values(line.fields).join(' ')}`
  if (/failed to refresh auth/i.test(all)) return 'sign-in'
  if (/\b401\b/.test(all) && /invalid access token/i.test(all)) return 'routine'
  return null
}

/** The lines in `streams`, counted and grouped. Pure. */
export function bridgeLogs(streams: LokiStream[]): BridgeLogs {
  const groups = new Map<string, BridgeLogGroup>()
  let warnings = 0
  let errors = 0
  let routine = 0
  let lines = 0
  for (const s of streams) {
    for (const [ns, raw] of s.values) {
      lines += 1
      const line = parseBridgeLine(raw)
      if (line === null) continue
      const at = Number(ns) / 1e6
      const verdict = verdictOf(line)
      if (verdict === 'routine') routine += 1
      else if (line.level === 'warn') warnings += 1
      else errors += 1
      const key = `${line.level} ${line.message}`
      const g = groups.get(key)
      const detail = line.fields.error ?? null
      if (g === undefined) {
        groups.set(key, {
          level: line.level,
          message: line.message,
          detail,
          count: 1,
          lastAt: at,
          verdict,
        })
      } else {
        g.count += 1
        if (at > g.lastAt) {
          g.lastAt = at
          g.detail = detail
        }
        // One revoked-session line makes the whole group the alarming one.
        if (verdict === 'sign-in') g.verdict = 'sign-in'
      }
    }
  }
  return {
    windowHours: LOG_WINDOW_HOURS,
    warnings,
    errors,
    routine,
    groups: [...groups.values()].sort((a, b) => b.lastAt - a.lastAt),
    capped: lines >= LOG_LIMIT,
  }
}

/** The last day of Bridge's warnings and errors. Null: Loki did not answer. */
export async function loadBridgeLogs(ctx: Pick<Ctx, 'loki'>): Promise<BridgeLogs | null> {
  const streams = await ctx.loki.streamsOrNull(LINES, {
    minutes: LOG_WINDOW_HOURS * 60,
    limit: LOG_LIMIT,
  })
  return streams === null ? null : bridgeLogs(streams)
}
