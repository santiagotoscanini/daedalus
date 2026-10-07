import { cn } from '../../lib/cn'
import type { fetchApp } from '../../server/registry'
import { SEGMENT_ITEM, SEGMENT_ITEM_ON, SEGMENT_TRACK } from '../tokens'

export type LoaderData = Awaited<ReturnType<typeof fetchApp>>
export type AppRecord = NonNullable<LoaderData>['app']

/* The prose faces and small shapes the app page's tab bodies share. Spelled
   once here rather than repeated across a dozen files, the way lib/tone.ts spells the
   tone utilities: they are one decision, and a copy that drifts is a tab
   whose captions are a different grey from its neighbour's.

   Whole literal strings, so Tailwind's scanner still sees every utility. */

/** The sentence under a heading, or in place of a panel the app cannot fill. */
export const LEDE = 'mt-1 mb-0 max-w-[74ch] text-[0.875rem] text-subdued'

/** The one line of prose a stat strip is allowed, directly under the numbers. */
export const STRIP_FOOT =
  '-mt-1 mb-5 max-w-[74ch] text-[0.75rem] leading-[1.5] text-muted-foreground'

/** A hairline and a sentence-case label, opening a section inside a tab body. */
export const SECTION_HEAD =
  'mt-10 mr-0 mb-3 ml-0 flex flex-wrap items-baseline gap-x-2.5 gap-y-1 border-hairline border-t pt-6 text-[0.8rem] font-[560] text-foreground'

/** The muted note beside a section head. */
export const SECTION_HEAD_SMALL = 'text-[0.78rem] font-normal text-muted-foreground'

/** The apps pages' pill shape, for `Chip`'s `className`. `Chip` is already the round
    tinted pill; this stays as the one name every apps call site passes. */
export const CHIP = 'rounded-full'

/**
 * The quiet bordered button for a secondary action, on this page and the
 * others that import it: `Button variant="outline"` in the muted ink, so it
 * reads as available but not asked for. A constant because some thirty call
 * sites spell it.
 */
export const GHOST_BTN = 'text-subdued'

/** The house segmented control at the Button's height: the apps list's filters
    and the app hero's exposure switch. `controls.tsx`'s `Segmented` is the same
    behaviour; this one is drawn with the SEGMENT_* tokens and carries the
    per-option `disabled` + `reason` the exposure rungs need. */
export function SegmentPicker<T extends string>({
  value,
  onChange,
  label,
  options,
  disabled,
  className,
}: {
  value: T
  onChange: (v: T) => void
  label: string
  options: {
    value: T
    label: string
    icon?: string
    /** A count beside the label: the filter IS the tally. */
    count?: number
    disabled?: boolean
    reason?: string
  }[]
  disabled?: boolean
  className?: string
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn(SEGMENT_TRACK, 'h-8.5 max-[40rem]:h-10', className)}
    >
      {options.map((o) => {
        const off = (disabled ?? o.disabled) === true
        return (
          // biome-ignore lint/a11y/useSemanticElements: the same trade as controls.tsx's Segmented — the role carries the radio semantics on the element that already looks and acts the part.
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={o.value === value}
            disabled={off}
            aria-disabled={off ? true : undefined}
            title={o.reason}
            className={cn(
              SEGMENT_ITEM,
              'h-full min-h-6.5 py-0 text-[0.8rem]',
              o.value === value && SEGMENT_ITEM_ON,
              off && 'cursor-not-allowed opacity-50 hover:bg-transparent',
            )}
            onClick={() => {
              onChange(o.value)
            }}
          >
            {o.icon !== undefined && <span aria-hidden="true">{o.icon}</span>}
            {o.label}
            {o.count !== undefined && (
              <span className="text-[0.75rem] text-muted-foreground tabular-nums">{o.count}</span>
            )}
          </button>
        )
      })}
    </div>
  )
}
