import { useRouter } from '@tanstack/react-router'
import { useState } from 'react'
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
import { UpdateControl, UpdateProgress } from '../../image-update'
import { Changelog } from '../../release-notes'
import { usePolledStatus } from '../../status'
import { Board, BoardGrid, Chip, type Tone } from '../../viz'

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
          <span className="board-note">
            {d.probeMissing
              ? 'the registry probe has not run'
              : `registry checked ${(d.checkedAt ?? '').slice(0, 10)}`}
          </span>
        }
      >
        {behind.length === 0 ? (
          <p className="viz-empty">
            Every digest-pinned container is on the newest tag of its shape, and no channel tag has
            moved since it was pinned.
          </p>
        ) : (
          <ul className="upd-rows">
            {behind.map((r) => (
              <Row key={r.container} r={r} status={d.status} queue={bind(r)} />
            ))}
          </ul>
        )}
        <p className="board-foot">
          Pins come from the flake; the verdicts from a daily registry probe. A tag that MOVED is a
          channel pin like <span className="mono">:latest</span> whose image was replaced, so the
          update is the same tag and a new digest. A NEWER TAG is a frozen release pin with a higher
          version published beside it, and the notes inside the row are what that version contains.
        </p>
      </Board>

      <Board
        title="On the newest tag"
        icon="logs"
        span={12}
        aside={<span className="board-note">{String(rest.length)} containers</span>}
      >
        <ul className="upd-rows is-quiet">
          {rest.map((r) => (
            <Row key={r.container} r={r} status={d.status} queue={bind(r)} />
          ))}
        </ul>
        <p className="board-foot">
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
    <li className="upd-row">
      <details
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
        <summary>
          <span className="upd-name">{r.container}</span>
          <span className="upd-from mono">{r.running.version ?? r.tag}</span>
          {/* For a moved CHANNEL pin both tags are the same string, so the
              only honest thing the digests can say is "new digest" — unless
              the image states its own version, in which case that IS the
              answer and the one worth reading. */}
          <span className="upd-to mono">
            {r.verdict === 'tag-moved'
              ? (r.freshness?.remoteVersion ?? 'new digest')
              : (r.freshness?.newerTag ?? DASH)}
          </span>
          <Chip tone={v.tone}>{v.label}</Chip>
          {!r.updatable && <Chip tone="muted">pinned</Chip>}
          {/* On the closed row, because the whole point of a queue is to build
              it while scrolling past rows that are shut. */}
          {queue?.queued === true && <Chip tone="ok">queued</Chip>}
        </summary>

        <div className="upd-body">
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
          <p className="upd-ref mono">{`${r.image}@${r.digest.slice(0, 19)}…`}</p>
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
      aside={<span className="board-note">one commit, one rebuild</span>}
    >
      {mine && running ? (
        <UpdateProgress status={status} />
      ) : (
        <>
          {/* How the last batch ended, above the queue rather than instead of
              it: a failed batch reverted everything, so the list that produced
              it is still what the operator wants and is still sitting there. */}
          {mine && status.state === 'failed' && (
            <div className="upd-failed">
              <strong>The batch failed at {status.phase}.</strong>{' '}
              {status.commit === null || status.commit === ''
                ? 'Nothing was committed.'
                : 'The commit was reverted and the system rebuilt onto the previous pins — every container in it, including the ones that were fine.'}
              <pre className="apply-error">{status.error}</pre>
            </div>
          )}

          {mine && status.state === 'done' && (
            <div className="upd-done">
              <Chip tone="ok">{status.phase === 'no-change' ? 'already there' : 'updated'}</Chip>
              {status.commit !== null && status.commit !== '' && (
                <span className="mono upd-commit">{status.commit}</span>
              )}
            </div>
          )}

          <ul className="upd-queue">
            {queue.map((q) => (
              <li key={q.container}>
                <span className="upd-queue-name">{q.container}</span>
                <span className="mono">
                  {q.tag}
                  {q.toTag === null ? ' — re-pull' : ` → ${q.toTag}`}
                </span>
                {q.lockstep.length > 0 && (
                  <span className="board-note">with {q.lockstep.join(', ')}</span>
                )}
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={running}
                  onClick={() => {
                    onRemove(q.container)
                  }}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>

          {ceremonies.length > 0 && (
            // Restated here even though each was confirmed in its own row: by
            // the time six are queued, the one that takes the netns down with
            // it is three screens up.
            <ul className="upd-queue-warn">
              {ceremonies.map((q) => (
                <li key={q.container}>
                  <strong>{q.container}</strong> {q.ceremony}.
                </li>
              ))}
            </ul>
          )}

          {refusal !== null && <p className="bad-text">{refusal}</p>}

          <div className="upd-actions">
            <button
              type="button"
              className="btn btn-primary"
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
            </button>
          </div>
        </>
      )}

      <p className="board-foot">
        All of it or none of it. The queue becomes one commit and one rebuild, so if the build fails
        — or if any one of these containers does not come back on its new image — the whole commit
        is reverted and every pin here goes back, including the ones that were fine. Update a
        container on its own when you want its failure isolated.
        {alsoMoves.length > 0 && (
          <>
            {' '}
            Moving with them: <span className="mono">{alsoMoves.join(', ')}</span>.
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
      <p className="viz-empty">
        No release notes: nothing maps this container to a project whose changelog we can read. The
        tag delta above is still the real answer to what a re-pull would bring. See
        <code> lib/dashboard/image-repos.ts</code> for why a guess is not offered instead.
      </p>
    )
  }

  if (notes === null || notes.data === null) {
    return <p className="viz-empty">Reading the release notes…</p>
  }

  return <Changelog gap={notes.data.gap} build={notes.data.build} span={12} />
}
