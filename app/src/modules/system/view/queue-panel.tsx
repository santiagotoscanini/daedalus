import { useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { GHOST_BTN } from '../../../components/apps/shared'
import { UpdateProgress } from '../../../components/image-update'
import { RebootRequired } from '../../../components/reboot-required'
import { usePolledStatus } from '../../../components/status'
import { CAPTION, MONO, MONO_FACE, NOTE } from '../../../components/tokens'
import { Button } from '../../../components/ui/button'
import { Board, Chip } from '../../../components/viz'
import type { ImageUpdateStatus } from '../../../host/image-update'
import { cn } from '../../../lib/cn'
import { REBOOT_REQUIRED } from '../../../lib/reboot-required'
import { fetchImageUpdateStatus, requestImageUpdateFn } from '../../../server/updates'

// The Updates tab's batch queue — see updates.tsx for why there is one.

/** One queued container: what the row had decided when it was added. */
export type QueueItem = {
  container: string
  /** Null = re-pull the tag it is on, the channel-pin case. */
  toTag: string | null
  tag: string
  lockstep: string[]
  ceremony: string | null
  /** What the row's ceremony field held when it was queued: the batch's confirmation. */
  typed: string
}

/**
 * The queue, and the one button that spends it.
 *
 * Renders when there is something queued OR when a batch is already running —
 * the second case is a page opened mid-run, which has an empty queue and still
 * needs somewhere to report six containers moving.
 */
export function QueuePanel({
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
  // Whether the batch on screen is one this browser started.
  //
  // The status file is never cleared, so without this a finished batch would
  // leave a board saying so at the top of the page forever — the panel would
  // stop being the queue and become furniture. A RUNNING batch is shown to
  // everyone regardless, because it is why every button on the page is
  // disabled and that needs explaining.
  const [startedHere, setStartedHere] = useState(false)

  const { status, running, refusal, start } = usePolledStatus({
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
      aside={<span className={NOTE}>one commit, one rebuild</span>}
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
              <pre className="mt-1.5 mb-0 max-h-28 overflow-auto whitespace-pre-wrap text-[0.75rem] text-danger">
                {status.error}
              </pre>
            </div>
          )}

          {mine && status.state === 'done' && status.phase === REBOOT_REQUIRED && (
            <RebootRequired note={status.error} />
          )}

          {mine && status.state === 'done' && status.phase !== REBOOT_REQUIRED && (
            <div className="flex flex-wrap items-center gap-2.5">
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
          <ul className="m-0 flex list-none flex-col p-0 text-[0.8rem]">
            {queue.map((q) => (
              <li
                key={q.container}
                className="flex flex-wrap items-center gap-2.5 border-hairline border-t py-2 first:border-t-0 first:pt-0"
              >
                <span className="min-w-[11rem] text-foreground">{q.container}</span>
                <span className={MONO}>
                  {q.tag}
                  {q.toTag === null ? ' — re-pull' : ` → ${q.toTag}`}
                </span>
                {q.lockstep.length > 0 && (
                  <span className={NOTE}>with {q.lockstep.join(', ')}</span>
                )}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className={cn(GHOST_BTN, 'ml-auto h-7 px-2.5 text-[0.75rem]')}
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
            <ul className="m-0 flex list-none flex-col gap-1 rounded-xl border border-warning/40 bg-warning/8 px-3 py-2.5 text-[0.78rem] text-foreground">
              {ceremonies.map((q) => (
                <li key={q.container}>
                  <strong>{q.container}</strong> {q.ceremony}.
                </li>
              ))}
            </ul>
          )}

          {refusal !== null && <p className="m-0 text-[0.8rem] text-danger">{refusal}</p>}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              disabled={running || n === 0}
              onClick={() => {
                setStartedHere(true)
                start(async () => {
                  const r = await requestImageUpdateFn({
                    data: {
                      targets: queue.map((q) => ({
                        container: q.container,
                        ...(q.toTag === null ? {} : { toTag: q.toTag }),
                      })),
                      confirm: queue.map((q) => q.typed),
                    },
                  })
                  // The outcome's `code` is for the MCP tool's caller; a person reads the sentence.
                  return r.ok ? { ok: true, value: r.id } : { ok: false, reason: r.reason }
                })
              }}
            >
              {running ? 'Updating…' : `Update ${String(n)} pin${n === 1 ? '' : 's'}`}
            </Button>
          </div>
        </>
      )}

      <p className={CAPTION}>
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
