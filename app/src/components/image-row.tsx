import { ChevronRightIcon } from 'lucide-react'
import { useState } from 'react'
import type { ImageUpdateStatus } from '../host/image-update'
import { cn } from '../lib/cn'
import type { UpdateRow, UpdateVerdict } from '../lib/dashboard/update-rows'
import { DASH } from '../lib/format'
import { errorText } from '../lib/redact'
import { fetchUpdateNotes } from '../server/updates'
import { ManualFacts, type Notes, NotesPanel } from './image-row-parts'
import { UpdateControl } from './image-update'
import { CELL_NAME, CELL_QUIET, TABLE_HEAD, TABLE_ROW } from './table'
import { MONO_FACE } from './tokens'
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
  // Below a tablet half-window the two versions move under the name, so the
  // row is the name and its state: the one identifying cell and one value.
  '@max-[56rem]/table:grid-cols-[minmax(0,1fr)_auto]',
)
/** A table whose groups already name the verdict has no state column at all:
    pinned and queued sit beside the name instead. */
export const IMAGE_GRID_GROUPED = cn(
  'grid items-center gap-x-6 px-5',
  'grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1.3fr)]',
  '@max-[56rem]/table:grid-cols-[minmax(0,1fr)]',
)
const NARROW = '@max-[56rem]/table:hidden'
// Inside a board (no table frame) the same steps follow the BOARD's width: a
// phone's board is far narrower than its 56rem table threshold.
const CARD_GRID = '@max-[40rem]/board:grid-cols-[minmax(0,1fr)_auto]'
const CARD_NARROW = '@max-[40rem]/board:hidden'

/** The head over a `TABLE` of image rows. */
export function ImageTableHead({
  className,
  grouped,
  first = 'Container',
  iconned,
}: {
  className?: string
  grouped?: boolean
  /** The first column's heading: what each row is named after. */
  first?: string
  /** Rows carry a service icon before the name: the heading moves past it. */
  iconned?: boolean
}) {
  return (
    <li
      aria-hidden="true"
      className={cn(grouped === true ? IMAGE_GRID_GROUPED : IMAGE_GRID, TABLE_HEAD, className)}
    >
      <span className={iconned === true ? 'pl-[3.625rem]' : 'pl-6'}>{first}</span>
      <span className={NARROW}>Running</span>
      <span className={NARROW}>Available</span>
      {grouped !== true && <span className="text-right">State</span>}
    </li>
  )
}

/** A version that keeps its tail when it is cut: the part that differs
    between two tags (`…pgvectors0.3.0`) is at the end, never the start. */
function MidTrunc({
  text,
  tail = 12,
  className,
}: {
  text: string
  tail?: number
  className?: string
}) {
  if (text.length <= tail + 6)
    return <span className={cn('min-w-0 truncate', className)}>{text}</span>
  return (
    <span className={cn('flex min-w-0', className)} title={text}>
      <span className="truncate">{text.slice(0, -tail)}</span>
      <span className="flex-none">{text.slice(-tail)}</span>
    </span>
  )
}

/* The disclosure's summary: the grid, a row's height, the house hover. */
const SUMMARY = cn(
  'min-h-[3.25rem] cursor-pointer list-none py-2 text-[0.8125rem] transition-colors duration-100',
  'hover:bg-foreground/[0.025] [&::-webkit-details-marker]:hidden',
  'focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--brand-dim)]',
)

/**
 * The disclosure chevron: one drawn glyph in a fixed 16px box, turning about
 * its own centre, so a row and a group header open with the same mark at the
 * same place. A text caret rotated inside a wider box swung off its baseline.
 * `open` for a header that tracks its own state; inside a `<details>` the
 * `group-open:` variant turns it instead.
 */
export function Chevron({ open, className }: { open?: boolean; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn('mr-2 grid size-4 flex-none place-items-center', className)}
    >
      <ChevronRightIcon
        strokeWidth={2.25}
        className={cn(
          'size-3.5 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none',
          open === undefined ? 'group-open:rotate-90' : open && 'rotate-90',
        )}
      />
    </span>
  )
}

/** How far a row inside a group indents its NAME CELL, so its chevron sits
    under the group's label: the header's chevron (16 + 8) and icon (24 + 10).
    Only the name cell moves, so the version columns stay under their heads;
    on a phone-width table the indent shrinks to a step, or names truncate. */
