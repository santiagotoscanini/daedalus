import type { ComponentProps, ReactNode } from 'react'
import { cn } from '../lib/cn'
import { ExplainToggle, useExplain } from './explain'

/**
 * The frame every page opens with: a title, and one paragraph saying what
 * the page is for.
 *
 * A component rather than a pair of class names, because the two pieces have
 * a relationship — the lede's negative top margin closes the gap the header's
 * bottom margin opens, and a page that spelled them out separately would have
 * to remember both.
 */
export function PageHead({
  title,
  aside,
  fold = false,
  children,
}: {
  title: ReactNode
  /** A count, a status, an action — set beside the title on its baseline. */
  aside?: ReactNode
  /**
   * Fold the lede behind an ⓘ beside the title, as a board folds its prose.
   * For the section pages a person visits daily, where the lede is the same
   * sentence every time; an error or a one-off page keeps it in view.
   */
  fold?: boolean
  /** The lede. */
  children?: ReactNode
}) {
  const explain = useExplain()
  const folded = fold && !explain.open
  return (
    <>
      <header className="mb-6 flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <h1 className="m-0 text-[1.5rem] leading-tight tracking-[-0.028em] [font-weight:620] max-[34rem]:text-[1.3rem]">
          {title}
        </h1>
        {fold && children !== undefined && (
          <ExplainToggle open={explain.open} onToggle={explain.toggle} className="inline-flex" />
        )}
        {aside}
      </header>
      {children !== undefined && !folded && (
        <Lede className={cn('-mt-4 mb-7', fold && 'animate-in fade-in-0 duration-200')}>
          {children}
        </Lede>
      )}
    </>
  )
}

/**
 * One measure of page-level prose.
 *
 * 68ch, a little wider than the 62ch a book would use: these are
 * introductions read in one glance, not chapters. A caption INSIDE a board
 * does not get this — the board is already the measure, and capping it again
 * leaves the text hugging one edge of a wide panel with empty background
 * beside it, which reads as a layout bug.
 */
function Lede({ className, ...props }: ComponentProps<'p'>) {
  return (
    <p
      className={cn(
        'mt-1 max-w-[68ch] text-[0.9rem] text-muted-foreground leading-relaxed',
        className,
      )}
      {...props}
    />
  )
}

/** The trail above a detail page's title. */
export function Crumbs({ className, ...props }: ComponentProps<'p'>) {
  return (
    <p
      className={cn(
        'mt-0 mb-4 text-muted-foreground text-[0.8rem] [&_a]:text-muted-foreground [&_a:hover]:text-foreground [&_span]:mx-1.5 [&_span]:opacity-50',
        className,
      )}
      {...props}
    />
  )
}

/**
 * One measure for a page of forms.
 *
 * The category pages fill the main column, because a grid of boards is
 * read across. Settings and Profile are read DOWN — a stack of cards with a
 * label column and a value column — and a form stretched to a wide window
 * puts its values a screen's width from their labels. So those two pages
 * share this: a 60rem column at the main area's left edge (where every other page's title sits, so switching pages does not move the title), holding the title,
 * the tab row and the cards alike, so the header is never wider than what it
 * heads.
 */
export function Measure({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('w-full max-w-[60rem]', className)} {...props} />
}
