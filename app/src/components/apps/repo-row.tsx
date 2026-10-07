// One repository in the picker: its cells, its chips, and where the app's name comes from.

import { Fragment } from 'react'
import type { Repo } from '../../host/github-repos'
import { cn } from '../../lib/cn'
import { defaultImage } from '../../lib/site'
import { useSite } from '../../lib/site-context'
import { Chip } from '../viz'
import { CHIP } from './shared'

/** The four cells of a row, in the order the list's grid tracks expect them. */
export function Cells({ repo, taken }: { repo: Repo; taken: boolean }) {
  return (
    <>
      {/* Readable rather than greyed out: a repo that is already an app is a
          destination, not a rejected option. */}
      <span className={cn(REPO_NAME, taken && 'text-subdued')}>{repo.name}</span>
      <Chips repo={repo} taken={taken} />
      <span className={REPO_DESC}>{repo.description ?? '—'}</span>
      <span className={REPO_META}>
        {repo.language ?? '—'} · {repo.pushedAt ? fmtWhen(repo.pushedAt) : 'never pushed'}
        {taken && (
          <span
            className="ml-2 text-primary opacity-0 transition-opacity duration-[120ms] group-hover/row:opacity-100 group-aria-selected/opt:opacity-100"
            aria-hidden="true"
          >
            →
          </span>
        )}
      </span>
    </>
  )
}

export function Chips({
  repo,
  taken,
  className,
}: {
  repo: Repo
  taken: boolean
  className?: string
}) {
  return (
    <span className={cn(REPO_CHIPS, className)}>
      {/* Nearly every repo here is private, so the word is quiet text, not a
          pill: the pills are left for what differs (archived, already an app). */}
      {repo.private && <span className="text-[0.75rem] text-muted-foreground">private</span>}
      {repo.archived && (
        <Chip tone="warn" className={CHIP}>
          archived
        </Chip>
      )}
      {taken && <Chip className={CHIP}>already an app</Chip>}
    </span>
  )
}

/**
 * What the repository name becomes.
 *
 * The lede promises that everything downstream is derived from this one
 * string; this is that promise rendered, with the name tinted inside each
 * derived value so a single token can be watched propagating into the
 * container, the hostname and the image. Live, because two of the three are
 * overridable in step 2 and the panel is the only place that shows what an
 * override actually did.
 */
export function Derivation({
  name,
  hostname,
  image,
  postgres,
}: {
  name: string
  hostname: string
  image: string
  postgres: boolean
}) {
  const site = useSite()
  const rows = [
    { label: 'container', value: `app-${name}` },
    { label: 'hostname', value: hostname.trim() || `${name}.${site.baseDomain}` },
    { label: 'image', value: image.trim() || defaultImage(site, name) },
  ]
  if (postgres) rows.push({ label: 'postgres', value: name })

  return (
    // A left rule and an indent rather than another bordered panel: these are
    // consequences of the line above them, not a second thing to read.
    <dl className="mt-4 mr-0 mb-0 ml-0 grid grid-cols-[5.5rem_minmax(0,1fr)] items-baseline gap-x-4 gap-y-1.5 border-hairline border-l py-1 pr-0 pl-4">
      {rows.map((r) => (
        <Fragment key={r.label}>
          <dt className="text-[0.75rem] text-muted-foreground">{r.label}</dt>
          <dd className="m-0 font-mono text-[0.86em] text-subdued wrap-anywhere">
            <Threaded value={r.value} token={name} />
          </dd>
        </Fragment>
      ))}
    </dl>
  )
}

/**
 * One occurrence of `token` inside `value`, tinted.
 *
 * Composed from slices rather than from a marked-up string: these values are
 * hostnames and image references, which is exactly the operator-supplied text
 * that must never take a path through innerHTML. An override that no longer
 * contains the name renders plainly — a hostname somebody typed by hand is not
 * a derivation, and colouring a coincidence would be a lie about the mechanism
 * this panel exists to show.
 */
function Threaded({ value, token }: { value: string; token: string }) {
  const at = token === '' ? -1 : value.indexOf(token)
  if (at === -1) return <>{value}</>
  return (
    <>
      {value.slice(0, at)}
      <span className="text-primary">{token}</span>
      {value.slice(at + token.length)}
    </>
  )
}

function fmtWhen(iso: string): string {
  const days = Math.round((Date.now() - new Date(iso).getTime()) / 86_400_000)
  if (days < 1) return 'pushed today'
  if (days < 30) return `pushed ${String(days)}d ago`
  return `pushed ${iso.slice(0, 7)}`
}

export const REPO_CHIPS = 'flex items-center gap-1.5'

export const REPO_DESC = 'min-w-0 truncate text-[0.85rem] text-subdued'

export const REPO_META = 'text-right text-[0.78rem] whitespace-nowrap text-muted-foreground'

export const REPO_NAME = 'min-w-0 truncate font-[560]'
