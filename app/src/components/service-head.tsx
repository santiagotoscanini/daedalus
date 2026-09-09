import type { ReactNode } from 'react'
import type { VersionGap } from '../lib/dashboard/github'
import type { ImageFreshness, RunningVersion } from '../lib/dashboard/images'
import { DASH } from '../lib/format'
import { BASE_DOMAIN } from '../lib/site'
import type { Tone } from '../lib/tone'
import { InfoHint } from './hint'
import { Button } from './ui/button'
import { Chip } from './viz'

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

/** The header's outer box, shared with `ServiceHeadSkeleton` so the space the
    placeholder reserves is the space the real header takes. */
export const SVC_HEAD = 'mb-[1.1rem] flex items-start gap-[0.85rem] max-[44rem]:flex-wrap'

/** The artwork slot, shared with `ServiceHeadSkeleton` for the same reason. */
export const SVC_LOGO = 'block size-11 flex-none object-contain'

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
      <div className="min-w-0">
        <h2 className="m-0 text-[1.15rem] font-semibold">{name}</h2>
        {/* The version, attached to the name it is the version OF, with its
            verdict beside it — the three are one sentence, so they sit on one
            line rather than in separate cards a screen apart. */}
        <p className="mt-[0.15rem] mb-0 flex flex-wrap items-baseline gap-2">
          <span className="font-mono text-[1.05rem] font-semibold tracking-[-0.01em] text-foreground [overflow-wrap:anywhere]">
            {version ?? DASH}
          </span>
          {versionNote !== undefined && (
            <span className="text-[0.73rem] text-muted-foreground">{versionNote}</span>
          )}
          {verdict !== undefined && <VersionCompare verdict={verdict} rows={compare ?? []} />}
        </p>
        {/* Out of the 74ch prose measure the rest of the app's ledes keep. That
            cap is right for a paragraph read down a column and wrong here: this
            is one sentence on a line with a 44px logo and a button beside it,
            and the cap folded it in half while a third of the header sat
            empty. The header is the measure. */}
        <p className="mt-[0.3rem] mb-0 max-w-none text-[0.82rem] text-(--text-muted)">{lede}</p>
      </div>
      {/* The status chip and the one action on the page, kept together at the
          far end. */}
      {actions !== undefined && (
        <div className="ml-auto flex flex-none items-center gap-[0.6rem] max-[44rem]:ml-0 max-[44rem]:w-full">
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
 * working. As headline cards those comparisons read as unrelated numbers
 * competing for the same glance, and they spent a quarter of the page
 * restating what the one word already said. The reveal mechanics — and why
 * `title` is not the mechanism — live on InfoHint.
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
    <InfoHint
      // Position and size only — InfoHint owns the reveal and the card chrome.
      className="inline-flex cursor-default rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      cardClassName="top-[calc(100%+0.45rem)] left-0 flex w-max max-w-[19rem] flex-col gap-[0.4rem] px-[0.7rem] py-[0.6rem]"
      trigger={<Chip tone={verdict.tone}>{verdict.label}</Chip>}
    >
      {rows.map((r) => (
        <span key={r.k} className="grid grid-cols-[1fr_auto] items-baseline gap-x-[0.7rem] gap-y-0">
          <span className="text-[0.62rem] font-semibold tracking-[0.1em] text-muted-foreground uppercase">
            {r.k}
          </span>
          <span className="font-mono text-[0.95rem] font-semibold text-foreground tabular-nums [overflow-wrap:anywhere]">
            {r.v ?? DASH}
          </span>
          <span className="col-span-full text-[0.7rem] leading-[1.35] text-(--text-muted)">
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
  return (
    // The default variant on purpose: the one thing you came to press is the
    // primary action, and `Button` carries the argument for why that is the
    // foreground colour rather than the brand.
    <Button asChild size="sm">
      <a href={`https://${host}.${BASE_DOMAIN}`} target="_blank" rel="noreferrer">
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
    <p className="mt-[0.35rem] mr-0 mb-[1.1rem] ml-[3.4rem] flex flex-wrap gap-x-4 gap-y-0 text-[0.74rem] max-[44rem]:ml-0">
      {links.map((l) => (
        <a
          key={l.href}
          className="text-muted-foreground no-underline hover:text-primary"
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
