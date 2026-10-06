import type { ComponentProps, ReactNode } from 'react'
import { cn } from '../lib/cn'

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
  children,
}: {
  title: ReactNode
  /** A count, a status, an action — set beside the title on its baseline. */
  aside?: ReactNode
  /** The lede. */
  children?: ReactNode
}) {
  return (
    <>
      <header className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <h1 className="m-0 text-[1.75rem] leading-tight tracking-[-0.032em] [font-weight:640] max-[34rem]:text-[1.45rem]">
          {title}
        </h1>
        {aside}
      </header>
      {children !== undefined && <Lede className="-mt-4 mb-8">{children}</Lede>}
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
 * share this: a 60rem column centred in the main area, holding the title,
 * the tab row and the cards alike, so the header is never wider than what it
 * heads.
 */
export function Measure({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('mx-auto w-full max-w-[60rem]', className)} {...props} />
}
