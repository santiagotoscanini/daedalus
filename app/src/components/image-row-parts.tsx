import { cn } from '../lib/cn'
import type { ManualRow } from '../lib/dashboard/update-rows'
import { ENGINE_REPO } from '../lib/engine'
import type { fetchUpdateNotes } from '../server/updates'
import { Changelog } from './release-notes'
import { EMPTY, MONO, MONO_FACE, NOTE } from './tokens'
import { Chip } from './viz'

// The open half of an image row (./image-row.tsx): what a hand-moved pin says
// beside its button, and the release notes a row loads when it opens.

/**
 * What a hand-moved pin says beside (or instead of) the button: the versions
 * that move with it, what a bump takes, and where the literal is.
 *
 * An engine file links to the engine's source on GitHub. A configuration
 * file is named, not linked — that repository is the box's own, and nothing
 * here knows where (or whether) it is published.
 */
export function ManualFacts({ r }: { r: ManualRow }) {
  const parts = Object.entries(r.parts)
  const { repo, path } = r.pinnedIn
  return (
    <div className="flex flex-col gap-2">
      {parts.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {parts.map(([name, version]) => (
            <Chip key={name}>
              {name} <span className={cn(MONO, 'ml-1')}>{version}</span>
            </Chip>
          ))}
        </div>
      )}
      {r.note !== null && <p className={NOTE}>{r.note}</p>}
      <p className={NOTE}>
        pinned in {repo} ·{' '}
        {repo === 'engine' ? (
          <a
            className={MONO}
            href={`https://github.com/${ENGINE_REPO}/blob/main/${path}`}
            target="_blank"
            rel="noreferrer"
          >
            {path}
          </a>
        ) : (
          <span className={MONO}>{path}</span>
        )}
      </p>
      {r.image !== null && r.digest !== null && (
        <p className={cn(MONO_FACE, 'm-0 text-[0.72rem] text-muted-foreground')}>
          {`${r.image}@${r.digest.slice(0, 19)}…`}
        </p>
      )}
    </div>
  )
}

/** What one row has fetched, or is fetching. */
export type Notes = {
  loading: boolean
  data: Awaited<ReturnType<typeof fetchUpdateNotes>> | null
  error: string | null
}

export function NotesPanel({ notes, hasNotes }: { notes: Notes | null; hasNotes: boolean }) {
  if (!hasNotes) {
    return (
      <p className={EMPTY}>
        No release notes: nothing maps this pin to a project whose changelog we can read. The tag
        delta above is still the real answer to what a re-pull would bring. See
        <code> lib/dashboard/image-repos.ts</code> for why a guess is not offered instead.
      </p>
    )
  }

  if (notes?.error != null) {
    return (
      <p className={cn(EMPTY, 'text-danger')}>
        Could not read the release notes (close and reopen this row to retry): {notes.error}
      </p>
    )
  }

  if (notes === null || notes.data === null) {
    return <p className={EMPTY}>Reading the release notes…</p>
  }

  return <Changelog gap={notes.data.gap} build={notes.data.build} span={12} />
}
