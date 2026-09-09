// Release notes for the versions that matter: the one running, and every one
// between it and current.
//
// One component for two very different sources — Factorio's wikitext and four
// projects' GitHub Markdown — because they were parsed into the same shape on
// the server precisely so this could be. What reaches here is already
// headings-and-bullets; nothing renders Markdown in the browser.
//
// Everything is collapsed. A point release is forty-odd fixes to somebody
// else's engine; the summary line — version, date, which sections it touched —
// is what answers "is there anything in here for me", and opening one is a
// deliberate act.

import type { ReactNode } from 'react'
import { cn } from '../lib/cn'
import type { CommitGap, VersionGap } from '../lib/dashboard/github'
import { BOARD_FOOT, BOARD_NOTE, MONO, MONO_FACE, VIZ_EMPTY } from './category/system/shared'
import { Board } from './viz'

/* A release is a disclosure, and the Updates page's container rows borrow this
   exact idiom — same triangle, same hover, same open rotation — so that opening
   a container there and opening a release inside it read as one gesture a
   level apart. */
const REL = 'group overflow-hidden rounded-[9px] border border-(--border-soft) bg-(--panel-2)'
const REL_SUMMARY = cn(
  'flex min-w-0 cursor-pointer list-none items-baseline gap-[0.6rem] px-[0.6rem] py-[0.45rem]',
  'hover:bg-(--raise) [&::-webkit-details-marker]:hidden',
  "before:text-[0.7rem] before:text-muted-foreground before:transition-transform before:duration-[0.12s] before:content-['▸']",
  'group-open:before:rotate-90',
)
/* Which of these you are actually on. Without it a list that runs from the
   installed version upward reads as "all of this is pending", which is the
   opposite of what the bottom entry means. */
const REL_RUNNING =
  'rounded-full border border-[color-mix(in_srgb,var(--success)_40%,transparent)] px-[0.35rem] py-[0.05rem] text-[0.6rem] tracking-[0.08em] whitespace-nowrap text-success uppercase'
const REL_BODY = 'border-t border-(--border-soft) pt-[0.1rem] pr-[0.75rem] pb-[0.6rem] pl-[1.35rem]'
const REL_H5 =
  'mt-[0.55rem] mb-[0.2rem] text-[0.66rem] font-semibold tracking-[0.08em] text-primary uppercase'
const REL_ITEM = 'max-w-[90ch] text-[0.76rem] leading-[1.45] text-(--text-muted)'

/* Each step in the chain points at the next; the last is where you end up, so
   it carries the reading colour and the warning-tinted edge instead of an
   arrow. */
const CHAIN_STEP =
  "flex items-center gap-[0.3rem] rounded-[6px] border border-(--border-soft) bg-(--panel-2) px-[0.4rem] py-[0.12rem] text-[0.76rem] text-(--text-muted) after:ml-[0.1rem] after:text-muted-foreground after:content-['→']"
const CHAIN_LAST =
  'border-[color-mix(in_srgb,var(--warning)_45%,var(--border))] text-foreground after:content-none'

const COMMIT =
  'grid min-w-0 grid-cols-[4.5rem_1fr_auto] items-baseline gap-[0.6rem] rounded-[7px] px-[0.45rem] py-[0.24rem] text-[0.76rem] hover:bg-(--panel-2)'

export type Release = {
  version: string
  date: string
  url: string
  sections: { name: string; items: string[] }[]
  truncated: boolean
}

