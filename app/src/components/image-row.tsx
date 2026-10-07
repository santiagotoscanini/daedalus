import { useState } from 'react'
import type { ImageUpdateStatus } from '../host/image-update'
import { cn } from '../lib/cn'
import type { ManualRow, UpdateRow, UpdateVerdict } from '../lib/dashboard/update-rows'
import { ENGINE_REPO } from '../lib/engine'
import { DASH } from '../lib/format'
import { errorText } from '../lib/redact'
import { fetchUpdateNotes } from '../server/updates'
import { UpdateControl } from './image-update'
import { Changelog } from './release-notes'
import { CELL_MONO, CELL_NAME, CELL_QUIET, TABLE_HEAD, TABLE_ROW } from './table'
import { EMPTY, MONO, MONO_FACE, NOTE } from './tokens'
import { Chip, type Tone } from './viz'

// One pinned container as a disclosure: closed, the decision in one line —
// what runs, what is available, how sure the verdict is; open, the reason —
// release notes between the two, the tag picker, and the button.
//
// That order is the argument. Reading what changed is not a step before
// updating, it IS the update decision, so the control lives INSIDE the
// disclosure, never on the closed row. Who draws these rows:
// lib/dashboard/update-rows.ts.
//
// A MANUAL row (a pin that is not a container's own image) opens the same
// way and says which file holds the literal. When that file is the
// configuration's and the pin is a local build's base, the button is there
// too — the same control, moving the pin by its id; otherwise saying where the
// literal lives is the whole instruction.
//
// Notes load on open, once. `<details>` renders its children whether or not it
// is open, so a fetch on mount would be every row on the page asking GitHub at
// once — the budget spend that keeps notes out of the rows' own loader.

const VERDICT: Record<UpdateVerdict, { label: string; tone: Tone }> = {
  'tag-moved': { label: 'tag moved', tone: 'warn' },
  'newer-tag': { label: 'newer tag', tone: 'warn' },
  current: { label: 'current', tone: 'ok' },
  unknown: { label: 'no verdict', tone: 'muted' },
}

/* ── the columns ─────────────────────────────────────────────────────────

   One grid for the closed row and for the head above a table of them, so a
   container's running version sits under "Running" whichever list it is in:
   name · running · available · state. The available version steps away on a
   narrow table (it is in the open row), then the running one. Outside a
   `TABLE` (no `table` query container) the base grid is the one that applies. */
export const IMAGE_GRID = cn(
  'grid items-center gap-x-6 px-5',
  'grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1.3fr)_7.5rem]',
  '@max-[44rem]/table:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_7.5rem]',
  '@max-[30rem]/table:grid-cols-[minmax(0,1fr)_7.5rem]',
)
const NARROW = '@max-[44rem]/table:hidden'
const NARROWER = '@max-[30rem]/table:hidden'

/** The head over a `TABLE` of image rows. */
export function ImageTableHead({ className }: { className?: string }) {
  return (
    <li aria-hidden="true" className={cn(IMAGE_GRID, TABLE_HEAD, className)}>
      <span className="pl-5">Container</span>
      <span className={NARROWER}>Running</span>
      <span className={NARROW}>Available</span>
      <span className="text-right">State</span>
    </li>
  )
}

/* The disclosure's summary: the grid, a row's height, the house hover. */
const SUMMARY = cn(
  IMAGE_GRID,
  'min-h-[3.25rem] cursor-pointer list-none py-2 text-[0.8125rem] transition-colors duration-100',
  'hover:bg-foreground/[0.025] [&::-webkit-details-marker]:hidden',
  'focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--brand-dim)]',
)

/* The caret, a cell of its own inside the name column — a ::before would be
   a grid item and push every column one to the right. */
const CARET =
  "inline-block w-5 flex-none text-[0.7rem] text-muted-foreground transition-transform duration-[0.12s] group-open:rotate-90 before:content-['▸']"

/**
 * One pinned image.
 *
 * `table` places the row inside a `TABLE` (components/table.tsx) under
 * `ImageTableHead`: flat, hairline-separated, 52px. Without it the row is the
 * bordered disclosure a board's own short list draws. `'grouped'` is a table
 * whose `TableGroup`s already name the verdict, so the row does not repeat it —
 * only what differs from its group (pinned, queued) keeps a chip.
 */
