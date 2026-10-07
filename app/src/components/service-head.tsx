import type { ReactNode } from 'react'
import type { VersionGap } from '../lib/dashboard/github'
import type { ImageFreshness, RunningVersion } from '../lib/dashboard/images'
import { DASH } from '../lib/format'
import { useSite } from '../lib/site-context'
import type { Tone } from '../lib/tone'
import { InfoHint } from './hint'
import { Button } from './ui/button'
import { Chip } from './viz'

// The header a page gets when its subject is one identifiable SERVICE.
//
// Opens nearly every service tab (a tab opts out with `TabSpec.head: false`,
// lib/modules/manifest.ts): artwork, the name, the version running, one
// sentence, and the link you actually came to click. Shared rather than
// copied because the layout carries an argument that should not be re-decided
// per page — the version sits directly under the name, because on a service
// page every other number is a comparison against it.
//
// The rail is monochrome and the sub-tabs are text, so this is the one place
// on a page where the subject is identifiable at a glance.

export type CompareRow = {
  k: string
  v: string | null
  /** Why this number matters here. One short clause, not a sentence. */
  note: string
}

/** The header's outer box, shared with `ServiceHeadSkeleton` so the space the
    placeholder reserves is the space the real header takes. */
export const SVC_HEAD = 'mb-6 flex items-start gap-4 max-[44rem]:flex-wrap'

/** The artwork slot, shared with `ServiceHeadSkeleton` for the same reason. */
export const SVC_LOGO = 'block size-11 flex-none rounded-xl object-contain'

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
    <div className={SVC_HEAD}>
      <img className={SVC_LOGO} src={logo} alt="" width={44} height={44} />
      <div className="flex min-w-0 flex-col gap-1">
        <h2 className="m-0 text-[1.125rem] leading-tight tracking-[-0.015em] text-foreground [font-weight:600]">
          {name}
        </h2>
        {/* The version, attached to the name it is the version OF, with its
            verdict beside it — the three are one sentence, so they sit on one
            line rather than in separate cards a screen apart. */}
        <p className="m-0 flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-mono text-[0.84rem] tabular-nums text-foreground [font-weight:500] [overflow-wrap:anywhere]">
            {version ?? DASH}
          </span>
          {versionNote !== undefined && (
            <span className="text-[0.75rem] text-muted-foreground">{versionNote}</span>
          )}
          {verdict !== undefined && <VersionCompare verdict={verdict} rows={compare ?? []} />}
        </p>
        {/* A 640px measure, two lines: a head that reads as a paragraph is a
            page that has not decided what it is about. Never clamped: each
            page keeps its own copy short instead. */}
        <p className="m-0 mt-0.5 max-w-[40rem] text-[0.84rem] leading-[1.5] text-muted-foreground">
          {lede}
        </p>
      </div>
      {/* The status chip and the one action on the page, kept together at the
          far end. */}
      {actions !== undefined && (
        <div className="ml-auto flex flex-none items-center gap-2 self-start max-[44rem]:ml-0 max-[44rem]:w-full">
          {actions}
        </div>
      )}
    </div>
  )
}

/**
 * The verdict, with what produced it one hover away.
 *
 * "current" is the answer; the versions it was compared against are the
 * working. As headline cards those comparisons would read as unrelated
 * numbers competing for the same glance, restating what the one word already
 * says. The reveal mechanics — and why `title` is not the mechanism — live on
 * InfoHint.
 */
function VersionCompare({
  verdict,
  rows,
}: {
  verdict: { label: string; tone: Tone }
  rows: CompareRow[]
}) {
  // Up to date is the norm on most service pages, so it is a quiet chip; only
  // a version that differs from it — behind, a moved tag — carries colour.
  const tone: Tone = verdict.tone === 'ok' ? 'muted' : verdict.tone
  if (rows.length === 0) return <Chip tone={tone}>{verdict.label}</Chip>

  return (
    <InfoHint
      // Position and size only — InfoHint owns the reveal and the card chrome.
      className="inline-flex cursor-default rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      cardClassName="top-[calc(100%+0.5rem)] left-0 flex w-max max-w-[19rem] flex-col gap-2.5 px-3 py-2.5"
      trigger={<Chip tone={tone}>{verdict.label}</Chip>}
    >
      {rows.map((r) => (
        <span key={r.k} className="grid grid-cols-[1fr_auto] items-baseline gap-x-3 gap-y-0.5">
          <span className="text-[0.72rem] text-muted-foreground [font-weight:500]">{r.k}</span>
          <span className="font-mono text-[0.84rem] text-foreground tabular-nums [font-weight:500] [overflow-wrap:anywhere]">
            {r.v ?? DASH}
          </span>
          <span className="col-span-full text-[0.72rem] leading-[1.4] text-muted-foreground">
            {r.note}
          </span>
        </span>
      ))}
    </InfoHint>
  )
}

