// The rail's class strings, shared by every piece of the shell.
//
// Two custom variants carry most of the weight here, and neither is visible
// from a single file:
//
//   max-rail:       below the 52rem breakpoint — the rail is a drawer there.
//   nav-collapsed:  `<html data-nav="collapsed">` on a desktop-wide screen
//                   (app.css). The state lives on <html> so a dozen elements
//                   can react to it without a prop, and so the boot script
//                   can set it before React exists.

/**
 * One rail row, in three places: the directory, the fleet rows at the foot,
 * and the app-scoped rail.
 *
 * The `after:` half is the collapsed rail's tooltip. At 64px the icon is the
 * only thing naming the destination, so the label has to come back somewhere
 * — beside the row rather than under the cursor, and immediately rather than
 * after the second the native `title` waits. `attr(data-label)` is why every
 * caller sets that attribute.
 *
 * Selected is quiet, not orange: it is the one row the eye rests on at every
 * glance, and a block of accent there outshouted every reading on the page.
 * The accent's job on this rail is the wordmark.
 */
export const NAV_ITEM = [
  'relative flex items-center gap-2.5 rounded-[7px] px-2.5 py-[0.45rem]',
  'text-(--text-muted) text-sm whitespace-nowrap no-underline',
  'transition-[background-color,color] duration-150',
  'hover:bg-(--panel-2) hover:text-foreground hover:no-underline',
  'focus-visible:outline-2 focus-visible:outline-(--brand-dim) focus-visible:outline-offset-2',
  // A thumb, not a cursor.
  'max-rail:px-2.5 max-rail:py-[0.68rem] max-rail:text-[0.97rem]',
  'nav-collapsed:justify-center nav-collapsed:px-0',
  'nav-collapsed:after:pointer-events-none nav-collapsed:after:absolute',
  'nav-collapsed:after:top-1/2 nav-collapsed:after:left-[calc(100%+0.55rem)]',
  'nav-collapsed:after:z-40 nav-collapsed:after:-translate-y-1/2',
  'nav-collapsed:after:rounded-[7px] nav-collapsed:after:border nav-collapsed:after:bg-(--raise)',
  'nav-collapsed:after:px-[0.55rem] nav-collapsed:after:py-1',
  'nav-collapsed:after:text-[0.78rem] nav-collapsed:after:leading-tight',
  'nav-collapsed:after:font-medium nav-collapsed:after:tracking-normal',
  'nav-collapsed:after:text-foreground nav-collapsed:after:whitespace-nowrap',
  'nav-collapsed:after:content-[attr(data-label)]',
  'nav-collapsed:after:opacity-0 nav-collapsed:after:transition-opacity',
  'nav-collapsed:hover:after:opacity-100 nav-collapsed:focus-visible:after:opacity-100',
  // The icon carries less weight than its label, so at rest it is drawn
  // back; hovering or selecting brings the whole row forward together.
  '[&>svg]:shrink-0 [&>svg]:opacity-75 [&>svg]:transition-opacity hover:[&>svg]:opacity-100',
].join(' ')

export const NAV_ITEM_ACTIVE = 'bg-(--panel-2) font-[550] text-foreground [&>svg]:opacity-100'

/** The label, which the collapsed rail hides in favour of the tooltip. */
export const NAV_LABEL = 'min-w-0 overflow-hidden text-ellipsis nav-collapsed:hidden'

export const NAV_DIVIDER = 'my-2 mx-[0.7rem] h-px bg-(--border-soft) nav-collapsed:mx-1.5'

export const NAV_LIST = 'flex flex-col gap-[0.12rem]'

/** The wordmark. Letter-spaced small caps, which the collapsed rail centres. */
export const BRAND = [
  'flex min-w-0 flex-1 items-center gap-[0.7rem] px-[0.55rem] py-1',
  'font-semibold text-[0.76rem] text-foreground uppercase tracking-[0.14em]',
  'no-underline hover:no-underline',
  'focus-visible:outline-2 focus-visible:outline-(--brand-dim) focus-visible:outline-offset-2',
  'nav-collapsed:justify-center nav-collapsed:px-0',
].join(' ')

/** A square hit target holding one icon and nothing else. */
export const ICON_BUTTON = [
  'inline-flex size-[38px] flex-none cursor-pointer items-center justify-center',
  'rounded-[9px] border-0 bg-transparent p-0 text-(--text-muted)',
  'hover:bg-(--panel-2) hover:text-foreground',
  'focus-visible:outline-2 focus-visible:outline-(--brand-dim) focus-visible:outline-offset-2',
].join(' ')
