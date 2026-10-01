import { type ReactNode, useId } from 'react'
import { cn } from '../lib/cn'
import { GHOST_BTN } from './apps/shared'
import { INPUT_MONO, MONO } from './tokens'
import { Button, type buttonVariants } from './ui/button'
import { Input } from './ui/input'

// The second half of every two-step button (the first is `useArmed`): what the
// press costs, then Confirm, Cancel, and how long until it disarms itself. The
// caller owns the armed flag and what shows while it is down, because that
// half differs everywhere — a state line, a status, a row's own verb.

/** How long an armed control stays armed unless the caller says otherwise.
    Short enough that a control left armed by a distraction cannot be finished
    by a stray click later. */
export const ARM_MS = 10_000

/* The look of a control at a board's foot, armed or not: quiet at rest, and
   the cost — and the red — appear only once it is armed, which is the step
   where they can still change the answer. */
export const RESTART =
  'mt-[0.7rem] flex flex-col items-start gap-[0.55rem] border-(--border-soft) border-t pt-[0.75rem]'
export const RESTART_ARMED = 'border-t-[color-mix(in_srgb,var(--danger)_40%,var(--border-soft))]'
export const RESTART_COST = 'text-[0.78rem] text-(--text-muted) leading-[1.5]'
export const RESTART_STATE = 'text-[0.78rem] leading-[1.5]'
export const RESTART_NOTE = 'text-[0.7rem] text-muted-foreground leading-[1.5]'

type Variant = NonNullable<Parameters<typeof buttonVariants>[0]>['variant']

export function ArmedConfirm({
  cost,
  confirm,
  onConfirm,
  onCancel,
  ms = ARM_MS,
  variant = 'destructive',
  disabled = false,
  children,
  className = cn(RESTART, RESTART_ARMED),
  costClassName = RESTART_COST,
  noteClassName = RESTART_NOTE,
}: {
  /** What the press costs, said before it can be pressed. */
  cost: ReactNode
  /** The confirm button's label. */
  confirm: ReactNode
  onConfirm: () => void
  onCancel: () => void
  /** The window the caller armed with, for the "disarms" note. */
  ms?: number
  variant?: Variant
  disabled?: boolean
  /** Anything to choose between the cost and the buttons (a picker). */
  children?: ReactNode
  className?: string
  costClassName?: string
  noteClassName?: string
}) {
  return (
    <div className={className}>
      <p className={costClassName}>{cost}</p>
      {children}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant={variant} size="sm" disabled={disabled} onClick={onConfirm}>
          {confirm}
        </Button>
        <Button type="button" variant="outline" size="sm" className={GHOST_BTN} onClick={onCancel}>
          Cancel
        </Button>
        <span className={noteClassName}>disarms on its own in {ms / 1000}s</span>
      </div>
    </div>
  )
}

/**
 * "Type <name> to confirm": the step in front of a press that cannot be taken
 * back. The caller holds the text and compares it, since what it gates is
 * the caller's own button.
 */
export function TypedConfirm({
  name,
  value,
  onChange,
  disabled,
  className,
  inputClassName,
}: {
  name: string
  value: string
  onChange: (v: string) => void
  disabled?: boolean
  className?: string
  inputClassName?: string
}) {
  const id = useId()
  return (
    <label
      htmlFor={id}
      className={cn(
        'flex flex-wrap items-center gap-[0.5rem] text-[0.74rem] text-muted-foreground',
        className,
      )}
    >
      <span>
        Type <span className={MONO}>{name}</span> to confirm
      </span>
      <Input
        id={id}
        className={cn(INPUT_MONO, 'w-[10rem]', inputClassName)}
        value={value}
        disabled={disabled}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => {
          onChange(e.target.value)
        }}
      />
    </label>
  )
}
