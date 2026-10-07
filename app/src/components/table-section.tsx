import type { ReactNode } from 'react'
import { cn } from '../lib/cn'
import { EXPLAIN_FOLDED, ExplainToggle } from './explain'
import { SECTION_NOTE, SECTION_TITLE } from './table'

// A titled table standing on a page: the house SECTION_TITLE over a `TABLE`,
// rather than a board wrapped round a list.
//
// A board's ⓘ folds its prose; a table outside a board would show every
// `FOOT` it carries at all times, so this section folds them the same way —
// the ⓘ sits in the title and is drawn only when there is prose to reveal.
// `aside` is the live reading a board would put in its header (a count, when
// it was checked), pushed right on the title's line.

export function TableSection({
  title,
  note,
  aside,
  children,
  className,
}: {
  title: ReactNode
  /** One line under the title that is always shown: a fact, not prose. */
  note?: ReactNode
  aside?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={cn('group/tsec col-span-12 min-w-0', className)}>
      <h3 className={cn(SECTION_TITLE, 'mt-0')}>
        <span className="truncate">{title}</span>
        <ExplainToggle className="-my-1 hidden group-has-[.explain]/tsec:inline-flex" />
        {aside !== undefined && (
          <span className="ml-auto text-[0.75rem] text-muted-foreground [font-weight:400]">
            {aside}
          </span>
        )}
      </h3>
      {note !== undefined && <p className={SECTION_NOTE}>{note}</p>}
      <div className={cn('flex flex-col gap-3', EXPLAIN_FOLDED)}>{children}</div>
    </section>
  )
}
