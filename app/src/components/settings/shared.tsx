import type { ReactNode } from 'react'

import type { SourceMeta } from '../../core/settings/types'
import { cn } from '../../lib/cn'
import { Ago, When } from '../ago'
import { ExplainToggle, useExplain } from '../explain'
import { TABLE } from '../table'
import { Skeleton } from '../ui/skeleton'
import { Chip } from '../viz'

// What the settings tabs are built from — and Profile, and the agent
// enrolment page, which borrow it. Settings is a form page, read the way
// Linear's or Vercel's are: one calm column of sections, each a title and one
// line of what it is ABOVE a single panel, every label in one column and every
// value and control on one axis beside it, lists inside a panel drawn as the
// house table's rows, and the prose that explains a section folded behind its
// ⓘ. The tabs differ in what they show, not in how.
//
// Sections sit 40px apart (`SECTIONS`); inside a panel, rows have 20px sides
// and hairlines inset to the text, the way the house table's rows do.

/* Settings keeps its own two of the board vocabulary rather than taking
   components/tokens.ts's, and the difference is deliberate: these are read as
   prose in a form, not as a caption under a chart. A step larger (0.78/0.8rem
   against 0.73rem and 0.86em) and, for the note, a step darker — `--text-muted`
   sits nearer the body ink than `--muted-foreground` does in the light theme. */

export const MONO = 'font-mono text-[0.8rem] [overflow-wrap:anywhere]'

/** A tab's column of sections: 40px between one section and the next. */
export const SECTIONS = 'flex flex-col gap-10'

/** The sentence under a section: what the rows above it mean, or what to do. Folds behind the ⓘ. */
export const NOTE = 'explain m-0 max-w-[72ch] text-[0.8rem] leading-relaxed text-subdued'

/**
 * NOTE's look without the `explain` marker: a state or an instruction, always
 * visible. Prose that explains folds; a result ("Saved."), a failure, a
 * warning or the one instruction a form needs does not.
 */
export const NOTE_SHOWN = 'm-0 max-w-[72ch] text-[0.8rem] leading-relaxed text-subdued'

/** The quieter line under a value: when it was read, what it was, what it needs. */
export const ASIDE = 'text-[0.72rem] text-muted-foreground'

/** ASIDE for a line that only explains a control: folded behind the section's ⓘ with the rest. */
export const HINT = `explain ${ASIDE} max-w-[64ch] leading-[1.5]`

/**
 * The one height of a field in a settings row: Input, Picker trigger and the
 * button beside them. `Input` and the `Picker` trigger each bring their own (a
 * padded auto height and a fixed 36px); the `data-[size=default]` half is the
 * trigger's own size rule, which a bare `h-8` does not outrank.
 */
export const CONTROL_H = 'h-8 py-0 data-[size=default]:h-8'

/**
 * The inner tile a disclosed form, an armed confirm or a sub-list sits in
 * inside a panel: 12px, a hairline, the faintest fill — one radius step inside
 * the panel's 16px, so it reads as part of it and not as a second card.
 */
export const INSET =
  'flex flex-col gap-3 rounded-xl border border-hairline bg-foreground/[0.02] p-4'

/** A section's panel: the house table's frame, so a form and a list share one surface. */
const FRAME = cn(TABLE, 'flex flex-col')

/**
 * A padded band inside a panel — the notes and actions under its rows, or a
 * block of its own between two lists. Hairline above unless it opens the
 * panel. While the section is folded, a band that holds only explanations is
 * hidden whole, so the panel does not keep an empty strip.
 */
export const BAND = cn(
  'flex min-w-0 flex-col gap-3 border-hairline border-t px-5 py-4 first:border-t-0 empty:hidden',
  '[[data-folded]>&:not(:has(>:not(.explain)))]:hidden',
)

/** A band of its own, for a block passed as a section's `body`. */
export function Band({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn(BAND, className)}>{children}</div>
}

const ROW_GRID = cn(
  'grid grid-cols-[minmax(0,12rem)_minmax(0,1fr)] items-baseline gap-x-8',
  'max-[40rem]:grid-cols-1 max-[40rem]:gap-y-1.5',
)

