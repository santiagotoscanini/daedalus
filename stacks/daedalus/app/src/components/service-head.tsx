import type { ReactNode } from 'react'

import { Chip, type Tone } from './viz'
import { DASH } from '../lib/dashboard/format'
import type { VersionGap } from '../lib/dashboard/github'

// The header a page gets when its subject is one identifiable SERVICE.
//
// Used by every tab of Gaming and AI: artwork, the name, the version running,
// one sentence, and the link you actually came to click. Shared rather than
// copied because the layout carries an argument that should not be re-decided
// per page — the version sits directly under the name, because on both of
// those pages every other number is a comparison against it.
//
// The category rail is monochrome and the sub-tabs are text, so this is the
// one place on a page where the subject is identifiable at a glance.

export type CompareRow = {
  k: string
  v: string | null
  /** Why this number matters here. One short clause, not a sentence. */
  note: string
}

export function ServiceHead({
  logo,
  name,
  version,
  versionNote,
  verdict,
  compare,
  lede,
  actions,
}: {
  /**
   * A path under public/, or null when the project publishes no artwork.
   *
   * Null draws a monogram rather than borrowing a neighbour's mark. Shelfmark
   * is the only case left, and it shares a tab with Calibre-Web, which DOES
   * have a logo — so a borrowed one would not read as "no icon available", it
   * would read as the other service.
   */
  logo: string | null
  name: string
  /** What is running. Null renders an em dash — "we could not ask". */
  version: string | null
  /** Where that number comes from, in three or four words. */
  versionNote?: string
  /** The one-word answer: current, 3 behind, unknown. */
  verdict?: { label: string; tone: Tone }
  /** The working behind the verdict, shown on hover. */
  compare?: CompareRow[]
  lede: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="svc-head">
      {logo === null ?
        <span className="svc-logo svc-logo-mark" aria-hidden="true">
          {name.slice(0, 1)}
        </span>
      : <img className="svc-logo" src={logo} alt="" width={44} height={44} />}
      <div className="svc-ident">
        <h2>{name}</h2>
        {/* The version, attached to the name it is the version OF, with its
            verdict beside it — the three are one sentence, so they sit on one
            line rather than in separate cards a screen apart. */}
        <p className="svc-version">
          <span className="mono">{version ?? DASH}</span>
          {versionNote !== undefined && <span className="svc-version-note">{versionNote}</span>}
          {verdict !== undefined && <VersionCompare verdict={verdict} rows={compare ?? []} />}
        </p>
        <p className="lede">{lede}</p>
      </div>
      {actions !== undefined && <div className="svc-actions">{actions}</div>}
    </div>
  )
}

/**
 * The verdict, with what produced it one hover away.
 *
 * "current" is the answer; the versions it was compared against are the
 * working. As headline cards those comparisons read as unrelated numbers
 * competing for the same glance, and they spent a quarter of the page
 * restating what the one word already said. CSS-only, and shown on
 * `:focus-within` as well as `:hover`: these pages stream, so a popover that
 * needed hydration would be inert for the first moment, and a keyboard has no
 * hover.
 *
 * `title` is deliberately NOT the mechanism: it truncates, it cannot hold
 * labelled rows, and it appears after a delay long enough that nobody waits.
 */
function VersionCompare({ verdict, rows }: { verdict: { label: string; tone: Tone }; rows: CompareRow[] }) {
  if (rows.length === 0) return <Chip tone={verdict.tone}>{verdict.label}</Chip>

  return (
    <span className="vercmp" tabIndex={0}>
      <Chip tone={verdict.tone}>{verdict.label}</Chip>
      <span className="vercmp-card" role="tooltip">
        {rows.map((r) => (
          <span key={r.k} className="vercmp-row">
            <span className="vercmp-k">{r.k}</span>
            <span className="vercmp-v mono">{r.v ?? DASH}</span>
            <span className="vercmp-note">{r.note}</span>
          </span>
        ))}
      </span>
    </span>
  )
}

/**
 * A version gap as the one word that goes in `verdict`.
 *
 * Lives beside the header it feeds rather than in whichever page happened to
 * need it first: every service tab on this dashboard makes the same three-way
 * call, and a second copy of it is how two pages come to disagree about what
 * "current" means.
 */
export function verdictOf(gap: VersionGap): { label: string; tone: Tone } {
  if (gap.installed === null || gap.latest === null) return { label: 'unknown', tone: 'muted' }
  if (gap.behind.length === 0) return { label: 'current', tone: 'ok' }
  return { label: `${String(gap.behind.length)} behind`, tone: 'warn' }
}

/** A row of related links, for the ones worth one click but not a button. */
export function LinkRow({ links }: { links: { label: string; href: string }[] }) {
  return (
    <p className="svc-links">
      {links.map((l) => (
        <a key={l.href} href={l.href} target="_blank" rel="noreferrer">
          {l.label} ↗
        </a>
      ))}
    </p>
  )
}
