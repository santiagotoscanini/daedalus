import { useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { cn } from '../lib/cn'
import type { ImageUpdateStatus } from '../lib/image-update'
import { fetchImageUpdateStatus, requestImageUpdateFn } from '../server/updates'
import { MONO, MONO_FACE } from './category/system/shared'
import { usePolledStatus } from './status'
import { Button } from './ui/button'
import { Chip } from './viz'

// The control that moves a pin.
//
// One component, two homes: a row of the Updates table, and — beside the
// changelog it belongs to — a service tab. Shared rather than written twice
// because the interesting part is not the button, it is everything that has to
// be true before the button is allowed to mean anything, and none of that
// should be decided per page.
//
// ── the phases are the point ──────────────────────────────────────────────
//
// This is a system rebuild, so it is deliberately slow, explicit and
// impossible to trigger by accident. It names the tag it is moving to, it
// names every OTHER container that moves with it, and while it runs it reports
// the phase the host agent is actually in rather than spinning. The vocabulary
// lives in host/image-update.sh; a phase this list has not heard of still
// renders as progress rather than blanking the tracker.
//
// ── one run, one narrator ─────────────────────────────────────────────────
//
// A queued batch is one run over several containers, so exactly one place on
// the page reports it: the queue panel. A row narrates only a run whose sole
// target IS that row, which is why `mine` reads `targets` rather than matching
// the status's back-compat `container` field. Sixty-five rows each drawing the
// same phase tracker for the same rebuild would be sixty-five copies of one
// fact — and the tracker in the row would be claiming the run belongs to it.

const PHASES = [
  'validating',
  'resolving',
  'pulling',
  'waiting',
  'writing',
  'committing',
  'building',
  'switching',
  'verifying',
  'pushing',
] as const

const NOTE = 'text-[0.76rem] text-muted-foreground'

/* The two small controls keep the legacy field look — monospace at the note's
   size, the panel fill, a 7px corner — rather than the shadcn field height: they
   sit inside a disclosure row, where a 36px input is taller than the row that
   opened it. */
const FIELD = cn(
  MONO_FACE,
  'rounded-[7px] border border-(--border) bg-(--panel) px-[0.4rem] py-[0.25rem] text-[0.76rem] text-foreground',
)

/* The confirmation gate, drawn as a warning rather than as a form: its job is
   to interrupt, and the blast radius sentence above the input is the reason it
   exists — the typing is only what makes the interruption deliberate. */
const CEREMONY =
  'w-full rounded-[9px] border border-warning/45 bg-warning/8 px-[0.7rem] py-[0.55rem]'

/** Everything the control needs, and nothing a caller cannot already answer. */
export type UpdateTarget = {
  container: string
  /** The tag running now. */
  tag: string
  /** Where it would go by default. Null = nowhere to go. */
  target: string | null
  /** Same-shape tags, newest first. Empty for a channel pin. */
  candidates: string[]
  updatable: boolean
  lockstep: string[]
  /** What else this takes down. Non-null demands the name be typed. */
  ceremony: string | null
}

/**
 * The batch queue, on the one page that has one.
 *
 * Absent on the service tabs: those show a single container and have nowhere
 * to put a list, so there the button is the only way to update and nothing
 * about it changes.
 */
export type QueueBinding = {
  queued: boolean
  /**
   * Set when another queued container already moves this one in lockstep.
   *
   * Adding it again would be refused by the host after the batch was already
   * assembled, so the row says so instead of offering a button that cannot
   * work.
   */
  blockedBy: string | null
  /**
   * `toTag` null means "re-pull the tag it is on" — the channel-pin case.
   *
   * Replaces an existing entry rather than adding a second, so the tag picker
   * can call it again when the choice changes.
   */
  add: (toTag: string | null) => void
  remove: () => void
}

export function UpdateControl({
  target: t,
  initialStatus,
  queue,
}: {
  target: UpdateTarget
  initialStatus: ImageUpdateStatus
  queue?: QueueBinding
}) {
  const router = useRouter()
  const [refusal, setRefusal] = useState<string | null>(null)
  const [chosen, setChosen] = useState<string | null>(null)
  const [typed, setTyped] = useState('')

  const { status, running, start } = usePolledStatus({
    initial: initialStatus,
    fetch: () => fetchImageUpdateStatus(),
    onSettle: () => {
      // A finished update changed the pin, which changes every row on the
      // page — and on failure changed nothing, which is equally worth
      // re-reading rather than leaving a stale verdict on screen.
      void router.invalidate()
    },
  })

  // Only a run whose ONE target is this container is ours to narrate. Another
  // update in flight still disables the button (one rebuild at a time,
  // enforced on the host), but its phases belong to its own row — and a batch's
  // belong to the queue panel, which is the only thing that can name all of it.
  const mine =
    status.id !== null && status.targets.length === 1 && status.targets[0] === t.container

  if (!t.updatable) {
    return (
      <p className={NOTE}>
        Pinned by policy: moving this one is not a pin edit. See
        <code> fleet.imageUpdates</code>.
      </p>
    )
  }

  const to = chosen ?? t.target
  const nothingToDo = to === null
  // A channel pin moves to the tag it is already on: the digest is the change,
  // so "update to latest" is right and "update to a newer tag" is not.
  const sameTag = to === t.tag
  const armed = t.ceremony === null || typed.trim() === t.container

  if (mine && running) return <UpdateProgress status={status} />

  if (mine && status.state === 'failed') {
    return (
      <div>
        <strong className="text-[0.82rem]">Update failed at {status.phase}.</strong>{' '}
        {status.commit === null || status.commit === ''
          ? 'Nothing was committed.'
          : 'The change was reverted and the system rebuilt onto the previous pin.'}
        <pre className="mt-[0.4rem] max-h-28 overflow-auto whitespace-pre-wrap text-[0.74rem] text-danger">
          {status.error}
        </pre>
        <Button type="button" variant="outline" size="sm" onClick={() => router.invalidate()}>
          Dismiss
        </Button>
      </div>
    )
  }

  if (mine && status.state === 'done') {
    return (
      <div className="flex flex-wrap items-center gap-[0.6rem]">
        <Chip tone="ok">{status.phase === 'no-change' ? 'already there' : 'updated'}</Chip>
        <Moves status={status} />
        {status.commit !== null && status.commit !== '' && (
          <span className={cn(MONO_FACE, 'text-[0.72rem] text-muted-foreground')}>
            {status.commit}
          </span>
        )}
      </div>
    )
  }

  if (nothingToDo) return <p className={NOTE}>Nothing newer published.</p>

  return (
    <div className="flex flex-col items-start gap-[0.55rem]">
      {/* The chain, stated before the button rather than after: a lockstep
          group moves containers the operator did not pick, and finding that
          out from a commit message afterwards is not consent. */}
      {t.lockstep.length > 0 && (
        <p className={NOTE}>
          Moves with it: <span className={MONO}>{t.lockstep.join(', ')}</span>. One release, one
          commit.
        </p>
      )}

      {t.candidates.length > 1 && (
        <label className={cn(NOTE, 'flex items-center gap-2')}>
          <span>Target tag</span>
          <select
            className={FIELD}
            value={to ?? ''}
            onChange={(e) => {
              setChosen(e.target.value)
              // A queued entry holds the tag chosen when it was added, so the
              // picker has to keep it current — otherwise the row shows one
              // tag and the batch would move to another.
              if (queue?.queued === true) {
                queue.add(e.target.value === t.tag ? null : e.target.value)
              }
            }}
          >
            {t.candidates.map((c) => (
              <option key={c} value={c}>
                {c}
                {c === t.target ? '  — newest of this shape' : ''}
                {c === t.tag ? '  — running' : ''}
              </option>
            ))}
          </select>
        </label>
      )}

      {t.ceremony !== null && (
        <div className={CEREMONY}>
          <p className="mb-2 text-[0.78rem] text-(--text-muted)">
            <strong>{t.container}</strong> {t.ceremony}.
          </p>
          <label className="flex items-center gap-2 text-[0.74rem] text-muted-foreground">
            <span>
              Type <span className={MONO}>{t.container}</span> to confirm
            </span>
            <input
              className={cn(FIELD, 'px-[0.45rem]')}
              value={typed}
              onChange={(e) => {
                setTyped(e.target.value)
              }}
              spellCheck={false}
              autoComplete="off"
            />
          </label>
        </div>
      )}

      {refusal !== null && <p className="text-danger">{refusal}</p>}

      {queue?.blockedBy != null && (
        <p className={NOTE}>
          Already queued as part of <span className={MONO}>{queue.blockedBy}</span>, which moves it
          in lockstep.
        </p>
      )}

      {/* Update now, or add to the queue — side by side, because they are the
          same decision with different timing and stacking them would read as a
          hierarchy that does not exist. */}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          disabled={running || !armed}
          onClick={() => {
            setRefusal(null)
            start(async () => {
              const r = await requestImageUpdateFn({
                data: {
                  targets: [
                    {
                      container: t.container,
                      // Omitted for a same-tag move, so the host re-resolves
                      // the tag it is on rather than being told one it knows.
                      ...(sameTag || to === null ? {} : { toTag: to }),
                    },
                  ],
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
          {running ? 'Updating…' : sameTag ? `Re-pull ${t.tag}` : `Update to ${to ?? ''}`}
        </Button>

        {/* Queueing is the same decision as updating, made now and spent
            later — so it is gated on the same `armed`: a ceremony container
            has its name typed HERE, at the moment it is chosen, rather than
            at the end when six of them would ask at once. The panel restates
            every warning before the batch runs. */}
        {queue !== undefined &&
          queue.blockedBy === null &&
          (queue.queued ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={queue.remove}
              disabled={running}
            >
              Remove from queue
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={running || !armed}
              onClick={() => {
                queue.add(sameTag || to === null ? null : to)
              }}
            >
              Add to queue
            </Button>
          ))}
      </div>
    </div>
  )
}

/**
 * The phase tracker, wherever the run is being narrated.
 *
 * Exported because a queued batch is narrated by the queue panel instead of by
 * a row, and a second copy of the phase vocabulary is a second copy that falls
 * behind host/image-update.sh.
 */
export function UpdateProgress({ status }: { status: ImageUpdateStatus }) {
  const at = PHASES.indexOf(status.phase as (typeof PHASES)[number])
  return (
    <div>
      <ol className="inline-flex gap-[0.85rem] text-[0.78rem] text-muted-foreground">
        {PHASES.map((p, i) => (
          <li
            key={p}
            className={cn(
              p === status.phase && 'font-semibold text-primary',
              i < at && 'text-(--text-muted) line-through',
            )}
          >
            {p}
          </li>
        ))}
        {at === -1 && status.phase !== '' && (
          <li className="font-semibold text-primary">{status.phase}</li>
        )}
      </ol>
      <Moves status={status} />
    </div>
  )
}

/**
 * What the host resolved this run to actually be.
 *
 * Worth showing even when it matches what the button offered: for a lockstep
 * group it is the only place the members' own tags appear, and a member marked
 * unchanged is the honest report that it was already there rather than a
 * container quietly dropped from the commit.
 */
export function Moves({ status }: { status: ImageUpdateStatus }) {
  if (status.moves.length === 0) return null

  return (
    <ul className="mt-2 flex flex-col gap-[0.2rem] text-[0.74rem]">
      {status.moves.map((m) => (
        <li
          key={m.container}
          className={cn('flex gap-[0.6rem]', !m.changed && 'text-muted-foreground')}
        >
          <span className="min-w-[11rem] text-(--text-muted)">{m.container}</span>
          <span className={MONO}>
            {m.fromTag}
            {m.changed ? ` → ${m.toTag}` : ' — already there'}
          </span>
        </li>
      ))}
    </ul>
  )
}