export function ReleaseNotes({
  releases,
  empty = 'no release notes for this version',
  /** Marks the version that is actually running, when it is one of these. */
  running,
}: {
  releases: Release[]
  empty?: string
  running?: string | null
}) {
  if (releases.length === 0) return <p className={VIZ_EMPTY}>{empty}</p>

  return (
    <div className="flex flex-col gap-[0.35rem]">
      {releases.map((rel) => (
        <details key={rel.version} className={REL}>
          <summary className={REL_SUMMARY}>
            <span className={cn(MONO_FACE, 'whitespace-nowrap text-[0.82rem] text-foreground')}>
              {rel.version}
            </span>
            {rel.version === running && <span className={REL_RUNNING}>running</span>}
            <span className="text-[0.7rem] whitespace-nowrap text-muted-foreground">
              {rel.date}
            </span>
            <span className="ml-auto truncate text-[0.68rem] text-muted-foreground">
              {rel.sections.map((s) => s.name).join(' · ')}
            </span>
          </summary>
          <div className={REL_BODY}>
            {rel.sections.length === 0 ? (
              <p className={VIZ_EMPTY}>this release shipped no written notes</p>
            ) : (
              rel.sections.map((s) => (
                <section key={s.name}>
                  <h5 className={REL_H5}>{s.name}</h5>
                  <ul className="flex flex-col gap-[0.15rem] pl-4">
                    {s.items.map((it, n) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: release notes are a static list — items never reorder or update in place.
                      <li key={n} className={REL_ITEM}>
                        {it}
                      </li>
                    ))}
                  </ul>
                </section>
              ))
            )}
            <p className="mt-[0.6rem] text-[0.7rem] text-muted-foreground">
              {rel.truncated && 'Shortened. '}
              <a className="text-primary" href={rel.url} target="_blank" rel="noreferrer">
                Full notes ↗
              </a>
            </p>
          </div>
        </details>
      ))}
    </div>
  )
}

/**
 * The versions between what is running and what is current, as a chain.
 *
 * Rendered above the notes when there are any, and not at all when there are
 * none — an empty box next to a full one is where a ragged column comes from.
 */
export function UpgradeChain({ behind }: { behind: string[] }) {
  if (behind.length === 0) return null

  return (
    <ol className="mb-[0.6rem] flex flex-wrap items-center gap-[0.3rem]">
      {behind.map((v, i) => (
        <li key={v} className={cn(CHAIN_STEP, i === behind.length - 1 && CHAIN_LAST)}>
          <span className={MONO}>{v}</span>
        </li>
      ))}
    </ol>
  )
}

// ── the changelog panel ────────────────────────────────────────────────────

/**
 * A changelog, whichever kind the upstream publishes.
 *
 * Two shapes, one panel, because from the reader's side they answer the same
 * question — what would I get if I updated — and which one applies is a
 * property of the project rather than a choice: a repo that cuts releases gets
 * its release notes, a repo whose image tracks a branch gets the commits since
 * the build. Pass exactly one.
 */
export function Changelog({
  gap = null,
  build = null,
  title,
  span = 12,
  aside,
  foot,
}: {
  gap?: VersionGap | null
  build?: CommitGap | null
  title?: string
  span?: 4 | 6 | 8 | 9 | 12
  aside?: ReactNode
  foot?: ReactNode
}) {
  const behind = gap?.behind.length ?? build?.behind.length ?? 0
  const unit = gap !== null ? 'to apply' : 'commits since this build'

  return (
    <Board
      title={title ?? (behind === 0 ? 'Release notes' : `${String(behind)} ${unit}`)}
      icon="logs"
      span={span}
      aside={aside ?? <span className={BOARD_NOTE}>github</span>}
    >
      {gap !== null ? (
        <>
          <UpgradeChain behind={gap.behind} />
          <ReleaseNotes
            releases={gap.releases}
            running={gap.installed}
            empty={gap.note ?? 'no published notes for this version'}
          />
        </>
      ) : build === null || build.behind.length === 0 ? (
        <p className={VIZ_EMPTY}>
          {build?.note ?? 'Nothing new on the branch since this image was built.'}
        </p>
      ) : (
        <ul className="flex flex-col gap-[0.1rem]">
          {build.behind.map((c) => (
            <li key={c.sha} className={COMMIT}>
              <a
                className={cn(MONO, 'text-muted-foreground no-underline hover:text-primary')}
                href={c.url}
                target="_blank"
                rel="noreferrer"
              >
                {c.sha}
              </a>
              <span className="truncate text-foreground">{c.subject}</span>
              <span className="text-[0.69rem] whitespace-nowrap text-muted-foreground tabular-nums">
                {c.date}
              </span>
            </li>
          ))}
        </ul>
      )}
      {foot ?? (
        <p className={BOARD_FOOT}>
          {gap !== null
            ? behind === 0
              ? 'What the running version shipped. Parsed from the project’s own GitHub releases and shortened; open one for the detail.'
              : 'Everything between the running version and the newest release, oldest at the top. Parsed from the project’s own GitHub releases and shortened; open one for the detail, and the link inside goes to the full text.'
            : 'Commits rather than releases, because this image tracks a branch instead of a tag, so this is what a re-pull would actually bring.'}
        </p>
      )}
    </Board>
  )
}
