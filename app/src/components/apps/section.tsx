import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'
import { ExplainToggle, useExplain } from '../explain'
import { SECTION_NOTE, SECTION_TITLE } from '../table'

/**
 * A titled section of an app tab: the house heading (table.tsx SECTION_TITLE),
 * its one-line note, an aside on the right for the section's action, and the
 * fold a Board gives its prose — every `.explain` inside stays hidden until
 * the ⓘ beside the title is pressed, and the ⓘ is drawn only when there is
 * something to reveal.
 *
 * For the tabs whose content is a TABLE rather than a board: a table is not
 * put inside a board to borrow its title.
 */
export function TabSection({
  title,
  note,
  aside,
  first = false,
  label,
  children,
}: {
  title: ReactNode
  /** The always-visible line under the title: a fact, not an explanation. */
  note?: ReactNode
  /** The section's action or live reading, set on the title's line at the right. */
  aside?: ReactNode
  /** The first section under the app's head sits on the head's own spacing. */
  first?: boolean
  label?: string
  children: ReactNode
}) {
  const explain = useExplain()
  return (
    <section aria-label={label} className={cn('group/sec', first ? 'mt-0' : 'mt-10', explain.body)}>
      <h2 className={cn(SECTION_TITLE, 'mt-0 min-h-8 gap-x-1')}>
        {title}
        <ExplainToggle
          open={explain.open}
          onToggle={explain.toggle}
          className="-my-1 hidden group-has-[.explain]/sec:inline-flex"
        />
        {aside !== undefined && aside !== null && (
          <span className="ml-auto flex items-center gap-3 text-[0.75rem] font-normal text-muted-foreground">
            {aside}
          </span>
        )}
      </h2>
      {note !== undefined && <p className={SECTION_NOTE}>{note}</p>}
      {children}
    </section>
  )
}

/** Prose that opens a section and folds behind its ⓘ. */
export const SECTION_EXPLAIN =
  'explain mt-0 mb-4 max-w-[72ch] text-[0.78rem] leading-[1.55] text-muted-foreground'
