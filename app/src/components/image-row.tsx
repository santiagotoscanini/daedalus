import { useState } from 'react'
import type { ImageUpdateStatus } from '../host/image-update'
import { cn } from '../lib/cn'
import type { UpdateRow, UpdateVerdict } from '../lib/dashboard/update-rows'
import { DASH } from '../lib/format'
import { fetchUpdateNotes } from '../server/updates'
import { UpdateControl } from './image-update'
import { Changelog } from './release-notes'
import { EMPTY, MONO_FACE } from './tokens'
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
// Notes load on open, once. `<details>` renders its children whether or not it
// is open, so a fetch on mount would be every row on the page asking GitHub at
// once — the budget spend that keeps notes out of the rows' own loader.

const VERDICT: Record<UpdateVerdict, { label: string; tone: Tone }> = {
  'tag-moved': { label: 'tag moved', tone: 'warn' },
  'newer-tag': { label: 'newer tag', tone: 'warn' },
  current: { label: 'current', tone: 'ok' },
  unknown: { label: 'no verdict', tone: 'muted' },
}

/* A release entry's disclosure idiom, one level up (release-notes.tsx). */
const SUMMARY = cn(
  'flex min-w-0 cursor-pointer list-none items-baseline gap-[0.7rem] px-[0.7rem] py-[0.45rem]',
  'hover:bg-(--raise) [&::-webkit-details-marker]:hidden',
  "before:text-[0.7rem] before:text-muted-foreground before:transition-transform before:duration-[0.12s] before:content-['▸']",
  'group-open:before:rotate-90',
)

export function ImageRow({
  r,
  status,
  queue,
}: {
  r: UpdateRow
  status: ImageUpdateStatus
  queue?: React.ComponentProps<typeof UpdateControl>['queue']
}) {
  const v = VERDICT[r.verdict]
  const [notes, setNotes] = useState<Notes | null>(null)

  return (
    <li>
      <details
        className="group overflow-hidden rounded-[9px] border border-(--border-soft) bg-(--panel-2)"
        onToggle={(e) => {
          if (!e.currentTarget.open || notes !== null || !r.hasNotes) return
          setNotes({ loading: true, data: null })
          void fetchUpdateNotes({ data: { container: r.container } }).then((data) => {
            setNotes({ loading: false, data })
          })
        }}
      >
        <summary className={SUMMARY}>
          <span className="min-w-[11rem] text-[0.84rem] text-foreground">{r.container}</span>
          <span className={cn(MONO_FACE, 'text-[0.76rem] text-(--text-muted)')}>
            {r.running.version ?? r.tag}
          </span>
          {/* For a moved CHANNEL pin both tags are the same string, so the
              only honest thing the digests can say is "new digest" — unless
              the image states its own version, in which case that IS the
              answer. The arrow is a ::before: punctuation, not content. */}
          <span
            className={cn(
              MONO_FACE,
              'text-[0.76rem] text-foreground',
              "before:mr-[0.25em] before:text-muted-foreground before:content-['→']",
            )}
          >
            {r.verdict === 'tag-moved'
              ? (r.freshness?.remoteVersion ?? 'new digest')
              : (r.freshness?.newerTag ?? DASH)}
          </span>
          <span className="ml-auto flex items-baseline gap-[0.4rem]">
            <Chip tone={v.tone}>{v.label}</Chip>
            {!r.updatable && <Chip tone="muted">pinned</Chip>}
            {/* On the closed row, because the whole point of a queue is to
                build it while scrolling past rows that are shut. */}
            {queue?.queued === true && <Chip tone="ok">queued</Chip>}
          </span>
        </summary>

        <div className="flex flex-col gap-[0.7rem] border-(--border-soft) border-t px-3 pt-2 pb-[0.7rem]">
          <NotesPanel notes={notes} hasNotes={r.hasNotes} />
          <UpdateControl
            target={{
              container: r.container,
              tag: r.tag,
              target: r.target,
              candidates: r.candidates,
              updatable: r.updatable,
              lockstep: r.lockstep,
              ceremony: r.ceremony,
            }}
            initialStatus={status}
            queue={queue}
          />
          {/* The exact ref this row would rewrite, last and quiet — it is what
              a person copies into a shell to check something by hand, and it
              is not part of the decision. */}
          <p className={cn(MONO_FACE, 'text-[0.68rem] text-muted-foreground')}>
            {`${r.image}@${r.digest.slice(0, 19)}…`}
          </p>
        </div>
      </details>
    </li>
  )
}

/** What one row has fetched, or is fetching. */
type Notes = { loading: boolean; data: Awaited<ReturnType<typeof fetchUpdateNotes>> | null }

function NotesPanel({ notes, hasNotes }: { notes: Notes | null; hasNotes: boolean }) {
  if (!hasNotes) {
    return (
      <p className={EMPTY}>
        No release notes: nothing maps this container to a project whose changelog we can read. The
        tag delta above is still the real answer to what a re-pull would bring. See
        <code> lib/dashboard/image-repos.ts</code> for why a guess is not offered instead.
      </p>
    )
  }

  if (notes === null || notes.data === null) {
    return <p className={EMPTY}>Reading the release notes…</p>
  }

  return <Changelog gap={notes.data.gap} build={notes.data.build} span={12} />
}