export function ImageRow({
  r,
  status,
  queue,
  table,
}: {
  r: UpdateRow
  status: ImageUpdateStatus
  queue?: React.ComponentProps<typeof UpdateControl>['queue']
  table?: 'row' | 'grouped'
}) {
  const v = VERDICT[r.verdict]
  const [notes, setNotes] = useState<Notes | null>(null)
  const available =
    r.verdict === 'tag-moved'
      ? (r.freshness?.remoteVersion ?? null)
      : r.verdict === 'newer-tag'
        ? (r.freshness?.newerTag ?? null)
        : null

  return (
    <li
      className={
        table === undefined
          ? undefined
          : cn(TABLE_ROW, 'min-h-0 py-0 [&:has(details[open])]:bg-foreground/[0.012]')
      }
    >
      <details
        className={cn(
          'group',
          table === undefined && 'overflow-hidden rounded-xl border border-hairline',
        )}
        onToggle={(e) => {
          // A failed read is not cached: closing and reopening asks again.
          if (!e.currentTarget.open || (notes !== null && notes.error === null) || !r.hasNotes)
            return
          setNotes({ loading: true, data: null, error: null })
          void fetchUpdateNotes({ data: { container: r.container } })
            .then((data) => {
              setNotes({ loading: false, data, error: null })
            })
            .catch((err: unknown) => {
              setNotes({ loading: false, data: null, error: errorText(err) })
            })
        }}
      >
        <summary className={cn(SUMMARY, table === undefined && 'min-h-11 px-3')}>
          <span className="flex min-w-0 items-center">
            <span aria-hidden="true" className={CARET} />
            <span className={CELL_NAME}>{r.container}</span>
          </span>
          <span className={cn(CELL_MONO, 'text-[0.75rem]', NARROWER)}>
            {r.running.version ?? (r.kind === 'container' ? r.tag : DASH)}
          </span>
          {/* For a moved CHANNEL pin both tags are the same string, so the
              only honest thing the digests can say is "new digest" — unless
              the image states its own version, in which case that IS the
              answer. Nothing to move to is an empty cell, not "→ —" down a
              column of settled rows. */}
          <span className={cn('min-w-0 truncate', NARROW)}>
            {available !== null ? (
              <span className={cn(MONO_FACE, 'text-[0.75rem] text-foreground')}>
                <span className="mr-1.5 text-muted-foreground">→</span>
                {available}
              </span>
            ) : r.verdict === 'tag-moved' ? (
              <span className="text-[0.78rem] text-subdued">
                <span className="mr-1.5 text-muted-foreground">→</span>new digest
              </span>
            ) : null}
          </span>
          <span className="flex items-center justify-end gap-1.5">
            {/* A grouped table names the verdict once, in the group. */}
            {table !== 'grouped' &&
              (r.verdict === 'current' && table === 'row' ? (
                <span className={CELL_QUIET}>{v.label}</span>
              ) : (
                <Chip tone={v.tone}>{v.label}</Chip>
              ))}
            {r.kind === 'container' && !r.updatable && <Chip tone="muted">pinned</Chip>}
            {/* On the closed row, because the whole point of a queue is to
                build it while scrolling past rows that are shut. */}
            {queue?.queued === true && <Chip tone="ok">queued</Chip>}
          </span>
        </summary>

        <div
          className={cn(
            'flex flex-col gap-3',
            table === undefined
              ? 'border-hairline border-t px-3 pt-3 pb-3'
              : 'pt-1 pr-5 pb-5 pl-10',
          )}
        >
          <NotesPanel notes={notes} hasNotes={r.hasNotes} />
          {/* A manual row draws the button only when its base is the
              configuration's to move; a container row always does, even to
              say that policy pins it. */}
          {(r.kind === 'container' || (r.updatable && r.tag !== null)) && (
            <UpdateControl
              target={{
                container: r.container,
                tag: r.tag ?? '',
                target: r.target,
                candidates: r.candidates,
                updatable: r.updatable,
                lockstep: r.lockstep,
                ceremony: r.ceremony,
                majorCeremony: r.majorCeremony,
              }}
              initialStatus={status}
              queue={queue}
            />
          )}
          {r.kind === 'manual' ? (
            <ManualFacts r={r} />
          ) : (
            // The exact ref this row would rewrite, last and quiet — it is
            // what a person copies into a shell to check something by hand,
            // and it is not part of the decision.
            <p className={cn(MONO_FACE, 'm-0 text-[0.72rem] text-muted-foreground')}>
              {`${r.image}@${r.digest.slice(0, 19)}…`}
            </p>
          )}
        </div>
      </details>
    </li>
  )
}

/**
 * What a hand-moved pin says beside (or instead of) the button: the versions
 * that move with it, what a bump takes, and where the literal is.
 *
 * An engine file links to the engine's source on GitHub. A configuration
 * file is named, not linked — that repository is the box's own, and nothing
 * here knows where (or whether) it is published.
 */
function ManualFacts({ r }: { r: ManualRow }) {
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
type Notes = {
  loading: boolean
  data: Awaited<ReturnType<typeof fetchUpdateNotes>> | null
  error: string | null
}

function NotesPanel({ notes, hasNotes }: { notes: Notes | null; hasNotes: boolean }) {
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
