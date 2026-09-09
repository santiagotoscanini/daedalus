import { type ReactNode, useId } from 'react'
import { cn } from '../lib/cn'

/**
 * The house disclosure: a trigger whose explanation appears beside it on
 * hover or keyboard focus.
 *
 * CSS-only, revealed by `group-hover` and `group-focus-within`: these pages
 * stream, so a popover that needed hydration would be inert for the first
 * moment, and a keyboard has no hover. The trigger is a real <button>, which
 * is what makes it focusable without a suppressed lint.
 *
 * `title` is deliberately NOT the mechanism: it truncates, it cannot hold
 * labelled rows, and it appears after a delay long enough that nobody waits.
 *
 * The reveal lives HERE rather than in the caller's class pair, which is the
 * one thing that changed in the Tailwind migration. It used to be a rule per
 * site (`.vercmp:hover .vercmp-card`), so a card only appeared if its host
 * class had a matching selector somewhere in the stylesheet — an invisible
 * dependency that broke silently the moment a caller was restyled. Callers
 * now supply position and size only; showing and hiding is not theirs to
 * get wrong.
 */
export function InfoHint({
  className,
  cardClassName,
  label,
  trigger,
  children,
}: {
  /** Layout for the trigger. Positioning context for the card comes free. */
  className: string
  /** Where the card sits relative to the trigger, and how wide it is. */
  cardClassName: string
  /** Names the trigger for assistive tech where its visible content is not
      already the name. */
  label?: string
  trigger: ReactNode
  children: ReactNode
}) {
  // The card doubles as the button's accessible description, so a screen
  // reader hears the detail on focus instead of discovering a bare trigger.
  const id = useId()
  return (
    <button
      type="button"
      className={cn(
        'group/hint relative cursor-help border-0 bg-transparent p-0 text-left [font:inherit]',
        className,
      )}
      aria-label={label}
      aria-describedby={id}
    >
      {trigger}
      <span
        id={id}
        role="tooltip"
        className={cn(
          'pointer-events-none absolute z-40 rounded-md border border-border bg-(--raise) p-2.5',
          'text-left font-normal text-foreground text-xs leading-snug tracking-normal normal-case',
          'opacity-0 shadow-lg transition-opacity duration-100',
          'group-hover/hint:opacity-100 group-focus-visible/hint:opacity-100',
          cardClassName,
        )}
      >
        {children}
      </span>
    </button>
  )
}
