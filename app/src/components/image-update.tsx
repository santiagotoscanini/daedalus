import { useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import type { ImageUpdateStatus } from '../host/image-update'
import { cn } from '../lib/cn'
import { ceremonyArmed, ceremonyFor } from '../lib/image-ceremony'
import { REBOOT_REQUIRED } from '../lib/reboot-required'
import { fetchImageUpdateStatus, requestImageUpdateFn } from '../server/updates'
import { TypedConfirm } from './armed-confirm'
import { RebootRequired } from './reboot-required'
import { usePolledStatus } from './status'
import { MONO, MONO_FACE } from './tokens'
import { Button } from './ui/button'
import { Picker } from './ui/picker'
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
// lives in nix/stacks/daedalus/host/image-update.sh; a phase this list has not heard of still
// renders as progress rather than blanking the tracker.
//
// ── one run, one narrator ─────────────────────────────────────────────────
//
// A queued batch is one run over several containers, so exactly one place on
// the page reports it: the queue panel. A row narrates only a run whose sole
// target IS that row, which is why `mine` reads `targets` rather than matching
// the status's back-compat `container` field. Every row drawing the same phase
// tracker for the same rebuild would be one fact copied down the page — and
// the tracker in a row would be claiming the run belongs to it.

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

const NOTE = 'm-0 text-[0.78rem] text-muted-foreground'

/* The confirmation gate, drawn as a warning rather than as a form: its job is
   to interrupt, and the blast radius sentence above the input is the reason it
   exists — the typing is only what makes the interruption deliberate. */
const CEREMONY = 'w-full rounded-xl border border-warning/40 bg-warning/8 px-3 py-2.5'

/** Everything the control needs, and nothing a caller cannot already answer. */
type UpdateTarget = {
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
  /** The same, owed only by a move to a new major. */
  majorCeremony?: string | null
}

/**
 * The batch queue, on the one page that has one.
 *
 * Absent on the service tabs: those show a single container and have nowhere
 * to put a list, so there the button is the only way to update and nothing
 * about it changes.
 */
type QueueBinding = {
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
   * can call it again when the choice changes. `typed` is what the row's
   * ceremony field holds, which the batch hands the server as its confirmation.
   */
  add: (toTag: string | null, typed: string) => void
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
  const [chosen, setChosen] = useState<string | null>(null)
  const [typed, setTyped] = useState('')

  const { status, running, refusal, start } = usePolledStatus({
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
  // Per move, not per pin: a new major can owe a ceremony its re-pull does not.
  const ceremony = ceremonyFor(t, to)
  const armed = ceremonyArmed(t.container, ceremony, typed)

  if (mine && running) return <UpdateProgress status={status} />

  if (mine && status.state === 'failed') {
    return (
      <div>
        <strong className="text-[0.82rem]">Update failed at {status.phase}.</strong>{' '}
        {status.commit === null || status.commit === ''
          ? 'Nothing was committed.'
          : 'The change was reverted and the system rebuilt onto the previous pin.'}
        <pre className="mt-1.5 mb-2 max-h-28 overflow-auto whitespace-pre-wrap text-[0.75rem] text-danger">
          {status.error}
        </pre>
        <Button type="button" variant="outline" size="sm" onClick={() => router.invalidate()}>
          Dismiss
        </Button>
      </div>
    )
  }

  if (mine && status.state === 'done' && status.phase === REBOOT_REQUIRED) {
    return <RebootRequired note={status.error} />
  }

  if (mine && status.state === 'done') {
    return (
      <div className="flex flex-wrap items-center gap-2.5">
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
    <div className="flex flex-col items-start gap-2.5">
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
        <span className={cn(NOTE, 'flex items-center gap-2')}>
          <span>Target tag</span>
          <Picker
            aria-label="Target tag"
            mono
            className="w-auto text-[0.78rem] data-[size=default]:h-8"
            value={to ?? ''}
            onChange={(v) => {
              setChosen(v)
              // A queued entry holds the tag chosen when it was added, so the
              // picker has to keep it current — otherwise the row shows one
              // tag and the batch would move to another.
              if (queue?.queued === true) {
                queue.add(v === t.tag ? null : v, typed)
              }
            }}
            options={t.candidates.map((c) => ({
              value: c,
              label: `${c}${c === t.target ? ' — newest of this shape' : ''}${c === t.tag ? ' — running' : ''}`,
            }))}
          />
        </span>
      )}

      {ceremony !== null && (
        <div className={CEREMONY}>
          <p className="mt-0 mb-2 text-[0.78rem] text-foreground">
            <strong>{t.container}</strong> {ceremony}.
          </p>
          <TypedConfirm name={t.container} value={typed} onChange={setTyped} />
        </div>
      )}

      {refusal !== null && <p className="m-0 text-[0.8rem] text-danger">{refusal}</p>}

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
                  confirm: [typed],
                },
              })
              // The outcome's `code` is for the MCP tool's caller; a person reads the sentence.
              return r.ok ? { ok: true, value: r.id } : { ok: false, reason: r.reason }
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
                queue.add(sameTag || to === null ? null : to, typed)
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
 * Exported because a queued batch is narrated by the queue panel
 * (modules/system/view/updates.tsx) instead of by a row, and a second copy of
 * the phase vocabulary would fall behind the host script's.
 */
export function UpdateProgress({ status }: { status: ImageUpdateStatus }) {
  const at = PHASES.indexOf(status.phase as (typeof PHASES)[number])
  return (
    <div>
      <ol className="m-0 inline-flex flex-wrap list-none gap-x-3.5 gap-y-1 p-0 text-[0.78rem] text-muted-foreground">
        {PHASES.map((p, i) => (
          <li
            key={p}
            className={cn(
              p === status.phase && 'text-foreground [font-weight:600]',
              i < at && 'text-muted-foreground/70 line-through',
            )}
          >
            {p}
          </li>
        ))}
        {at === -1 && status.phase !== '' && (
          <li className="text-foreground [font-weight:600]">{status.phase}</li>
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
function Moves({ status }: { status: ImageUpdateStatus }) {
  if (status.moves.length === 0) return null

  return (
    <ul className="m-0 mt-2 flex list-none flex-col gap-1 p-0 text-[0.75rem]">
      {status.moves.map((m) => (
        <li key={m.container} className={cn('flex gap-2.5', !m.changed && 'text-muted-foreground')}>
          <span className="min-w-[11rem] text-foreground">{m.container}</span>
          <span className={MONO}>
            {m.fromTag}
            {m.changed ? ` → ${m.toTag}` : ' — already there'}
          </span>
        </li>
      ))}
    </ul>
  )
}
