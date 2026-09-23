import type { ReactNode } from 'react'
import { Board, Chip } from '../../../components/viz'
import { cn } from '../../../lib/cn'
import { DASH, duration, since } from '../../../lib/format'
import type { Tone } from '../../../lib/tone'
import type { Access, AnonBudget } from '../data/github'
import { conclusionTone, conclusionWord } from '../data/parse'

export { WipBoard } from '../../../components/machine-system/shared'

/* ── the small vocabulary every tab shares ────────────────────────────── */

/** A run's state as a chip: running, queued, or its conclusion. */
export function RunChip({ status, conclusion }: { status: string; conclusion: string | null }) {
  const tone: Tone = conclusionTone(status, conclusion)
  return (
    <Chip tone={tone}>
      {status === 'in_progress' && (
        <span className="mr-[0.3rem] inline-block size-[0.4rem] animate-pulse rounded-full bg-current align-middle" />
      )}
      {conclusionWord(status, conclusion)}
    </Chip>
  )
}

export function Ext({
  href,
  children,
  className,
}: {
  href: string
  children: ReactNode
  className?: string
}) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className={cn('hover:underline', className)}>
      {children}
    </a>
  )
}

export const ago = (iso: string): string => since((Date.now() - Date.parse(iso)) / 1000)

export const took = (seconds: number | null): string =>
  seconds === null ? DASH : duration(seconds)

/** GitHub's image labels, as a short word. */
export function imageWord(label: string): string {
  const l = label.toLowerCase()
  if (l.startsWith('ubuntu')) return `Linux · ${label.replace(/^ubuntu-/, '')}`
  if (l.startsWith('windows')) return `Windows · ${label.replace(/^windows-/, '')}`
  if (l.startsWith('macos')) return `macOS · ${label.replace(/^macos-/, '')}`
  return label
}

export const osWord = (os: string): string =>
  os === 'linux' ? 'Linux' : os === 'windows' ? 'Windows' : os === 'macos' ? 'macOS' : os

/* ── what the box could and could not read ────────────────────────────── */

export function accessWord(a: Access): string {
  switch (a) {
    case 'app':
      return 'read as the App'
    case 'public':
      return 'read as anyone (public)'
    case 'needs-actions':
      return 'needs actions: read'
    case 'budget':
      return 'anonymous budget spent for the hour'
    case 'denied':
      return 'GitHub refused'
    case 'unreachable':
      return 'GitHub did not answer'
  }
}

export function accessTone(a: Access): Tone {
  return a === 'app'
    ? 'ok'
    : a === 'public'
      ? 'info'
      : a === 'needs-actions' || a === 'budget'
        ? 'warn'
        : 'bad'
}

/**
 * The board that says why part of the page is empty, and what fixes it. The
 * App was registered with the least it needed to build; reading Actions is
 * one more permission, granted on GitHub's side and accepted once on the
 * installation.
 */
export function GrantBoard({
  unreadable,
  publicRepos = 0,
  budget,
  span = 12,
}: {
  unreadable: { repo: string; url: string; access: Access }[]
  publicRepos?: number
  budget?: AnonBudget
  span?: 4 | 6 | 8 | 12
}) {
  if (unreadable.length === 0 && publicRepos === 0) return null
  const private_ = unreadable.filter((u) => u.access === 'needs-actions')
  const other = unreadable.filter((u) => u.access !== 'needs-actions')
  const resetIn =
    budget === undefined || budget.resetAt === 0
      ? null
      : Math.max(0, Math.round((budget.resetAt - Date.now()) / 60_000))
  return (
    <Board
      title="What the box reads as anyone"
      icon="warn"
      span={span}
      aside={
        <Chip tone={budget?.spent === true ? 'bad' : 'warn'}>
          {budget?.spent === true
            ? 'budget spent'
            : `${String(unreadable.length + publicRepos)} repositories`}
        </Chip>
      }
    >
      {publicRepos > 0 && (
        <p className="m-0 mb-[0.5rem] text-[0.8rem] leading-[1.5]">
          {String(publicRepos)} of the repositories are public, so their runs were read with no
          token at all — out of the sixty calls an hour GitHub allows this address
          {budget?.remaining !== null && budget?.remaining !== undefined
            ? `, ${String(budget.remaining)} left`
            : ''}
          {resetIn !== null && budget?.spent === true ? `, back in ${String(resetIn)} min` : ''}.
          That is enough for the lists and a sample of the jobs, not for all of them; the App
          reading them itself is five thousand an hour.
        </p>
      )}
      {private_.length > 0 && (
        <p className="m-0 text-[0.8rem] leading-[1.5]">
          The box's GitHub App has <span className="font-mono text-[0.86em]">contents: read</span>,{' '}
          <span className="font-mono text-[0.86em]">checks: write</span> and what a build needs, and
          not <span className="font-mono text-[0.86em]">actions: read</span>. So it can read every
          workflow file, and no run of the private{' '}
          {private_.map((u, i) => (
            <span key={u.repo}>
              {i > 0 && (i === private_.length - 1 ? ' or ' : ', ')}
              <Ext href={`${u.url}/actions`} className="text-primary">
                {u.repo}
              </Ext>
            </span>
          ))}
          . To grant it: GitHub → Settings → Developer settings → GitHub Apps → the box's App →
          Permissions &amp; events → Repository permissions → <b>Actions: Read-only</b> → Save; then
          open the App's installation on your account and accept the new permission. The page reads
          the runs on its next visit.
        </p>
      )}
      {private_.length === 0 && publicRepos > 0 && (
        <p className="m-0 text-[0.8rem] leading-[1.5]">
          To let the App read them: GitHub → Settings → Developer settings → GitHub Apps → the box's
          App → Permissions &amp; events → Repository permissions → <b>Actions: Read-only</b> →
          Save; then open the App's installation on your account and accept the new permission.
        </p>
      )}
      {other.length > 0 && (
        <p className="m-0 mt-[0.5rem] text-[0.8rem] leading-[1.5] text-muted-foreground">
          {other.map((u) => `${u.repo}: ${accessWord(u.access)}`).join(' · ')}
        </p>
      )}
    </Board>
  )
}

/** A sample table for a WIP board, in the right units. */
export function SampleRows({ rows }: { rows: [string, string][] }) {
  return (
    <ul className="m-0 flex list-none flex-col p-0">
      {rows.map(([a, b]) => (
        <li
          key={a}
          className="flex items-center gap-[0.45rem] border-(--border-soft) border-t py-[0.34rem] text-[0.77rem] first:border-t-0"
        >
          <span className="min-w-0 flex-auto truncate">{a}</span>
          <span className="text-[0.68rem] text-muted-foreground tabular-nums">{b}</span>
        </li>
      ))}
    </ul>
  )
}
