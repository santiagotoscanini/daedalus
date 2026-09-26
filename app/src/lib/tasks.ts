// The pure half of the scheduled-tasks contract: what an id may be, and what
// the two schedule presets expand to.
//
// Pure, and in `lib/` rather than `lib/apps/`, because three different places
// need the same answers and one of them is the browser: the seam validates a
// run request with `taskId`, the exporter and the importer normalise with
// these rules, and the Tasks tab renders `describeSchedule` next to the raw
// OnCalendar string. A second copy of the minute derivation anywhere would be
// a task whose UI says :23 and whose timer fires at :41.
//
// ── why the app expands the presets, and nix never does ───────────────────
//
// site/apps.json carries a CONCRETE systemd `OnCalendar` string. Nix reads it
// and does no arithmetic — JSON in, system out, which is the whole platform
// architecture — and the UI can therefore show the exact minute a task will
// run, which it could not if nix derived one privately.

/**
 * An app task's id.
 *
 * Deliberately narrower than it looks like it needs to be. The id becomes part
 * of `app-<app>-task-<id>.service`, a systemd unit that ROOT starts on a
 * timer, so the charset is a security control rather than tidiness: no dots
 * (systemd unit-name separator), no slashes, no whitespace, nothing that could
 * turn one unit name into two.
 */
const TASK_ID = /^[a-z0-9][a-z0-9-]{0,39}$/

export function isTaskId(v: unknown): v is string {
  return typeof v === 'string' && TASK_ID.test(v)
}

/** `isTaskId` as a parser, for the request boundaries that must refuse. */
export function taskId(v: unknown): string {
  if (!isTaskId(v)) throw new Error('expected a task id')
  return v
}

/** An operator-facing reason the id is unusable, or null. */
export function taskIdError(id: string, taken: readonly string[] = []): string | null {
  const t = id.trim().toLowerCase()
  if (t === '') return 'pick an id first.'
  if (taken.includes(t)) return `${t} is already a task on this app.`
  if (!TASK_ID.test(t)) {
    return 'may use lowercase letters, digits and inner hyphens only, up to 40 characters. It becomes part of a systemd unit name that root starts on a timer, which is why the charset is this narrow.'
  }
  return null
}

/**
 * systemd's calendar shorthands, every one of which fires exactly on the hour
 * (`minutely` fires on every :00 second, which is the same trap sixty times
 * over). Refused everywhere a schedule is accepted — see `taskScheduleError`.
 *
 * The same list stacks/apps/apps.nix asserts against. That assertion fires
 * mid-Apply, after the commit, so it costs a revert; these functions are how
 * the same answer arrives before anything is written.
 */
const SHORTHANDS = [
  'minutely',
  'hourly',
  'daily',
  'weekly',
  'monthly',
  'quarterly',
  'semiannually',
  'yearly',
  'annually',
] as const

function isShorthandSchedule(v: string): boolean {
  return (SHORTHANDS as readonly string[]).includes(v.trim().toLowerCase())
}

/**
 * An operator-facing reason the schedule is unusable, or null.
 *
 * The shorthand refusal is the one rule here that is not obvious, and it is a
 * scar: `hourly` and `daily` both elapse at :00, which is when myspeed's
 * speedtest saturates the uplink and takes house-wide DNS down for a minute or
 * two. A job that lands there resolves nothing and can still report success —
 * exactly how the RSS digest failed silently for three days.
 */
export function taskScheduleError(schedule: string): string | null {
  const s = schedule.trim()
  if (s === '') {
    return 'pick a schedule first: a concrete systemd OnCalendar, e.g. “*-*-* 04:23:00”.'
  }
  if (isShorthandSchedule(s)) {
    return `“${s}” is a systemd shorthand, which fires exactly on the hour — the minute myspeed’s speedtest takes house-wide DNS down for a couple of minutes, where a starved run can still report success. Write a concrete OnCalendar whose minute is not :00, or use a preset.`
  }
  return null
}

/**
 * An operator-facing reason the argv is unusable, or null.
 *
 * argv, never a shell string: the generated unit runs `podman exec app-<name>
 * <argv>` with no shell between, so an empty element is a literal empty
 * argument handed to the program rather than whitespace that disappears.
 */
