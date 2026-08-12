import { type ReactNode, useId } from 'react'

/**
 * The house disclosure: a trigger whose explanation appears beside it on
 * hover or keyboard focus.
 *
 * CSS-only, revealed by `:hover` and `:focus-within`: these pages stream, so
 * a popover that needed hydration would be inert for the first moment, and a
 * keyboard has no hover. The trigger is a real <button>, which is what makes
 * it focusable without a suppressed lint; the `hint` class strips the UA
 * chrome so the host class carries the whole look.
 *
 * `title` is deliberately NOT the mechanism: it truncates, it cannot hold
 * labelled rows, and it appears after a delay long enough that nobody waits.
 *
 * The class pair stays per site (`vercmp`/`vercmp-card`, `hfact`/`hfact-card`,
 * `decode`/`decode-card`): each card is sized and positioned for the board it
 * lives in, and that is layout, not pattern.
 */
export function InfoHint({
  className,
  cardClassName,
  label,
  trigger,
  children,
}: {
  /** The host class the CSS keys on to reveal the card. */
  className: string
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
    <button type="button" className={`hint ${className}`} aria-label={label} aria-describedby={id}>
      {trigger}
      <span id={id} className={cardClassName} role="tooltip">
        {children}
      </span>
    </button>
  )
}
