import { cn } from '../lib/cn'
import type { Part } from '../lib/hardware/catalog'

// A part on a board: photo beside identity, spec underneath. Shared by the
// box's Build and Host tabs and by every node's, so a page of six parts
// reads as one inventory rather than six designs, on any machine.

/* The panels whose name or detail is read from the machine rather than the
   catalogue (Build's board, cpu and gpu, Host's case) compose these directly;
   the rest use `PartHead`. */
export const PART = 'flex min-h-10 items-center gap-3.5 pb-1'
export const PART_ID = 'flex min-w-0 flex-auto flex-col items-start gap-1'
export const PART_NAME =
  'text-[0.95rem] text-foreground tracking-[-0.01em] [font-weight:550] wrap-anywhere'
export const PART_DETAIL = 'text-[0.75rem] text-muted-foreground leading-[1.45]'

/** What SMART calls a drive — the string you would type into a shop. */
export const DISK_MODEL =
  'text-[0.95rem] text-foreground tracking-[-0.01em] [font-weight:550] wrap-anywhere'

/** A part's photo and name, for the panels that have artwork. */
export function PartHead({ part }: { part: Part }) {
  return (
    <div className={PART}>
      <PartPhoto part={part} />
      <div className={PART_ID}>
        <strong className={PART_NAME}>{part.name}</strong>
        <span className={PART_DETAIL}>{part.detail}</span>
      </div>
    </div>
  )
}

export function PartPhoto({ part }: { part: Part }) {
  if (part.photo === null) return null
  return (
    <img
      // A fraction of the board rather than a fixed size, because a board is
      // anywhere from a third of the page to all of it; the maximum caps it on
      // a phone, where a percentage would run away.
      className="h-auto w-[clamp(78px,34%,128px)] flex-none object-contain"
      src={part.photo.src}
      alt=""
      width={part.photo.width}
      height={part.photo.height}
    />
  )
}

/**
 * A part on a full-width board: the photo earns real size and the spec sits
 * beside it rather than under it — at twelve columns a spec list below a
 * picture leaves half the row empty. The container query is on the BOARD's
 * width, since a span-12 board is full width on a phone and a third of the
 * page on a desktop.
 */
export const PART_WIDE = cn(
  PART,
  'items-start gap-6',
  '[&>img]:w-[clamp(140px,26%,300px)]',
  '@max-[30rem]/board:flex-col @max-[30rem]/board:items-center',
  '@max-[30rem]/board:[&>img]:w-[clamp(140px,60%,260px)]',
)
