import type { ComponentProps, ReactNode } from 'react'
import { cn } from '../lib/cn'

/**
 * The frame every page opens with: a title, and one paragraph saying what
 * the page is for.
 *
 * A component rather than a pair of class names, because the two pieces have
 * a relationship — the lede's negative top margin closes the gap the header's
 * bottom margin opens, and every page that spelled them out separately had to
 * remember both. There were three spellings of that pair before this existed.
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
      <header className="mb-5 flex flex-wrap items-baseline gap-x-3 gap-y-1.5">
        <h1 className="m-0 font-semibold text-[1.45rem] tracking-[-0.02em] max-[34rem]:text-[1.3rem]">
          {title}
        </h1>
        {aside}
      </header>
      {children !== undefined && <Lede className="-mt-3 mb-6">{children}</Lede>}
    </>
  )
}

/**
 * One measure of page-level prose.
 *
 * 74ch, deliberately wider than the 62ch a book would use: these are
 * introductions read in one glance, not chapters. A caption INSIDE a board
 * does not get this — the board is already the measure, and capping it again
 * leaves the text hugging one edge of a wide panel with empty background
 * beside it, which reads as a layout bug.
 */
export function Lede({ className, ...props }: ComponentProps<'p'>) {
  return <p className={cn('mt-1 max-w-[74ch] text-(--text-muted) text-sm', className)} {...props} />
}

/** The trail above a detail page's title. */
export function Crumbs({ className, ...props }: ComponentProps<'p'>) {
  return (
    <p
      className={cn('mt-0 mb-3.5 text-(--dim) text-[0.84rem] [&_span]:mx-1.5', className)}
      {...props}
    />
  )
}
