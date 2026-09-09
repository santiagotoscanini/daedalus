import { useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { cn } from '../../../lib/cn'
import type {
  UpdateRow,
  UpdatesData,
  UpdateVerdict,
} from '../../../lib/dashboard/categories/system/updates'
import { DASH } from '../../../lib/format'
import type { ImageUpdateStatus } from '../../../lib/image-update'
import {
  fetchImageUpdateStatus,
  fetchUpdateNotes,
  requestImageUpdateFn,
} from '../../../server/updates'
import { GHOST_BTN } from '../../apps/shared'
import { UpdateControl, UpdateProgress } from '../../image-update'
import { Changelog } from '../../release-notes'
import { usePolledStatus } from '../../status'
import { Button } from '../../ui/button'
import { Board, BoardGrid, Chip, type Tone } from '../../viz'
import { BOARD_FOOT, BOARD_NOTE, MONO, MONO_FACE, VIZ_EMPTY } from './shared'

// Every pinned image on the box, and what it would take to move it.
//
// The one page here whose subject is the fleet rather than a service — and the
// only place a third of these containers appear at all. The exporters, the
// redis and postgres sidecars, the *arr janitors, the exporters
// behind one web app: none has a tab, none will get one, and every one of them
// carries a pin that ages exactly like Jellyfin's.
//
// ── the row is the unit, and it opens ─────────────────────────────────────
//
// Closed, a row is the decision in one line: what is running, what is
// available, and how confident the verdict is. Open, it is the reason —
// release notes between the two versions, the tag picker, and the button.
//
// That order is the whole argument of the page. Reading what changed is not a
// step before updating, it IS the update decision, and a button reachable
// without passing the notes is a button that gets pressed without them. So the
// control lives INSIDE the disclosure, never in the closed row.
//
// Notes load per row, on open. Sixty-five GitHub release lists on page load
// would spend an hourly budget answering a question about sixty-four
// containers nobody asked about — see the loader for the rest of that.
//
// ── the queue ─────────────────────────────────────────────────────────────
//
// Reading sixty-five rows and deciding six of them should move is one sitting;
// six rebuilds, six rounds of container restarts and six waits is not. So a row
// can be added to a queue instead of updated, and the queue goes to the host as
// ONE request: one commit, one build, one switch.
//
// The queue lives in this component's state and nowhere else. It is a
// selection, not a commitment — nothing has been asked of the host until the
// button is pressed, so there is nothing for a reload to lose except the
// clicking, and persisting it would mean a schema, a stale-entry problem, and
// two operators' queues to reconcile on a box that has one operator.
//
// What it does NOT do is soften the decision. Each entry was armed in its own
// row, behind that row's changelog and its ceremony prompt if it has one, and
// the panel restates every warning before the button. The all-or-nothing
// consequence is stated there too, because it is the one thing batching
// changes about the outcome: a single bad image reverts the whole commit.

const VERDICT: Record<UpdateVerdict, { label: string; tone: Tone }> = {
  'tag-moved': { label: 'tag moved', tone: 'warn' },
  'newer-tag': { label: 'newer tag', tone: 'warn' },
  current: { label: 'current', tone: 'ok' },
  unknown: { label: 'no verdict', tone: 'muted' },
}

const ROWS = 'flex flex-col gap-[0.3rem]'

/* A row is a disclosure, and the same disclosure idiom as a release entry —
   same triangle, same hover, same open rotation. Deliberately: opening a
   container here and opening a release inside it are the same gesture one
   level apart, and two different affordances for that would read as two
   different kinds of thing. */
const SUMMARY = cn(
  'flex min-w-0 cursor-pointer list-none items-baseline gap-[0.7rem] px-[0.7rem] py-[0.45rem]',
  'hover:bg-(--raise) [&::-webkit-details-marker]:hidden',
  "before:text-[0.7rem] before:text-muted-foreground before:transition-transform before:duration-[0.12s] before:content-['▸']",
  'group-open:before:rotate-90',
)

/** One queued container: what the row had decided when it was added. */
type QueueItem = {
  container: string
  /** Null = re-pull the tag it is on, the channel-pin case. */
  toTag: string | null
  tag: string
  lockstep: string[]
  ceremony: string | null
}

export function UpdatesView({ d }: { d: UpdatesData }) {
  const behind = d.rows.filter((r) => r.verdict === 'tag-moved' || r.verdict === 'newer-tag')
  const rest = d.rows.filter((r) => r.verdict === 'current' || r.verdict === 'unknown')

  const [queue, setQueue] = useState<QueueItem[]>([])

  // Which containers the queue already accounts for, and on whose behalf.
  // A lockstep member is covered by its primary, so queueing immich covers
  // immich-machine-learning — and the host would refuse the pair anyway.
  const covered = new Map<string, string>()
  for (const q of queue) {
    covered.set(q.container, q.container)
    for (const m of q.lockstep) covered.set(m, q.container)
  }

  const bind = (r: UpdateRow) => {
    const owner = covered.get(r.container)
    return {
      queued: owner === r.container,
      blockedBy: owner === undefined || owner === r.container ? null : owner,
      add: (toTag: string | null) => {
        setQueue((q) => [
          ...q.filter((i) => i.container !== r.container),
          {
            container: r.container,
            toTag,
            tag: r.tag,
            lockstep: r.lockstep,
            ceremony: r.ceremony,
          },
        ])
      },
      remove: () => {
        setQueue((q) => q.filter((i) => i.container !== r.container))
      },
    }
  }

  return (
    <BoardGrid>
      <QueuePanel
        queue={queue}
        initialStatus={d.status}
        onRemove={(c) => {
          setQueue((q) => q.filter((i) => i.container !== c))
        }}
        onClear={() => {
          setQueue([])
        }}
      />
      <Board
        title={d.behind === 0 ? 'Everything is on its newest tag' : `${String(d.behind)} behind`}
        icon="logs"
        span={12}
        aside={
          <span className={BOARD_NOTE}>
            {d.probeMissing
              ? 'the registry probe has not run'
              : `registry checked ${(d.checkedAt ?? '').slice(0, 10)}`}
          </span>
        }
      >
        {behind.length === 0 ? (
          <p className={VIZ_EMPTY}>
            Every digest-pinned container is on the newest tag of its shape, and no channel tag has
            moved since it was pinned.
          </p>
        ) : (
          <ul className={ROWS}>
            {behind.map((r) => (
              <Row key={r.container} r={r} status={d.status} queue={bind(r)} />
            ))}
          </ul>
        )}
        <p className={BOARD_FOOT}>
          Pins come from the flake; the verdicts from a daily registry probe. A tag that MOVED is a
          channel pin like <span className={MONO}>:latest</span> whose image was replaced, so the
          update is the same tag and a new digest. A NEWER TAG is a frozen release pin with a higher
          version published beside it, and the notes inside the row are what that version contains.
        </p>
      </Board>

      <Board
        title="On the newest tag"
        icon="logs"
        span={12}
        aside={<span className={BOARD_NOTE}>{String(rest.length)} containers</span>}
      >
        {/* The settled half of the page. Dimmed as a group rather than per
            row: it is a long list whose whole message is "nothing to do here",
            and sixty rows at full contrast compete with the eight that need
            reading. */}
        <ul className={cn(ROWS, 'opacity-[0.72] hover:opacity-100')}>
          {rest.map((r) => (
            <Row key={r.container} r={r} status={d.status} queue={bind(r)} />
          ))}
        </ul>
        <p className={BOARD_FOOT}>
          Open one to read what its current version shipped. “No verdict” means the registry did not
          answer for it, or the pin names a channel with nothing to compare against. Treat it as
          unknown.
        </p>
      </Board>
    </BoardGrid>
  )
}

function Row({
  r,
  status,
  queue,
}: {
  r: UpdateRow
  status: UpdatesData['status']
  queue: React.ComponentProps<typeof UpdateControl>['queue']
}) {
  const v = VERDICT[r.verdict]
  const [notes, setNotes] = useState<Notes | null>(null)

  return (
    <li>
      <details
        className="group overflow-hidden rounded-[9px] border border-(--border-soft) bg-(--panel-2)"
        onToggle={(e) => {
          // On open, once. `<details>` renders its children whether or not it
          // is open, so a fetch on mount would be every row on the page asking
          // GitHub at once — which is the all-at-once load the loader exists
          // to avoid. `notes` doubles as the has-run flag.
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
              answer and the one worth reading.

              The arrow is a ::before rather than markup: it is punctuation
              between two versions, not content, and a JSX string would put it
              in the accessibility tree as a word. */}
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

/**
 * The queue, and the one button that spends it.
 *
 * Renders when there is something queued OR when a batch is already running —
 * the second case is a page opened mid-run, which has an empty queue and still
 * needs somewhere to report six containers moving.
 */
function QueuePanel({
  queue,
  initialStatus,
  onRemove,
  onClear,
}: {
  queue: QueueItem[]
  initialStatus: ImageUpdateStatus
  onRemove: (container: string) => void
  onClear: () => void
}) {
  const router = useRouter()
  const [refusal, setRefusal] = useState<string | null>(null)
  // Whether the batch on screen is one this browser started.
  //
  // The status file is never cleared, so without this a finished batch would
  // leave a board saying so at the top of the page forever — the panel would
  // stop being the queue and become furniture. A RUNNING batch is shown to
  // everyone regardless, because it is why every button on the page is
  // disabled and that needs explaining.
  const [startedHere, setStartedHere] = useState(false)

  const { status, running, start } = usePolledStatus({
    initial: initialStatus,
    fetch: () => fetchImageUpdateStatus(),
    onSettle: (s) => {
      // Cleared only on success. A failed batch reverted every pin it touched,
      // so the queue is still exactly what the operator wanted — emptying it
      // would make them rebuild the list to retry.
      if (s.state === 'done') onClear()
      void router.invalidate()
    },
  })

  // A batch is this panel's to narrate; a single-container run belongs to its
  // own row. `targets` is what says which, so a run started before this page
  // loaded is picked up correctly either way.
  const isBatch = status.id !== null && status.targets.length > 1
  const mine = isBatch && (running || startedHere)

  if (queue.length === 0 && !mine) return null

  const ceremonies = queue.filter((q) => q.ceremony !== null)
  const alsoMoves = queue.flatMap((q) => q.lockstep)
  const n = queue.length

  const title =
    mine && running
      ? 'Updating the queue'
      : n > 0
        ? `${String(n)} queued`
        : status.state === 'failed'
          ? 'The last batch failed'
          : 'The last batch finished'

  return (
    <Board
      title={title}
      icon="logs"
      span={12}
      aside={<span className={BOARD_NOTE}>one commit, one rebuild</span>}
    >
      {mine && running ? (
        <UpdateProgress status={status} />
      ) : (
        <>
          {/* How the last batch ended, above the queue rather than instead of
              it: a failed batch reverted everything, so the list that produced
              it is still what the operator wants and is still sitting there. */}
          {mine && status.state === 'failed' && (
            <div>
              <strong className="text-[0.82rem]">The batch failed at {status.phase}.</strong>{' '}
              {status.commit === null || status.commit === ''
                ? 'Nothing was committed.'
                : 'The commit was reverted and the system rebuilt onto the previous pins — every container in it, including the ones that were fine.'}
              <pre className="mt-[0.4rem] max-h-28 overflow-auto whitespace-pre-wrap text-[0.74rem] text-danger">
                {status.error}
              </pre>
            </div>
          )}

          {mine && status.state === 'done' && (
            <div className="flex flex-wrap items-center gap-[0.6rem]">
              <Chip tone="ok">{status.phase === 'no-change' ? 'already there' : 'updated'}</Chip>
              {status.commit !== null && status.commit !== '' && (
                <span className={cn(MONO_FACE, 'text-[0.72rem] text-muted-foreground')}>
                  {status.commit}
                </span>
              )}
            </div>
          )}

          {/* What a single rebuild is about to move. One row per container,
              laid out like the host's own resolved list so the list you built
              and the list it resolved read as the same kind of thing. */}
          <ul className="mb-[0.7rem] flex flex-col gap-[0.35rem] text-[0.76rem]">
            {queue.map((q) => (
              <li
                key={q.container}
                className="flex flex-wrap items-center gap-[0.6rem] border-(--border-soft) border-b pb-[0.35rem] last:border-b-0"
              >
                <span className="min-w-[11rem] text-(--text-muted)">{q.container}</span>
                <span className={MONO}>
                  {q.tag}
                  {q.toTag === null ? ' — re-pull' : ` → ${q.toTag}`}
                </span>
                {q.lockstep.length > 0 && (
                  <span className={BOARD_NOTE}>with {q.lockstep.join(', ')}</span>
                )}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className={cn(GHOST_BTN, 'ml-auto h-auto px-[0.55rem] py-[0.2rem] text-[0.7rem]')}
                  disabled={running}
                  onClick={() => {
                    onRemove(q.container)
                  }}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>

          {ceremonies.length > 0 && (
            // Restated here even though each was confirmed in its own row: by
            // the time six are queued, the one that takes the netns down with
            // it is three screens up.
            <ul className="mb-[0.7rem] flex flex-col gap-[0.3rem] rounded-[9px] border border-warning/45 bg-warning/8 px-[0.7rem] py-[0.55rem] text-[0.76rem] text-(--text-muted)">
              {ceremonies.map((q) => (
                <li key={q.container}>
                  <strong>{q.container}</strong> {q.ceremony}.
                </li>
              ))}
            </ul>
          )}

          {refusal !== null && <p className="text-danger">{refusal}</p>}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              disabled={running || n === 0}
              onClick={() => {
                setRefusal(null)
                setStartedHere(true)
                start(async () => {
                  const r = await requestImageUpdateFn({
                    data: {
                      targets: queue.map((q) => ({
                        container: q.container,
                        ...(q.toTag === null ? {} : { toTag: q.toTag }),
                      })),
                    },
                  })
                  if (!r.ok) {
                    setRefusal(r.reason)
                    return null
                  }
                  return r.id
                })
              }}
            >
              {running ? 'Updating…' : `Update ${String(n)} container${n === 1 ? '' : 's'}`}
            </Button>
          </div>
        </>
      )}

      <p className={BOARD_FOOT}>
        All of it or none of it. The queue becomes one commit and one rebuild, so if the build fails
        — or if any one of these containers does not come back on its new image — the whole commit
        is reverted and every pin here goes back, including the ones that were fine. Update a
        container on its own when you want its failure isolated.
        {alsoMoves.length > 0 && (
          <>
            {' '}
            Moving with them: <span className={MONO}>{alsoMoves.join(', ')}</span>.
          </>
        )}
      </p>
    </Board>
  )
}

/** What one row has fetched, or is fetching. */
type Notes = { loading: boolean; data: Awaited<ReturnType<typeof fetchUpdateNotes>> | null }

function NotesPanel({ notes, hasNotes }: { notes: Notes | null; hasNotes: boolean }) {
  if (!hasNotes) {
    return (
      <p className={VIZ_EMPTY}>
        No release notes: nothing maps this container to a project whose changelog we can read. The
        tag delta above is still the real answer to what a re-pull would bring. See
        <code> lib/dashboard/image-repos.ts</code> for why a guess is not offered instead.
      </p>
    )
  }

  if (notes === null || notes.data === null) {
    return <p className={VIZ_EMPTY}>Reading the release notes…</p>
  }

  return <Changelog gap={notes.data.gap} build={notes.data.build} span={12} />
}
