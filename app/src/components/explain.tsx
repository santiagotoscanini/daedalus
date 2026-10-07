import { InfoIcon } from 'lucide-react'
import { HoverCard } from 'radix-ui'
import { type ReactNode, useRef, useState } from 'react'
import { cn } from '../lib/cn'

// The explanations behind an ⓘ.
//
// Every board and section carries prose about what its numbers mean. It is
// worth having and not worth reading twice, so it never sits in the layout:
// the prose wears the marker class `explain` (tokens.ts FOOT, settings NOTE),
// the panel hides every `.explain` inside it (EXPLAIN_FOLDED), and the ⓘ
// shows that same prose in a bubble on hover, keyboard focus or a tap. A
// bubble rather than an inline reveal: opening an explanation must not push
// the page around.
//
// The bubble reads the prose from the panel the ⓘ sits in (the nearest
// ancestor that holds an `.explain`), so the several hundred FOOTs written as
// `<p className={FOOT}>` need no change. A caller whose prose is not in the
// panel (a page lede) hands it in as `content`.

/** What a panel applies so its `.explain` prose stays out of the layout. */
export const EXPLAIN_FOLDED = '[&_.explain]:hidden'

/** The prose inside the panel the ⓘ belongs to, as markup for the bubble. */
function collect(from: HTMLElement | null): string {
  let el = from?.parentElement ?? null
  while (el !== null && el.querySelector('.explain') === null) el = el.parentElement
  if (el === null) return ''
  return [...el.querySelectorAll('.explain')]
    .map((n) => {
      const c = n.cloneNode(true) as HTMLElement
      c.classList.remove('explain')
      return c.outerHTML
    })
    .join('')
}

/**
 * The ⓘ. `className` carries the visibility rule, because only the caller
 * knows its group's name: `hidden group-has-[.explain]/board:inline-flex`.
 */
export function ExplainToggle({ className, content }: { className: string; content?: ReactNode }) {
  const ref = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [html, setHtml] = useState('')
  const show = (next: boolean) => {
    if (next && content === undefined) setHtml(collect(ref.current))
    setOpen(next)
  }
  return (
    <HoverCard.Root open={open} onOpenChange={show} openDelay={120} closeDelay={100}>
      <HoverCard.Trigger asChild>
        <button
          ref={ref}
          type="button"
          // A tap on a touch screen has no hover to open it.
          onClick={() => show(!open)}
          aria-expanded={open}
          aria-label="What this means"
          className={cn(
            'size-6 flex-none cursor-help items-center justify-center rounded-full border-0 bg-transparent p-0 [@media(pointer:coarse)]:size-9',
            'text-muted-foreground/70 transition-[color,background-color,opacity] duration-150',
            'hover:bg-foreground/[0.06] hover:text-foreground',
            'focus-visible:outline-2 focus-visible:outline-primary-dim focus-visible:outline-offset-2',
            // Drawn at rest only where it is needed; a caller may hide it until
            // its panel is hovered, so focus, an open bubble and a touch screen
            // (no hover to reveal it) all bring it back.
            'focus-visible:opacity-100 aria-expanded:opacity-100 [@media(hover:none)]:opacity-100',
            open && 'bg-foreground/[0.06] text-foreground',
            className,
          )}
        >
          <InfoIcon className="size-[15px]" strokeWidth={1.75} />
        </button>
      </HoverCard.Trigger>
      <HoverCard.Portal>
        <HoverCard.Content
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={12}
          className={cn(
            'z-[85] w-max max-w-[min(28rem,calc(100vw-1.5rem))] rounded-[12px] border border-hairline bg-popover/95 px-4 py-3',
            'text-[0.8rem] text-subdued leading-relaxed backdrop-blur-xl',
            'shadow-[inset_0_1px_0_var(--hairline-hi),var(--float-shadow)]',
            // The prose arrives with its board styling; in the bubble it is
            // plain paragraphs at the bubble's measure and ink.
            '[&_*]:max-w-none [&_p]:m-0 [&_p]:text-[0.8rem] [&_p]:text-subdued [&_p+p]:mt-2',
            'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.98]',
            'data-[state=closed]:animate-out data-[state=closed]:fade-out-0',
          )}
        >
          {content ?? (
            // Our own server-rendered markup, cloned from the page: React
            // already escaped every value in it.
            // biome-ignore lint/security/noDangerouslySetInnerHtml: a copy of this page's own rendered prose
            <div dangerouslySetInnerHTML={{ __html: html }} />
          )}
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard.Root>
  )
}