export function taskCommandError(command: readonly string[]): string | null {
  if (command.length === 0) {
    return 'give it something to run: the argv, one argument per box, e.g. node · scripts/digest.mjs.'
  }
  const blank = command.findIndex((a) => a.trim() === '')
  if (blank !== -1) {
    return `argument ${String(blank + 1)} is empty — every argument is passed through verbatim, so an empty one is an empty string the program receives, not a space.`
  }
  return null
}

/** An operator-facing reason the timeout is unusable, or null. */
export function taskTimeoutError(seconds: number): string | null {
  if (!Number.isInteger(seconds) || seconds <= 0) {
    return 'must be a whole number of seconds above zero. It becomes TimeoutStartSec on the generated unit, where 0 means no timeout at all and a hung run would hold the unit active forever.'
  }
  return null
}

/**
 * The platform default, mirrored from the `timeoutSec` option in
 * stacks/apps/apps.nix. Here rather than in host/nix-manifest.ts (where it
 * used to be) because the editor needs it too, and a component may not import
 * a host module — host/ reads it from here now, so there is one number.
 */
export const DEFAULT_TASK_TIMEOUT_SEC = 900

/** The presets the UI offers. Anything else is a hand-written OnCalendar. */
const SCHEDULE_PRESETS = ['hourly', 'daily'] as const
export type SchedulePreset = (typeof SCHEDULE_PRESETS)[number]

/**
 * The minute of the hour this app's scheduled work runs at: stable for a given
 * name, 1..59, and NEVER 0.
 *
 * Never 0 is the whole point, and it is a scar rather than a preference.
 * myspeed runs its speedtest at :00:00, which saturates the uplink and takes
 * house-wide DNS down with it for a couple of minutes; a job that lands there
 * fails to resolve anything and can still report success — that is exactly how
 * the RSS digest failed silently for three days. So the range starts at 1.
 *
 * Derived from the name rather than random so the same app keeps its slot
 * across edits, re-syncs and a fresh bootstrap (a random minute would move on
 * every Apply and show as drift), and hashed rather than assigned in order so
 * two apps added the same afternoon do not land on the same minute.
 *
 * FNV-1a, 32-bit, because it is four lines and its avalanche is good enough to
 * spread a handful of short lowercase labels across 59 buckets. Nothing here
 * is a security boundary.
 */
export function taskMinute(appName: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < appName.length; i += 1) {
    h ^= appName.charCodeAt(i)
    // >>> 0 after each step: JS bitwise ops are signed 32-bit, and the
    // multiply below overflows into the sign bit on the second character.
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return 1 + (h % 59)
}

/** Daily work runs in the small hours, on the app's own minute. */
const DAILY_HOUR = 4

/**
 * A preset as the concrete `OnCalendar` string that goes into site/apps.json.
 *
 * `hourly` → `*:<mm>:00`, `daily` → `*-*-* 04:<mm>:00` — systemd's own
 * calendar syntax, which `systemd-analyze calendar` will echo back unchanged.
 */
export function expandSchedule(preset: SchedulePreset, appName: string): string {
  const mm = String(taskMinute(appName)).padStart(2, '0')
  return preset === 'hourly'
    ? `*:${mm}:00`
    : `*-*-* ${String(DAILY_HOUR).padStart(2, '0')}:${mm}:00`
}

/**
 * The schedule as a sentence, for the line above the raw string.
 *
 * Only the two shapes this app generates are read back; anything else is an
 * OnCalendar somebody wrote by hand and is shown as itself rather than
 * guessed at. A wrong sentence about when a job runs is worse than no
 * sentence, and this is not a systemd calendar parser.
 */
export function describeSchedule(onCalendar: string): string {
  const hourly = /^\*:([0-5]\d):00$/.exec(onCalendar)
  if (hourly) return `Every hour, at :${hourly[1] as string}`

  const daily = /^\*-\*-\* ([0-2]\d):([0-5]\d):00$/.exec(onCalendar)
  if (daily) return `Every day, at ${daily[1] as string}:${daily[2] as string}`

  return 'On a custom systemd calendar'
}

/** The unit pair a task generates. One name, spelled in one place. */
export function taskUnitName(appName: string, id: string): string {
  return `app-${appName}-task-${id}`
}