/**
 * A section's rows: the label in a column of its own, the value beside it.
 *
 * A form, not a table. The value is left-aligned against the label column so
 * every value in a panel — and every input — sits on the same vertical axis,
 * which is what lets the eye run down a settings page. Below phone width the
 * label sits above its value instead.
 *
 * `framed` is the panel's own list (20px sides, hairlines inset to the text);
 * without it the rows are flush, for a list inside an inset tile.
 */
export function Rows({
  rows,
  framed = false,
}: {
  rows: { k: string; v: ReactNode }[]
  framed?: boolean
}) {
  return (
    <dl className={cn('m-0', framed && 'border-hairline border-t px-5 first:border-t-0')}>
      {rows.map((r) => (
        <div
          key={r.k}
          className={cn(
            ROW_GRID,
            'border-hairline border-t first:border-t-0',
            framed ? 'py-3.5' : 'py-2.5 first:pt-0 last:pb-0',
          )}
        >
          <dt className="text-[0.8125rem] text-muted-foreground">{r.k}</dt>
          <dd className="m-0 min-w-0 text-[0.8125rem]">{r.v}</dd>
        </div>
      ))}
    </dl>
  )
}

/** A value and the quieter lines under it — a commit and its date, a status and its reason. */
export function Stack({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn('inline-flex max-w-full flex-col items-start gap-[0.15rem]', className)}>
      {children}
    </span>
  )
}

/** One line of a value: a chip and a word, a value and its unit — wrapping when the row is narrow. */
export function Line({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn('inline-flex flex-wrap items-center gap-2', className)}>{children}</span>
  )
}

/**
 * One section of a settings tab: its title and one line ABOVE the panel —
 * the app's one heading pattern (table.tsx SECTION_TITLE) — then the panel:
 * `rows` first, then `body` drawn edge to edge (a list, a table, a band of
 * its own), then `children` in a padded band at the foot (the notes and the
 * actions). The ⓘ beside the title is drawn only when something in the panel
 * folds.
 */
export function Section({
  title,
  icon,
  mono,
  description,
  aside,
  rows,
  body,
  children,
  id,
}: {
  title: ReactNode
  /**
   * A service's own logo, as a path under public/ — drawn small, before the
   * title, when the section IS that service (Cloudflare, Pi-hole, GitHub); it
   * identifies, it does not decorate. An element is drawn the same size.
   */
  icon?: string | ReactNode
  /** A logo drawn in black (GitHub's mark): inverted under the dark scheme so it stays visible. */
  mono?: boolean
  description?: ReactNode
  /** A reading at the right of the title line: a count, a state. */
  aside?: ReactNode
  rows?: { k: string; v: ReactNode }[]
  /** Edge-to-edge content between the rows and the foot band. */
  body?: ReactNode
  children?: ReactNode
  id?: string
}) {
  const explain = useExplain()
  return (
    <section id={id} className="group/section flex min-w-0 scroll-mt-6 flex-col">
      <header className="mb-3 flex min-w-0 flex-col gap-1">
        <h2 className="m-0 flex min-h-6 min-w-0 items-center gap-2 text-[0.875rem] text-foreground leading-tight [font-weight:600]">
          {typeof icon === 'string' ? (
            <img
              src={icon}
              alt=""
              width={16}
              height={16}
              className={cn('size-4 flex-none object-contain', mono === true && 'dark:invert')}
            />
          ) : icon !== undefined ? (
            <span
              aria-hidden="true"
              className="inline-flex size-4 flex-none items-center justify-center [&>img]:size-4 [&>svg]:size-4"
            >
              {icon}
            </span>
          ) : null}
          <span className="min-w-0 truncate">{title}</span>
          <ExplainToggle
            open={explain.open}
            onToggle={explain.toggle}
            className="-my-1 hidden opacity-0 group-hover/section:opacity-100 group-has-[.explain]/section:inline-flex"
          />
          {aside !== undefined && (
            <span className="ml-auto inline-flex flex-none items-center gap-2 text-[0.75rem] text-muted-foreground [font-weight:400]">
              {aside}
            </span>
          )}
        </h2>
        {description !== undefined && (
          <div className="max-w-[72ch] text-[0.8rem] text-muted-foreground leading-relaxed">
            {description}
          </div>
        )}
      </header>
      <div className={cn(FRAME, explain.body)} data-folded={explain.open ? undefined : ''}>
        {rows !== undefined && rows.length > 0 && <Rows rows={rows} framed />}
        {body}
        {children !== undefined && <div className={BAND}>{children}</div>}
      </div>
    </section>
  )
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <code className={cn(MONO, className)}>{children}</code>
}

