import { ago, DASH, until } from '../lib/format'
import { useNow } from './poll'

// A moment relative to now, rendered without a hydration mismatch.
//
// The server renders against its own clock, and the browser's first render
// — which must produce the same text — has only a different one. So the
// first render keeps whatever the server wrote (`suppressHydrationWarning`
// covers this one text node and nothing under it), and `useNow` re-renders
// once mounted with the browser's clock. Only a unit boundary crossed between
// the two (a "44s" that became "1 min") changes on screen.
//
// For text a string must carry (a title, a joined list), call
// `ago(iso, now)` with `useNow`'s clock instead.

type Moment = string | number | null | undefined

const iso = (at: Moment): string | null | undefined =>
  typeof at !== 'number' ? at : Number.isFinite(at) ? new Date(at).toISOString() : null

/** "3h ago" for a moment in the past; the string itself if it does not parse. */
export function Ago({ at }: { at: Moment }) {
  const now = useNow(false)
  return (
    <time dateTime={iso(at) ?? undefined} suppressHydrationWarning>
      {ago(iso(at), now ?? Date.now())}
    </time>
  )
}

/**
 * A moment absolutely and relatively at once — "2026-09-30 14:22 · 3h ago".
 * Absolute first: "3d ago" alone is useless when you are trying to correlate
 * a deploy with something else that happened. The absolute half is UTC, so
 * the server and the browser write the same characters.
 */
export function When({ at }: { at: string }) {
  const t = Date.parse(at)
  if (!Number.isFinite(t)) return DASH
  return (
    <>
      {new Date(t).toISOString().slice(0, 16).replace('T', ' ')} · <Ago at={at} />
    </>
  )
}

/** A countdown to a moment, in `until`'s words. */
export function Until({ at }: { at: Moment }) {
  const now = useNow(false)
  const t = typeof at === 'number' ? at : at == null ? Number.NaN : Date.parse(at)
  return (
    <time dateTime={iso(at) ?? undefined} suppressHydrationWarning>
      {until((t - (now ?? Date.now())) / 1000)}
    </time>
  )
}

/** "Sep 30, 02:05 PM": a moment by the viewer's wall clock, once mounted. */
export const DAY_TIME: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
}
/** "Sep 30". */
export const DAY: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }

/**
 * A moment as the viewer's wall clock reads it. The server renders it in the
 * box's timezone, the browser re-renders it in its own once mounted; the
 * locale is fixed, so only a timezone the two disagree on changes anything.
 */
export function LocalTime({ at, opts }: { at: Moment; opts: Intl.DateTimeFormatOptions }) {
  useNow(false)
  const d = new Date(typeof at === 'string' ? Date.parse(at) : (at ?? Number.NaN))
  return (
    <time dateTime={iso(at) ?? undefined} suppressHydrationWarning>
      {Number.isNaN(d.getTime()) ? DASH : d.toLocaleString('en-US', opts)}
    </time>
  )
}
