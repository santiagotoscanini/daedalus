// The two settings controls that carry a label of their own: a capped
// slider and a labelled switch row.

import type { ReactNode } from 'react'
import { useId } from 'react'
import { cn } from '../lib/cn'
import { Switch } from './ui/switch'

/**
 * A resource ceiling.
 *
 * The minimum position means *uncapped*, not zero — a zero-core or zero-byte
 * container is not a thing you can ask for, so the bottom of the range is free
 * to carry the more useful meaning. `onChange` emits null there.
 */
export function Slider({
  label,
  hint,
  value,
  min,
  max,
  step,
  format,
  disabled,
  onChange,
}: {
  label: string
  hint?: string
  value: number | null
  min: number
  max: number
  step: number
  format: (v: number) => ReactNode
  disabled?: boolean
  onChange: (v: number | null) => void
}) {
  // Below `min` so the thumb parks left of every real value; the input's own
  // min is this sentinel, which is what lets "uncapped" be a reachable
  // position rather than a checkbox next to the slider.
  const OFF = min - step
  return (
    <div
      className={cn(
        // Stacked by default — label and value on one line, the track full
        // width underneath — and only laid out in three columns when the board
        // it sits in is wide enough for the label column to hold its hint
        // without wrapping one word per line. `board` is the query container
        // declared on `BOARD_BODY` (viz.tsx), so the shape follows the panel's
        // width rather than the viewport's.
        'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 border-hairline border-b py-3 last-of-type:border-b-0',
        '@min-[34rem]/board:grid-cols-[minmax(15rem,1fr)_minmax(10rem,1.5fr)_6.5rem] @min-[34rem]/board:gap-x-6 @min-[34rem]/board:gap-y-2',
        disabled === true && 'opacity-50',
      )}
    >
      <div className="min-w-0 text-[0.875rem] text-foreground">
        {label}
        {hint !== undefined && (
          <small className="mt-0.5 block text-[0.75rem] leading-[1.45] text-muted-foreground">
            {hint}
          </small>
        )}
      </div>
      <input
        type="range"
        className={cn(
          // Full width under the label in the stacked shape; its own column
          // once the container query has room for one.
          'col-span-full mt-1 w-full cursor-pointer bg-transparent [-webkit-appearance:none] [appearance:none] disabled:cursor-not-allowed',
          '@min-[34rem]/board:col-auto @min-[34rem]/board:mt-0',
          // Track and thumb need both vendor spellings. Each utility emits its
          // own rule, so an engine that does not know one selector drops only
          // that rule rather than the whole declaration block.
          '[&::-webkit-slider-runnable-track]:h-1 [&::-webkit-slider-runnable-track]:rounded-full [&::-webkit-slider-runnable-track]:bg-foreground/[0.1]',
          '[&::-moz-range-track]:h-1 [&::-moz-range-track]:rounded-full [&::-moz-range-track]:bg-foreground/[0.1]',
          '[&::-webkit-slider-thumb]:[-webkit-appearance:none] [&::-webkit-slider-thumb]:[appearance:none] [&::-webkit-slider-thumb]:mt-[-6px] [&::-webkit-slider-thumb]:size-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-[3px] [&::-webkit-slider-thumb]:border-card',
          '[&::-moz-range-thumb]:size-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-[3px] [&::-moz-range-thumb]:border-card',
          // At the sentinel the control is OFF, not at zero. Drawn as a solid
          // thumb on a full track it would read as a slider that failed to
          // load its value rather than as a ceiling nobody set.
          value === null
            ? '[&::-webkit-slider-thumb]:bg-card [&::-webkit-slider-thumb]:shadow-[0_0_0_1px_var(--muted-foreground)] [&::-moz-range-thumb]:bg-card [&::-moz-range-thumb]:shadow-[0_0_0_1px_var(--muted-foreground)]'
            : '[&::-webkit-slider-thumb]:bg-primary [&::-webkit-slider-thumb]:shadow-[0_0_0_1px_var(--primary)] [&::-moz-range-thumb]:bg-primary [&::-moz-range-thumb]:shadow-[0_0_0_1px_var(--primary)]',
        )}
        min={OFF}
        max={max}
        step={step}
        value={value ?? OFF}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => {
          const v = Number(e.target.value)
          onChange(v <= OFF ? null : v)
        }}
      />
      <div className="min-w-[5.5rem] text-right font-mono text-[0.875rem] tabular-nums whitespace-nowrap text-primary [&_small]:ml-1 [&_small]:text-[0.72rem] [&_small]:text-muted-foreground">
        {value === null ? (
          <span className="text-[0.8rem] text-muted-foreground">uncapped</span>
        ) : (
          format(value)
        )}
      </div>
    </div>
  )
}

export function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  hint?: string
  disabled?: boolean
}) {
  const id = useId()
  return (
    <label
      htmlFor={id}
      className={cn(
        'flex cursor-pointer items-start gap-3 border-hairline border-b py-2.5 last:border-b-0',
        disabled === true && 'cursor-not-allowed opacity-50',
      )}
    >
      <Switch
        id={id}
        className={cn(
          // The primitive's 20×36 track, refined: no outline shadow on the
          // track, a soft contact shadow under the thumb so it reads as a knob.
          'mt-px shadow-none disabled:opacity-100',
          '[&>span]:shadow-[0_1px_2px_color-mix(in_oklch,var(--overlay)_30%,transparent),0_0_0_0.5px_color-mix(in_oklch,var(--overlay)_8%,transparent)]',
        )}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
      />
      <span className="min-w-0 text-[0.875rem] leading-5 text-foreground">
        {label}
        {hint && (
          <small className="mt-0.5 block text-[0.75rem] leading-[1.45] text-muted-foreground">
            {hint}
          </small>
        )}
      </span>
    </label>
  )
}