export const NESTED_PAD = 'pl-[3.625rem] @max-[40rem]/table:pl-4'

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
  lead,
  name,
  badge,
  nested,
}: {
  r: UpdateRow
  status: ImageUpdateStatus
  queue?: React.ComponentProps<typeof UpdateControl>['queue']
  table?: 'row' | 'grouped'
  /** Drawn before the name: a service's icon, on a row that is its whole group. */
  lead?: React.ReactNode
  /** What the row is called, when that is not the container's id: a service's own name. */
  name?: string
  /** A quiet chip beside the name: what kind of pin this is when it is not a container. */
  badge?: string
  /** A member of a group whose header carries the icon: indented under it. */
  nested?: boolean
}) {
  const v = VERDICT[r.verdict]
  const [notes, setNotes] = useState<Notes | null>(null)
  const runningText = r.running.version ?? (r.kind === 'container' ? r.tag : DASH)
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
          ? 'border-hairline border-t first:border-t-0'
          : cn(
              TABLE_ROW,
              'min-h-0 py-0 [&:has(details[open])]:bg-foreground/[0.012]',
              // A group's members sit on a faint band under their header.
              nested === true && 'bg-foreground/[0.012]',
            )
      }
    >
      <details
        className={cn('group')}
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
        <summary
          className={cn(
            SUMMARY,
            table === 'grouped' ? IMAGE_GRID_GROUPED : IMAGE_GRID,
            table === undefined && cn('min-h-11 px-0.5', CARD_GRID),
            nested === true && 'min-h-11',
          )}
        >
          <span className={cn('flex min-w-0 flex-col', nested === true && NESTED_PAD)}>
            <span className="flex min-w-0 items-center">
              <Chevron />
              {lead !== undefined && <span className="mr-2.5 flex flex-none">{lead}</span>}
              <span className={cn(CELL_NAME, 'pr-1')}>{name ?? r.container}</span>
              {badge !== undefined && (
                <Chip tone="muted" className="ml-2 flex-none">
                  {badge}
                </Chip>
              )}
              {/* Pinned and queued sit beside the name where the table has no
                  state column. */}
              {table === 'grouped' && r.kind === 'container' && !r.updatable && (
                <Chip tone="muted" className="ml-2 flex-none">
                  pinned
                </Chip>
              )}
              {table === 'grouped' && queue?.queued === true && (
                <Chip tone="ok" className="ml-2 flex-none">
                  queued
                </Chip>
              )}
            </span>
            {/* Where the version columns step away, the versions are the
                name's second line: nothing is dropped, it is moved. */}
            <span className="ml-5 hidden min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0 text-[0.75rem] text-muted-foreground @max-[56rem]/table:flex @max-[40rem]/board:flex">
              <MidTrunc text={runningText} className="font-mono" />
              {/* The arrow travels with the new version: when the pair does not
                  fit on one line the new one wraps whole to a line of its own. */}
              {(available !== null || r.verdict === 'tag-moved') && (
                <span className="flex min-w-0 items-center gap-1.5">
                  <span aria-hidden="true" className="flex-none">
                    →
                  </span>
                  {available !== null ? (
                    <MidTrunc text={available} className="font-mono text-foreground" />
                  ) : (
                    <span className="whitespace-nowrap">new digest</span>
                  )}
                </span>
              )}
            </span>
          </span>
          {/* The running version wraps rather than being cut: a long tag is the
              identifying part of a pin. */}
          <span
            className={cn(
              'min-w-0 font-mono text-[0.75rem] text-muted-foreground [overflow-wrap:anywhere]',
              NARROW,
              table === undefined && CARD_NARROW,
            )}
          >
            {runningText}
          </span>
          {/* For a moved CHANNEL pin both tags are the same string, so the
              only honest thing the digests can say is "new digest" — unless
              the image states its own version, in which case that IS the
              answer. Nothing to move to is an empty cell, not "→ —" down a
              column of settled rows. */}
          <span className={cn('min-w-0', NARROW, table === undefined && CARD_NARROW)}>
            {available !== null ? (
              <span className={cn(MONO_FACE, 'flex min-w-0 text-[0.75rem] text-foreground')}>
                <span className="mr-1.5 flex-none text-muted-foreground">→</span>
                <MidTrunc text={available} />
              </span>
            ) : r.verdict === 'tag-moved' ? (
              <span className="text-[0.78rem] text-subdued">
                <span className="mr-1.5 text-muted-foreground">→</span>new digest
              </span>
            ) : null}
          </span>
          {table !== 'grouped' && (
            <span className="flex items-center justify-end gap-1.5">
              {r.verdict === 'current' && table === 'row' ? (
                <span className={CELL_QUIET}>{v.label}</span>
              ) : (
                <Chip tone={v.tone}>{v.label}</Chip>
              )}
              {r.kind === 'container' && !r.updatable && <Chip tone="muted">pinned</Chip>}
              {/* On the closed row, because the whole point of a queue is to
                  build it while scrolling past rows that are shut. */}
              {queue?.queued === true && <Chip tone="ok">queued</Chip>}
            </span>
          )}
        </summary>

        <div
          className={cn(
            'flex flex-col gap-3',
            table === undefined
              ? 'px-0.5 pt-1 pb-3 pl-5.5'
              : cn(
                  'pt-1 pr-5 pb-5',
                  nested === true ? 'pl-[6.375rem] @max-[40rem]/table:pl-15' : 'pl-11',
                ),
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
