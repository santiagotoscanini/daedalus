import type { ReactNode } from 'react'

import type { SourceMeta } from '../../core/settings/types'
import { cn } from '../../lib/cn'
import { since, when } from '../../lib/format'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card'
import { Skeleton } from '../ui/skeleton'
import { Chip, Facts } from '../viz'

// What the read-only settings tabs are built from: a card of labelled rows,
// a value that says "not set" when it is not set, and a line stating where
// the section's facts came from and how old they are. The tabs differ in
// what they show, not in how.

export const MONO = 'font-mono text-[0.8rem] [overflow-wrap:anywhere]'

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
        {rows !== undefined && <Facts rows={rows} list />}
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
    <span className="inline-flex max-w-full flex-col items-end gap-[0.1rem] text-right">
      <Mono>{rev.slice(0, 10)}</Mono>
      {subject !== undefined && subject !== '' && (
        <span className="text-[0.78rem] text-(--text-muted) [overflow-wrap:anywhere]">
          {subject}
        </span>
      )}
      {at !== undefined && at !== '' && (
        <span className="text-[0.72rem] text-(--dim)">{when(at)}</span>
      )}
    </span>
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
