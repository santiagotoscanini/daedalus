import { InfoIcon } from 'lucide-react'
import { useState } from 'react'
import { cn } from '../lib/cn'

// The explanations behind an ⓘ.
//
// Every board and settings card carries prose about what its numbers mean.
// It is worth having and not worth reading twice, so it is folded away: the
// prose wears the marker class `explain` (tokens.ts FOOT, settings NOTE), the
// panel hides every `.explain` inside it until its ⓘ is pressed, and the ⓘ is
// drawn only when the panel holds something to reveal — a `:has()` check,
// so no caller has to say whether it has notes.
//
// A marker class rather than a component because the prose is written as
// `<p className={FOOT}>` in several hundred places; the class travels with
// the constant and none of them had to change.

/** What a panel hides while it is folded. */
export const EXPLAIN_FOLDED = '[&_.explain]:hidden'

/** Revealed prose eases in rather than snapping the board taller. */
export const EXPLAIN_OPEN =
  '[&_.explain]:animate-in [&_.explain]:fade-in-0 [&_.explain]:slide-in-from-top-1 [&_.explain]:duration-200'

export function useExplain() {
  const [open, setOpen] = useState(false)
  return { open, toggle: () => setOpen((o) => !o), body: open ? EXPLAIN_OPEN : EXPLAIN_FOLDED }
}

/**
 * The ⓘ. `className` carries the visibility rule, because only the caller
 * knows its group's name: `hidden group-has-[.explain]/board:inline-flex`.
 */
export function ExplainToggle({
  open,
  onToggle,
  className,
}: {
  open: boolean
  onToggle: () => void
  className: string
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-label={open ? 'Hide the explanation' : 'Explain this'}
      title={open ? 'Hide the explanation' : 'Explain this'}
      className={cn(
        'size-6 flex-none cursor-pointer items-center justify-center rounded-full border-0 bg-transparent p-0',
        'text-muted-foreground/70 transition-[color,background-color,opacity] duration-150',
        'hover:bg-foreground/[0.06] hover:text-foreground',
        'focus-visible:outline-2 focus-visible:outline-primary-dim focus-visible:outline-offset-2',
        // Drawn at rest only where it is needed; a caller may hide it until
        // its panel is hovered, so focus, an open state and a touch screen
        // (no hover to reveal it) all force it back.
        'focus-visible:opacity-100 aria-expanded:opacity-100 [@media(hover:none)]:opacity-100',
        open && 'bg-primary/12 text-primary hover:bg-primary/18 hover:text-primary',
        className,
      )}
    >
      <InfoIcon className="size-[15px]" strokeWidth={1.75} />
    </button>
  )
}
