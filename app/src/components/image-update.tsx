import { useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import type { ImageUpdateStatus } from '../lib/image-update'
import { fetchImageUpdateStatus, requestImageUpdateFn } from '../server/updates'
import { usePolledStatus } from './status'
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

export function UpdateControl({
  target: t,
  initialStatus,
}: {
  target: UpdateTarget
  initialStatus: ImageUpdateStatus
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

  // Only this container's run is ours to narrate. Another update in flight
  // still disables the button (one rebuild at a time, enforced on the host),
  // but its phases belong to its own row.
  const mine = status.container === t.container && status.id !== null

  if (!t.updatable) {
    return (
      <p className="upd-note">
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

  if (mine && running) {
    const at = PHASES.indexOf(status.phase as (typeof PHASES)[number])
    return (
      <div className="upd-running">
        <ol className="phases">
          {PHASES.map((p, i) => (
            <li key={p} className={p === status.phase ? 'now' : i < at ? 'past' : ''}>
              {p}
            </li>
          ))}
          {at === -1 && status.phase !== '' && <li className="now">{status.phase}</li>}
        </ol>
        <Moves status={status} />
      </div>
    )
  }

  if (mine && status.state === 'failed') {
    return (
      <div className="upd-failed">
        <strong>Update failed at {status.phase}.</strong>{' '}
        {status.commit === null || status.commit === ''
          ? 'Nothing was committed.'
          : 'The change was reverted and the system rebuilt onto the previous pin.'}
        <pre className="apply-error">{status.error}</pre>
        <button type="button" className="btn" onClick={() => router.invalidate()}>
          Dismiss
        </button>
      </div>
    )
  }

  if (mine && status.state === 'done') {
    return (
      <div className="upd-done">
        <Chip tone="ok">{status.phase === 'no-change' ? 'already there' : 'updated'}</Chip>
        <Moves status={status} />
        {status.commit !== null && status.commit !== '' && (
          <span className="mono upd-commit">{status.commit}</span>
        )}
      </div>
    )
  }

  if (nothingToDo) return <p className="upd-note">Nothing newer published.</p>

  return (
    <div className="upd">
      {/* The chain, stated before the button rather than after: a lockstep
          group moves containers the operator did not pick, and finding that
          out from a commit message afterwards is not consent. */}
      {t.lockstep.length > 0 && (
        <p className="upd-note">
          Moves with it: <span className="mono">{t.lockstep.join(', ')}</span>. One release, one
          commit.
        </p>
      )}

      {t.candidates.length > 1 && (
        <label className="upd-pick">
          <span>Target tag</span>
          <select
            value={to ?? ''}
            onChange={(e) => {
              setChosen(e.target.value)
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
        <div className="upd-ceremony">
          <p>
            <strong>{t.container}</strong> {t.ceremony}.
          </p>
          <label>
            <span>
              Type <span className="mono">{t.container}</span> to confirm
            </span>
            <input
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

      {refusal !== null && <p className="bad-text">{refusal}</p>}

      <button
        type="button"
        className="btn btn-primary"
        disabled={running || !armed}
        onClick={() => {
          setRefusal(null)
          start(async () => {
            const r = await requestImageUpdateFn({
              data: {
                container: t.container,
                // Omitted for a same-tag move, so the host re-resolves the tag
                // it is on rather than being told a tag it already knows.
                ...(sameTag || to === null ? {} : { toTag: to }),
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
      </button>
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
    <ul className="upd-moves">
      {status.moves.map((m) => (
        <li key={m.container} className={m.changed ? '' : 'is-noop'}>
          <span className="upd-move-name">{m.container}</span>
          <span className="mono">
            {m.fromTag}
            {m.changed ? ` → ${m.toTag}` : ' — already there'}
          </span>
        </li>
      ))}
    </ul>
  )
}