/** A stated value in monospace, or an honest "not set". */
export function Value({ v, unit }: { v: string | null | undefined; unit?: string }) {
  if (v === null || v === undefined || v === '') return <Unset />
  return (
    <Mono>
      {v}
      {unit !== undefined && <span className="text-muted-foreground"> {unit}</span>}
    </Mono>
  )
}

/** A live value still being asked for. */
export function Pending({ className }: { className?: string }) {
  return <Skeleton className={cn('inline-block h-4 w-28 align-middle', className)} />
}

export function Unset({ label = 'not set' }: { label?: ReactNode }) {
  return <span className="text-[0.8rem] text-muted-foreground">{label}</span>
}

export function ExtLink({ href, children }: { href: string; children?: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={cn(
        MONO,
        'text-foreground no-underline decoration-foreground/30 underline-offset-[3px] hover:text-foreground hover:underline',
      )}
    >
      {children ?? href}
    </a>
  )
}

/** A commit, the way git log would say it at a glance. */
export function Commit({ rev, subject, at }: { rev: string; subject?: string; at?: string }) {
  return (
    <Stack>
      <Mono>{rev.slice(0, 10)}</Mono>
      {subject !== undefined && subject !== '' && (
        <span className="text-[0.78rem] text-subdued [overflow-wrap:anywhere]">{subject}</span>
      )}
      {at !== undefined && at !== '' && (
        <span className="text-[0.72rem] text-muted-foreground">{<When at={at} />}</span>
      )}
    </Stack>
  )
}

/**
 * Where a section's facts came from, and whether to believe them — the
 * caption under a tab's last section, pulled up to it.
 *
 * Three states the reader distinguishes and this line has to as well: the
 * producer never ran (nothing to show), it is broken (say what broke), it
 * stopped (the file is older than its timer promises). A clean read states
 * the file and its age and gets out of the way.
 */
export function SourceNote({
  meta,
  file,
  producer,
}: {
  meta: SourceMeta
  /** The file inside the container, e.g. `/export/site.json`. */
  file: string
  /** Who writes it, for the reader who goes looking. */
  producer: string
}) {
  return (
    <p
      className={cn(
        'm-0 -mt-7 flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.74rem] text-muted-foreground',
      )}
    >
      {meta.error !== null ? (
        <>
          <Chip tone="bad">unreadable</Chip>
          <span>
            <Mono>{file}</Mono> — {meta.error}
          </span>
        </>
      ) : !meta.available ? (
        <>
          <Chip tone="muted">not published</Chip>
          <span>
            <Mono>{file}</Mono> has not been written yet — {producer} has not run.
          </span>
        </>
      ) : (
        <>
          {meta.stale && <Chip tone="warn">stale</Chip>}
          <span>
            From <Mono className="text-[0.72rem]">{file}</Mono>, written by {producer}
            {meta.generatedAt !== null && (
              <>
                {' '}
                <Ago at={meta.generatedAt} />
              </>
            )}
            {meta.stale && ' — older than its timer promises; the producer has stopped.'}
          </span>
        </>
      )}
    </p>
  )
}

/* The three form idioms every settings form shares (and the login page
   borrows): the red line under a field, the label above one, and the bordered
   box a disclosed form sits in. Here rather than in one of them because a form
   that looked slightly different from the one beside it would read as a
   different kind of thing. */

export const ERROR_NOTE = 'm-0 text-[0.78rem] text-destructive'
export const FIELD_LABEL = 'font-medium text-[0.8rem]'
export const PANEL = 'flex flex-col gap-2 rounded-[9px] border border-subtle p-3'

/** An armed two-step's box (`ArmedConfirm`) on a settings tab. */
export const ARMED_PANEL = 'flex flex-col gap-3 rounded-md border border-subtle p-3'

/** A service that answered, but not with a yes. */
export function Bad({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2">
      <Chip tone="bad">failing</Chip>
      <span className="text-[0.78rem] text-subdued">{children}</span>
    </span>
  )
}
