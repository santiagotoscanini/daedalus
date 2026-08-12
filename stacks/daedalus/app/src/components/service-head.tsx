import type { ReactNode } from 'react'
import type { VersionGap } from '../lib/dashboard/github'
import type { RunningVersion } from '../lib/dashboard/images'
import { DASH } from '../lib/format'
import { Chip, type Tone } from './viz'

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
  /** A path under public/. */
  logo: string
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
      <img className="svc-logo" src={logo} alt="" width={44} height={44} />
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
function VersionCompare({
  verdict,
  rows,
}: {
  verdict: { label: string; tone: Tone }
  rows: CompareRow[]
}) {
  if (rows.length === 0) return <Chip tone={verdict.tone}>{verdict.label}</Chip>

  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: tabIndex opens the :focus-within card for keyboard users — the popover pattern this codebase uses instead of title=; becomes the shared InfoHint in the UI-system pass.
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

/**
 * The upstream half of the working: what is current, and how far away it is.
 *
 * Split out because the OTHER half is not the same question everywhere. Most
 * pages pair it with the running version and say where that reading came from;
 * the AI tabs pair it with what the flake PINS, because on those the running
 * number and the pin are genuinely different facts. Sharing this row is what
 * stops two tabs from wording "3 releases between them" differently.
 *
 * Three cases, not two. Nothing pending does NOT imply the two numbers agree:
 * an image is often built from a git tag days before the release note for it
 * is published — healthchecks runs 4.3 against a newest release of 4.2 — and
 * printing "this is what is running" beside a different number is the one
 * thing a version panel must never do.
 */
export function latestRow(gap: VersionGap): CompareRow {
  const ahead = gap.installed !== null && gap.installed !== gap.latest

  return {
    k: 'Latest',
    v: gap.latest,
    note:
      gap.latest === null
        ? 'GitHub did not answer'
        : gap.behind.length > 0
          ? `${String(gap.behind.length)} release${gap.behind.length === 1 ? '' : 's'} between them`
          : ahead
            ? 'the newest published release — this box is on a tag ahead of it'
            : 'this is what is running',
  }
}

/**
 * The working behind a version verdict, shown on hover.
 *
 * `note` says where the running number came from, which is what decides how
 * much the verdict is worth: a version the service reported about itself is a
 * measurement, one read off the image is a claim the publisher made.
 */
export function compareOf(gap: VersionGap, note: string): CompareRow[] {
  return [latestRow(gap), { k: 'Running', v: gap.installed, note }]
}

/**
 * Where a running version came from, in the four words the header has room for.
 *
 * Not decoration: the three sources carry different weight. A version the
 * service reported about itself is a measurement. One read off the tag the
 * flake pins is reproducible from git but only true while the tag names a
 * release. One read off the image's OCI label is a claim the publisher made
 * about an artefact that a re-pull could silently replace — which is exactly
 * the case for every service pinned to a moving tag, and the reason those
 * pages used to say nothing at all.
 */
export const SOURCE_NOTE: Record<RunningVersion['source'], string> = {
  pin: 'from the tag the flake pins',
  label: 'from the image’s own label',
  unknown: 'unknown — the pin names a channel',
}

/**
 * The button every service head carries.
 *
 * `host` is the PUBLISHED label, not the webApp key — several differ
 * (`home-assistant` is served at `homeassistant`, `pocket-id` at `id`,
 * `open-webui` at `chat`) and deriving one from the other is how a dashboard
 * grows links that 404.
 */
export function Open({ name, host }: { name: string; host: string }) {
  return (
    <a
      className="btn btn-primary"
      href={`https://${host}.toscanini.me`}
      target="_blank"
      rel="noreferrer"
    >
      Open {name} ↗
    </a>
  )
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