/**
 * A version gap as the one word that goes in `verdict`.
 *
 * Lives beside the header it feeds rather than in whichever page happened to
 * need it first: every service tab on this dashboard makes the same three-way
 * call, and a second copy of it is how two pages come to disagree about what
 * "current" means.
 *
 * `freshness` is the registry's half of the answer, for the services whose
 * pin is a digest on a tag (see `imageFreshness`). It changes the verdict in
 * two places, both of them cases the release gap gets wrong on its own:
 *
 *   - "current" with a moved tag is NOT current — GitHub compares release
 *     notes, but the artefact the pin freezes has been superseded on its own
 *     channel. The registry's answer wins, because it is about the bytes.
 *   - "unknown" with an unmoved tag IS an answer: a channel pin the release
 *     list cannot measure is nonetheless exactly where its channel points.
 *
 * A gap that already says "N behind" keeps saying so — it is the more
 * specific statement, and the freshness row in `compare` carries the
 * registry's working. An errored or absent probe changes nothing.
 */
export function verdictOf(
  gap: VersionGap,
  freshness?: ImageFreshness | null,
): { label: string; tone: Tone } {
  const probe = freshness !== undefined && freshness !== null && freshness.error === null
  if (probe && freshness.moved && gap.behind.length === 0) {
    return { label: 'pin behind tag', tone: 'warn' }
  }
  if (gap.installed === null || gap.latest === null) {
    if (probe && !freshness.moved) return { label: 'pin matches tag', tone: 'ok' }
    return { label: 'unknown', tone: 'muted' }
  }
  if (gap.behind.length === 0) return { label: 'current', tone: 'ok' }
  return { label: `${String(gap.behind.length)} behind`, tone: 'warn' }
}

/**
 * The registry's row of the working: where the tag points, versus the pin.
 *
 * An array so call sites can spread it after `compareOf`/`comparePinned` —
 * empty when there is nothing to say, which is how a page without a digest
 * pin (or before the probe's first run) renders no row rather than a dash.
 */
export function freshnessRow(f: ImageFreshness | null): CompareRow[] {
  if (f === null) return []
  if (f.error !== null) {
    return [{ k: 'Its tag', v: null, note: `the registry did not answer for ${f.tag}` }]
  }
  // The pin has moved since the probe ran — almost always because someone
  // just updated it. Saying "unmoved" here would be a claim about a tag this
  // box is no longer on; the probe simply has not caught up yet.
  if (f.stale) {
    return [
      {
        k: 'Its tag',
        v: null,
        note: `the pin has moved since the daily probe last asked about ${f.tag}`,
      },
    ]
  }
  return [
    {
      k: 'Its tag',
      v: f.moved ? 'moved' : 'unmoved',
      note: f.moved
        ? `${f.tag} now points at a newer image${
            f.remoteCreated === null ? '' : `, built ${f.remoteCreated.slice(0, 10)}`
          } — the pin is behind its channel`
        : `${f.tag} still points at the pinned digest`,
    },
  ]
}

/**
 * The upstream half of the working: what is current, and how far away it is.
 *
 * Split out because the OTHER half is not the same question everywhere. Most
 * pages pair it with the running version and say where that reading came from;
 * the AI tabs pair it with what the flake PINS (`comparePinned`,
 * modules/ai/view/shared.tsx), because on those the running
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
 * Not decoration: the sources carry different weight — see `RunningVersion`
 * (lib/dashboard/images.ts) for why a pinned tag and an image label are not
 * the same kind of claim.
 */
export const SOURCE_NOTE: Record<RunningVersion['source'], string> = {
  pin: 'from the tag the flake pins',
  label: 'from the image’s own label',
  config: 'from the image’s build config',
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
  const site = useSite()
  return (
    // Outline, not the filled primary: leaving for another app is not a
    // mutation, and a page keeps its one filled button for the one that is.
    <Button asChild size="sm" variant="outline">
      <a href={`https://${host}.${site.baseDomain}`} target="_blank" rel="noreferrer">
        Open {name} ↗
      </a>
    </Button>
  )
}

/** A row of related links, for the ones worth one click but not a button. */
export function LinkRow({ links }: { links: { label: string; href: string }[] }) {
  return (
    // Indented past the logo so the row hangs under the header's text column
    // rather than under its artwork.
    <p className="-mt-4 mr-0 mb-6 ml-15 flex flex-wrap gap-x-4 gap-y-1 text-[0.75rem] max-[44rem]:ml-0">
      {links.map((l) => (
        <a
          key={l.href}
          className="text-muted-foreground no-underline transition-colors hover:text-foreground"
          href={l.href}
          target="_blank"
          rel="noreferrer"
        >
          {l.label} ↗
        </a>
      ))}
    </p>
  )
}
