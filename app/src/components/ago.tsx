import { ago, until } from '../lib/format'
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
