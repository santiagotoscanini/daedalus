import type { ReactNode } from 'react'

import type { SourceMeta } from '../../core/settings/types'
import { cn } from '../../lib/cn'
import { since, when } from '../../lib/format'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card'
import { Skeleton } from '../ui/skeleton'
import { Chip } from '../viz'

// What the settings tabs are built from: a card of labelled rows, a value
// that says "not set" when it is not set, and a line stating where the
// section's facts came from and how old they are. The tabs differ in what
// they show, not in how.

/* Settings keeps its own two of the board vocabulary rather than taking
   components/tokens.ts's, and the difference is deliberate: these are read as
   prose in a form, not as a caption under a chart. A step larger (0.78/0.8rem
   against 0.73rem and 0.86em) and, for the note, a step darker — `--text-muted`
   sits nearer the body ink than `--muted-foreground` does in the light theme. */

export const MONO = 'font-mono text-[0.8rem] [overflow-wrap:anywhere]'

/** The sentence under a section: what the rows above it mean, or what to do. */
export const NOTE = 'm-0 text-[0.78rem] text-(--text-muted)'

/** The quieter line under a value: when it was read, what it was, what it needs. */
export const ASIDE = 'text-[0.72rem] text-(--dim)'

/**
 * A section's rows: the label in a column of its own, the value beside it.
 *
 * A form, not a table. The value is left-aligned against the label column so
 * every value in a card — and every input — sits on the same vertical axis,
 * which is what lets the eye run down a settings page. Right-aligned values
 * (the board vocabulary's `Facts`) put a short value at the far edge of a wide
 * card with the whole width between it and its label, and a picker at the
 * far right reads as a table cell rather than as a field. Below phone width
 * the label sits above its value instead.
 */
export function Rows({ rows }: { rows: { k: string; v: ReactNode }[] }) {
  return (
    <dl className="m-0">
      {rows.map((r) => (
        <div
          key={r.k}
          className={cn(
            'grid grid-cols-[minmax(0,11rem)_minmax(0,1fr)] items-baseline gap-x-6',
            'border-t border-(--border-soft) py-[0.55rem] first:border-t-0 first:pt-0 last:pb-0',
            'max-[40rem]:grid-cols-1 max-[40rem]:gap-y-1',
          )}
        >
          <dt className="text-(--dim) text-[0.82rem]">{r.k}</dt>
          <dd className="m-0 min-w-0 text-[0.84rem] [font-weight:450]">{r.v}</dd>
        </div>
      ))}
    </dl>
  )
}

/** A value and the quieter lines under it — a commit and its date, a status and its reason. */
export function Stack({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn('inline-flex max-w-full flex-col items-start gap-[0.1rem]', className)}>
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

export function Section({
  title,
  icon,
  mono,
  description,
  rows,
  children,
}: {
  title: string
  /**
   * Drawn before the title. A path under public/ is a service's own logo —
   * used when the section IS that service (Cloudflare, Pi-hole, Pocket ID);
   * an element is a lucide icon, for sections that are a concept instead.
   */
  icon?: string | ReactNode
  /** A logo drawn in black (GitHub's mark): inverted under the dark scheme so it stays visible. */
  mono?: boolean
  description?: ReactNode
  rows?: { k: string; v: ReactNode }[]
  children?: ReactNode
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className={icon === undefined ? undefined : 'flex items-center gap-2'}>
          {typeof icon === 'string' ? (
            <img
              src={icon}
              alt=""
              width={20}
              height={20}
              className={cn('size-5 flex-none object-contain', mono === true && 'dark:invert')}
            />
          ) : icon !== undefined ? (
            <span
              aria-hidden="true"
              className="inline-flex size-5 flex-none items-center justify-center text-(--text-muted) [&>svg]:size-[18px]"
            >
              {icon}
            </span>
          ) : null}
          {title}
        </CardTitle>
        {description !== undefined && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {rows !== undefined && <Rows rows={rows} />}
        {children}
      </CardContent>
    </Card>
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
      {unit !== undefined && <span className="text-(--dim)"> {unit}</span>}
    </Mono>
  )
}

/** A live value still being asked for. */
export function Pending({ className }: { className?: string }) {
  return <Skeleton className={cn('inline-block h-4 w-28 align-middle', className)} />
}

export function Unset({ label = 'not set' }: { label?: string }) {
  return <span className="text-[0.82rem] text-(--dim)">{label}</span>
}

export function ExtLink({ href, children }: { href: string; children?: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className={cn(MONO, 'hover:text-foreground')}>
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
        <span className="text-[0.78rem] text-(--text-muted) [overflow-wrap:anywhere]">
          {subject}
        </span>
      )}
      {at !== undefined && at !== '' && (
        <span className="text-[0.72rem] text-(--dim)">{when(at)}</span>
      )}
    </Stack>
  )
}

/**
 * Where a section's facts came from, and whether to believe them.
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
  const age =
    meta.generatedAt === null ? null : since((Date.now() - Date.parse(meta.generatedAt)) / 1000)
  return (
    <p className="m-0 flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.74rem] text-(--dim)">
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
            From <Mono>{file}</Mono>, written by {producer}
            {age !== null && ` ${age}`}
            {meta.stale && ' — older than its timer promises; the producer has stopped.'}
          </span>
        </>
      )}
    </p>
  )
}

/* The three form idioms Integrations' panels share: the red line under a
   field, the label above one, and the bordered box a disclosed form sits in.
   Here rather than in one of them because a form that looked slightly
   different from the one beside it would read as a different kind of thing. */

export const ERROR_NOTE = 'm-0 text-[0.78rem] text-destructive'
export const FIELD_LABEL = 'font-medium text-[0.8rem]'
export const PANEL = 'flex flex-col gap-2 rounded-[9px] border border-(--border-soft) p-3'

/**
 * What the two GitHub App forms say when the host cannot keep an App's private
 * key yet. Shared so the App section and the recovery form beside it cannot
 * disagree about why their buttons are disabled.
 */
export const WAITING_FOR_HOST = 'Waiting for the host to support GitHub Apps.'

/** A service that answered, but not with a yes. */
export function Bad({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2">
      <Chip tone="bad">failing</Chip>
      <span className="text-[0.78rem] text-(--text-muted)">{children}</span>
    </span>
  )
}
