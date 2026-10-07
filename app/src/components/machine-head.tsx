import type { ReactNode } from 'react'
import { cn } from '../lib/cn'
import type { Tone } from '../lib/tone'
import { NOTE } from './tokens'
import { Board, Chip } from './viz'

// A machine as a page's subject: its mark, the strip that names it, and the
// board for a reading its agent does not send yet. System's tabs draw every
// machine with these, and so do the pages about one machine's service (AI ›
// Providers, Actions' runners).

export const OS_MARK: Record<string, { src: string; invert: boolean }> = {
  windows: { src: '/icon-windows.svg', invert: false },
  macos: { src: '/icon-apple.svg', invert: true },
  linux: { src: '/icon-linux.svg', invert: true },
}

/* The compact strip: a caption that hugs the picker above it, and sits flush
   when the picker draws it in its own identity slot (`nav` ancestor). */
const COMPACT =
  'm-0 -mt-2 mb-4 flex min-h-5 min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 text-[0.8rem] text-muted-foreground leading-snug [nav_&]:m-0'

/**
 * The strip above every System tab: the machine, its OS, and how it is.
 *
 * Above the tabs rather than inside a board, because it is the subject of
 * all of them, and the same strip for this box and for a node, because the
 * picker above can change what every board below is about and the eye
 * should not have to learn two shapes to follow it. The mark is the OS's:
 * NixOS for the box, OS_MARK's for a node.
 */
export function HeadStrip({
  mark,
  name,
  chip,
  aside,
  line,
  compact,
}: {
  mark: { src: string; invert: boolean } | undefined
  name: string
  chip?: { label: string; tone: Tone }
  aside?: ReactNode
  line: ReactNode
  /**
   * One quiet line under (or, in its `identity` slot, beside) the machine
   * picker: the picker already shows the mark and the name is the item it has
   * selected, so the strip stops being a third level of navigation and
   * becomes the picked machine's caption. System's heads use it.
   */
  compact?: boolean
}) {
  if (compact === true) {
    return (
      <p className={COMPACT}>
        <span className="text-foreground [font-weight:520]">{name}</span>
        <span className="min-w-0 [overflow-wrap:anywhere]">{line}</span>
        {chip !== undefined && <Chip tone={chip.tone}>{chip.label}</Chip>}
        {aside !== undefined && <span>{aside}</span>}
      </p>
    )
  }
  return (
    // The bottom margin matches HeadStripSkeleton's, so the tabs do not move on load.
    <div className="mb-[1.1rem] flex min-h-11 items-center gap-3 max-[44rem]:flex-wrap">
      {mark !== undefined && (
        <img
          src={mark.src}
          alt=""
          width={36}
          height={36}
          className={cn('block size-9 flex-none object-contain', mark.invert && 'dark:invert')}
        />
      )}
      <div className="flex min-w-0 flex-auto flex-col gap-1">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <h2 className="m-0 text-[1.05rem] text-foreground leading-tight tracking-[-0.015em] [font-weight:600]">
            {name}
          </h2>
          {chip !== undefined && <Chip tone={chip.tone}>{chip.label}</Chip>}
          {aside !== undefined && <span className={NOTE}>{aside}</span>}
        </div>
        <p className="m-0 text-[0.8rem] text-muted-foreground leading-snug [overflow-wrap:anywhere]">
          {line}
        </p>
      </div>
    </div>
  )
}

/**
 * A board for a reading the agent does not have yet but could.
 *
 * The shape of the answer, blurred, and one line on what it waits for.
 * Blurred rather than absent because the layout is the promise: the tab is
 * tuned to the machine, and a Windows PC has die temperatures whether or
 * not this box can read them this week. What is drawn underneath is a
 * sample in the right units, never a real number.
 */
export function WipBoard({
  title,
  icon,
  span,
  waits,
  children,
}: {
  title: string
  icon?: string
  span: 4 | 6 | 8 | 12
  /** "needs the SMC, which the agent does not read yet" */
  waits: string
  children: ReactNode
}) {
  return (
    <Board title={title} icon={icon} span={span} aside={<Chip tone="muted">in progress</Chip>}>
      <div className="relative">
        <div aria-hidden className="pointer-events-none select-none opacity-50 blur-[3px]">
          {children}
        </div>
        <div className="absolute inset-0 flex items-center justify-center p-3">
          <span className="rounded-xl border border-hairline bg-popover px-3 py-1.5 text-center text-[0.75rem] text-muted-foreground leading-[1.4] shadow-[inset_0_1px_0_var(--hairline-hi)]">
            {waits}
          </span>
        </div>
      </div>
    </Board>
  )
}
