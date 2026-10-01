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
}: {
  mark: { src: string; invert: boolean } | undefined
  name: string
  chip?: { label: string; tone: Tone }
  aside?: ReactNode
  line: ReactNode
}) {
  return (
    <div className="mb-[1.1rem] flex items-start gap-[0.85rem] max-[44rem]:flex-wrap">
      {mark !== undefined && (
        <img
          src={mark.src}
          alt=""
          width={44}
          height={44}
          className={cn('block size-11 flex-none object-contain', mark.invert && 'dark:invert')}
        />
      )}
      <div className="min-w-0 flex-auto">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="m-0 text-[1.25rem] tracking-[-0.01em]">{name}</h2>
          {chip !== undefined && <Chip tone={chip.tone}>{chip.label}</Chip>}
          {aside !== undefined && <span className={NOTE}>{aside}</span>}
        </div>
        <p className={`${NOTE} mt-1`}>{line}</p>
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
          <span className="rounded-md border border-subtle bg-card px-3 py-1.5 text-center text-[0.76rem] text-subdued leading-[1.4] shadow-sm">
            {waits}
          </span>
        </div>
      </div>
    </Board>
  )
}
