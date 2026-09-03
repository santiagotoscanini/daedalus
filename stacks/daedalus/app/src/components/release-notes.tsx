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
import type { CommitGap, VersionGap } from '../lib/dashboard/github'
import { Board } from './viz'

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
  if (releases.length === 0) return <p className="viz-empty">{empty}</p>

  return (
    <div className="changelog">
      {releases.map((rel) => (
        <details key={rel.version} className="rel">
          <summary>
            <span className="rel-version mono">{rel.version}</span>
            {rel.version === running && <span className="rel-running">running</span>}
            <span className="rel-date">{rel.date}</span>
            <span className="rel-count">{rel.sections.map((s) => s.name).join(' · ')}</span>
          </summary>
          <div className="rel-body">
            {rel.sections.length === 0 ? (
              <p className="viz-empty">this release shipped no written notes</p>
            ) : (
              rel.sections.map((s) => (
                <section key={s.name}>
                  <h5>{s.name}</h5>
                  <ul>
                    {s.items.map((it, n) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: release notes are a static list — items never reorder or update in place.
                      <li key={n}>{it}</li>
                    ))}
                  </ul>
                </section>
              ))
            )}
            <p className="rel-more">
              {rel.truncated && 'Shortened. '}
              <a href={rel.url} target="_blank" rel="noreferrer">
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
    <ol className="relchain">
      {behind.map((v, i) => (
        <li key={v} className={i === behind.length - 1 ? 'relchain-last' : ''}>
          <span className="mono">{v}</span>
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
      aside={aside ?? <span className="board-note">github</span>}
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
        <p className="viz-empty">
          {build?.note ?? 'Nothing new on the branch since this image was built.'}
        </p>
      ) : (
        <ul className="commits">
          {build.behind.map((c) => (
            <li key={c.sha}>
              <a className="mono" href={c.url} target="_blank" rel="noreferrer">
                {c.sha}
              </a>
              <span className="commit-subject">{c.subject}</span>
              <span className="commit-date">{c.date}</span>
            </li>
          ))}
        </ul>
      )}
      {foot ?? (
        <p className="board-foot">
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
