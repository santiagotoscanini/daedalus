// What the error summary does not count: lines that say "error" and are not one.
//
// A count that is mostly noise gets ignored, and then it misses the line that
// matters. Each entry was read and judged on a real box; the log audit's
// baseline says why. Patterns are RE2, for a LogQL line filter.

/** A line worth counting. */
export const ERROR_LINE = String.raw`(?i)(\berror\b|\bfatal\b|\bpanic\b|\bexception\b|traceback|\bcritical\b)`

/** Lines that match that and say nothing is wrong. */
export const NOISE: readonly string[] = [
  String.raw`errors=0`,
  String.raw`\berror_code=not_signed_in\b`,
  String.raw`"level":"info"`,
  String.raw`level=info`,
  String.raw`\bINF\b`,
  String.raw`Session termination failed: 202`,
  String.raw`invalid api token format`,
  String.raw`permission denied to vacuum`,
  String.raw`client denied by server configuration`,
  String.raw`Fontconfig error`,
  String.raw`0 failure`,
  String.raw`failed 0`,
  String.raw`live probe (miss|summary)`,
  String.raw`error: resource not found`,
]

/** Containers a person's messages pass through: never read, summarised or quoted. */
export const PRIVATE_CONTAINER = /^(matrix|proton)/

/** A podman-chosen name: an ad-hoc run or a session's sidecar, not a service. */
export const ADHOC_CONTAINER = /^[a-z]+_[a-z]+$/

/** The LogQL selecting real error lines of every container, private ones aside. */
export const errorLogQl = (quote: (s: string) => string): string =>
  `{container=~".+",container!~"(matrix|proton).*"} |~ ${quote(ERROR_LINE)} !~ ${quote(NOISE.join('|'))}`

/** A line with what changes between repeats taken out, so repeats collapse. */
export const lineShape = (line: string): string =>
  line
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI colour codes, by definition.
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\d{4}-\d{2}-\d{2}[T ][\d:.,+Z-]*/g, '')
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27}\b/g, '<id>')
    .replace(/\b[0-9a-f]{12,}\b/g, '<id>')
    .trim()
    .slice(0, 220)

/**
 * How far back each daily reset in the last `hours` ended, in seconds. The box's
 * network restarts at a set time every night, so what fails inside those few
 * minutes is expected. Empty for a blank or unreadable time.
 */
export function resetOffsets(now: Date, at: string, hours: number, minutes: number): number[] {
  const m = /^(\d{1,2}):(\d{2})$/.exec(at.trim())
  if (m === null) return []
  const out: number[] = []
  for (let day = 0; day <= Math.ceil(hours / 24); day++) {
    const end = new Date(now)
    end.setDate(end.getDate() - day)
    end.setHours(Number(m[1]), Number(m[2]) + minutes, 0, 0)
    const ago = (now.getTime() - end.getTime()) / 1000
    if (ago >= 0 && ago + minutes * 60 <= hours * 3600) out.push(Math.floor(ago))
  }
  return out
}
