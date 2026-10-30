// Columns: a daily series as bars, failures drawn as the foot of the same bar (rules in ./index.ts).
import { num } from '../../lib/format'
import { type Tone, toneStyle } from '../../lib/tone'
import { EMPTY } from '../tokens'

export type Column = {
  label: string
  value: number
  /** The tooltip's reading. Without one it is the value, and the failures when there are any. */
  display?: string
  /**
   * How much of `value` failed, in the same unit: drawn as the foot of the
   * same column in the bad tone, so the column is still as tall as its total
   * and a day's failures read as a share of that day.
   *
   * At the foot because that is where they compare: every column's failures
   * start on the one baseline, so a worse day is a taller red segment, which a
   * segment riding on columns of different heights would not show. A failure
   * is never thinner than 2px, so one failed run in a busy day is still seen.
   */
  failed?: number
}

/** What a column's tooltip says: the caller's reading, or the value and its failures. */
function columnText(p: Column, failed: number): string {
  if (p.display !== undefined) return p.display
  const total = p.value.toLocaleString('en-US')
  return failed > 0 ? `${total} · ${num(failed)} failed` : total
}

/**
 * A time series as columns — for daily buckets, where the gaps between bars
 * carry meaning (one bar = one day) and a continuous line would imply the
 * values in between were measured.
 */
export function Columns({
  points,
  tone = 'muted',
  height = 84,
  empty = 'no data',
}: {
  points: Column[]
  tone?: Tone
  height?: number
  empty?: string
}) {
  if (points.length === 0) return <p className={EMPTY}>{empty}</p>
  const max = Math.max(...points.map((p) => p.value), 0.0001)

  return (
    <div className="flex w-full items-end gap-[2px]" style={toneStyle(tone, { height })}>
      {points.map((p, i) => {
        const failed = Math.min(Math.max(p.failed ?? 0, 0), p.value)
        return (
          <div
            key={`${p.label}-${String(i)}`}
            className="group flex h-full min-w-0 flex-1 items-end justify-center"
            title={`${p.label}: ${columnText(p, failed)}`}
          >
            <span
              // Capped and centred rather than filling its slot: a fortnight
              // across a full-width board gives each column eighty-odd pixels,
              // and a saturated block that wide reads as a filled area chart.
              // Its segments stack inside it with the same 2px gap the columns
              // keep between themselves, and the top one wears the cap.
              className="flex w-full max-w-[2.75rem] origin-bottom animate-[col-grow_550ms_cubic-bezier(0.2,0.9,0.2,1)_both] flex-col justify-end gap-[2px] overflow-hidden opacity-85 group-hover:opacity-100 motion-reduce:animate-none [&>:first-child]:rounded-t-[2px]"
              style={{
                height: `${String(Math.max(2, (p.value / max) * 100))}%`,
                // Staggered so the band fills left-to-right on load. Capped so a
                // 30-column chart does not take a second and a half to draw.
                animationDelay: `${String(Math.min(i * 18, 500))}ms`,
              }}
            >
              {failed < p.value || failed === 0 ? (
                <span className="block min-h-0 flex-1 bg-(--tone)" />
              ) : null}
              {failed > 0 && (
                <span
                  className="block min-h-[2px] flex-none bg-(--tone)"
                  style={toneStyle('bad', { height: `${String((failed / p.value) * 100)}%` })}
                />
              )}
            </span>
          </div>
        )
      })}
    </div>
  )
}
