import { Link, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import type { EngineUpdateStatus } from '../host/engine-update'
import { cn } from '../lib/cn'
import { ENGINE_REPO } from '../lib/engine'
import { DASH } from '../lib/format'
import type { EngineFacts, EngineVerdict } from '../modules/system/data/updates'
import { fetchEngineUpdateStatus, requestEngineUpdateFn } from '../server/updates'
import { usePolledStatus } from './status'
import { FOOT, MONO, MONO_FACE, NOTE } from './tokens'
import { Button } from './ui/button'
import { Board, Chip, Facts, type Tone } from './viz'

// The card that moves the engine's own pin.
//
// One home, the top of System › Updates, above the image rows — the engine is
// the one pin on that page that is not a container, and the update it offers
// is the same act aimed at the lock file: fast-forward the clone, move the
// pin, build, switch, verify that THIS control plane came back, revert if it
// did not, push. The card says all of that before the button, because the
// button restarts the page it is on.
//
// Two facts and their comparison. The lock (the repo snapshot) is what the
// box was built from; the clone's `main` (the workspace snapshot) is what an
// update would pin, and how far origin is past it as of the last fetch. The
// phases are the host agent's (stacks/daedalus/host/engine-update.sh), and a
// phase this list has not heard of still renders as progress.

const PHASES = [
  'validating',
  'waiting',
  'fetching',
  'resolving',
  'building',
  'committing',
  'switching',
  'verifying',
  'pushing',
] as const

const VERDICT: Record<EngineVerdict, { label: string; tone: Tone }> = {
  'behind-origin': { label: 'behind origin', tone: 'warn' },
  unpinned: { label: 'clone ahead of the pin', tone: 'warn' },
  current: { label: 'current', tone: 'ok' },
  unknown: { label: 'no verdict', tone: 'muted' },
}

const short = (rev: string | null | undefined): string =>
  typeof rev === 'string' && rev !== '' ? rev.slice(0, 10) : DASH

/** ISO date only — no relative clock, so the server and the browser agree. */
const day = (iso: string | null | undefined): string =>
  typeof iso === 'string' && iso !== '' ? iso.slice(0, 10) : DASH

export function EngineCard({ e }: { e: EngineFacts }) {
  const router = useRouter()
  // Whether the run on screen is one this browser started, for the reason
  // the queue panel keeps the same flag: the status file is never cleared,
  // and a finished run would otherwise sit at the top of the page forever.
  const [startedHere, setStartedHere] = useState(false)

  const { status, running, refusal, start } = usePolledStatus({
    initial: e.status,
    fetch: () => fetchEngineUpdateStatus(),
    onSettle: () => {
      // The lock moved (or did not), and this very app may have been
      // restarted under the page: re-read everything rather than trust what
      // was on screen before the switch.
      void router.invalidate()
    },
  })

  const v = VERDICT[e.verdict]
  const diverged = (e.clone?.ahead ?? 0) > 0
  const blocked = e.override !== null || diverged
  const nothingToDo = e.verdict === 'current'

  return (
    <Board title="Engine" icon="logs" span={12} aside={<Chip tone={v.tone}>{v.label}</Chip>}>
      <Facts
        rows={[
          {
            k: 'Pinned',
            v: (
              <span className={cn(MONO_FACE, 'text-[0.8rem]')}>
                {short(e.pinned?.rev)}
                {e.pinned?.lastModified != null && (
                  <span className="ml-2 text-(--dim)">{day(e.pinned.lastModified)}</span>
                )}
              </span>
            ),
          },
          {
            k: 'Clone',
            v:
              e.clone === null ? (
                <span className={NOTE}>no clone of {ENGINE_REPO} under the workspace root</span>
              ) : (
                <span className={cn(MONO_FACE, 'text-[0.8rem]')}>
                  {short(e.clone.head)}
                  <span className="ml-2 text-(--dim)">
                    {e.clone.branch ?? DASH}
                    {e.clone.dirty && ' · dirty'}
                    {(e.clone.behind ?? 0) > 0 && ` · ${String(e.clone.behind)} behind origin`}
                    {diverged && ` · ${String(e.clone.ahead)} not on origin`}
                  </span>
                </span>
              ),
          },
          {
            k: 'Last fetch',
            v: <span className={cn(MONO_FACE, 'text-[0.8rem]')}>{day(e.clone?.sync?.at)}</span>,
          },
        ]}
      />

      <div className="mt-3">
        {running || startedHere ? (
          <Run status={status} />
        ) : (
          <div className="flex flex-col items-start gap-[0.55rem]">
            {e.override !== null && (
              <p className={NOTE}>
                Refused while the engine override is set: the running system is built from{' '}
                <span className={MONO}>{e.override}</span>, not from the pinned engine. Clear it in{' '}
                <Link to="/settings" search={{ tab: 'developer' }}>
                  Settings › Developer
                </Link>{' '}
                and apply first.
              </p>
            )}
            {diverged && (
              <p className={NOTE}>
                The clone has {String(e.clone?.ahead)} commit
                {e.clone?.ahead === 1 ? '' : 's'} that are not on origin. One branch, main, always:
                push them first — the update only fast-forwards, and will refuse a clone it cannot.
              </p>
            )}
            {refusal !== null && <p className="text-danger">{refusal}</p>}
            <Button
              type="button"
              size="sm"
              disabled={running || blocked}
              onClick={() => {
                setStartedHere(true)
                start(async () => {
                  const r = await requestEngineUpdateFn()
                  // The outcome's `code` is for the scriptable door's status.
                  return r.ok ? { ok: true, value: r.id } : { ok: false, reason: r.reason }
                })
              }}
            >
              {nothingToDo ? 'Re-check daedalus' : 'Update daedalus'}
            </Button>
          </div>
        )}
      </div>

      <p className={FOOT}>
        The engine is a flake input of the configuration, pinned by commit in its lock. Updating it
        fast-forwards the clone from origin, moves the lock to the clone's{' '}
        <span className={MONO}>main</span>, builds, switches, and checks that this control plane
        answers again — reverting the lock and switching back if it does not — then pushes the lock
        commit. The page you are reading restarts along the way; it comes back on its own.
      </p>
    </Board>
  )
}

/** A run being narrated: its phases while it runs, its outcome after. */
function Run({ status }: { status: EngineUpdateStatus }) {
  const at = PHASES.indexOf(status.phase as (typeof PHASES)[number])
  const revs =
    status.from !== '' ? (
      <span className={cn(MONO_FACE, 'text-[0.76rem] text-(--dim)')}>
        {short(status.from)}
        {status.to !== '' && status.to !== status.from && ` → ${short(status.to)}`}
      </span>
    ) : null

  if (status.state === 'failed') {
    return (
      <div>
        <strong className="text-[0.82rem]">Update failed at {status.phase}.</strong>{' '}
        {status.commit === null || status.commit === ''
          ? 'Nothing was committed.'
          : 'The lock commit was reverted and the system rebuilt onto the previous engine.'}
        <pre className="mt-[0.4rem] max-h-28 overflow-auto whitespace-pre-wrap text-[0.74rem] text-danger">
          {status.error}
        </pre>
      </div>
    )
  }

  if (status.state === 'done') {
    return (
      <div className="flex flex-wrap items-center gap-[0.6rem]">
        <Chip tone="ok">{status.phase === 'no-change' ? 'already current' : 'updated'}</Chip>
        {revs}
        {status.commit !== null && status.commit !== '' && (
          <span className={cn(MONO_FACE, 'text-[0.72rem] text-muted-foreground')}>
            {status.commit}
          </span>
        )}
      </div>
    )
  }

  return (
    <div>
      <ol className="inline-flex flex-wrap gap-[0.85rem] text-[0.78rem] text-muted-foreground">
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
      {revs !== null && <div className="mt-2">{revs}</div>}
    </div>
  )
}
