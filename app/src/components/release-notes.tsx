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
            {rel.sections.length === 0 ?
              <p className="viz-empty">this release shipped no written notes</p>
            : rel.sections.map((s) => (
                <section key={s.name}>
                  <h5>{s.name}</h5>
                  <ul>
                    {s.items.map((it, n) => (
                      <li key={n}>{it}</li>
                    ))}
                  </ul>
                </section>
              ))
            }
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
