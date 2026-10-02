// The three things the box does to a machine's Lemonade: install or update it
// to a release (armed — the server stops for it), start or stop it, and have
// it start on its own. Install and power are verbs the page follows to their
// ending like a model load (model-row.tsx); always-on is the policy alone.

import { useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { GHOST_BTN } from '../../../../components/apps/shared'
import { ARM_MS, ArmedConfirm, RESTART, RESTART_STATE } from '../../../../components/armed-confirm'
import { usePoll } from '../../../../components/poll'
import { ReleaseNotes, UpgradeChain } from '../../../../components/release-notes'
import { Toggle } from '../../../../components/slider'
import { EMPTY, MONO } from '../../../../components/tokens'
import { Button } from '../../../../components/ui/button'
import { useAction } from '../../../../components/use-action'
import { useArmed } from '../../../../components/use-armed'
import { useVerbRequest } from '../../../../components/verb-request'
import type { LifecyclePhase } from '../../../../host/controller/generated'
import { cn } from '../../../../lib/cn'
import { errorText } from '../../../../lib/redact'
import { useShown } from '../../../../lib/shown'
import {
  fetchProviderActionFn,
  fetchProviderNotesFn,
  installProviderFn,
  powerProviderFn,
  setProviderAlwaysOnFn,
} from '../../../../server/providers'
import type { ProviderMachine } from '../../data/providers'

/** An install downloads and runs an installer, and may roll back: give it the time. */
const INSTALL_WITHIN_MS = 20 * 60_000
/** A start waits for the server's health; a stop for its shutdown. */
const POWER_WITHIN_MS = 120_000
/** While a verb runs, how often the page re-reads the machine's report for its phase. */
const PHASE_POLL_MS = 5_000

/** An install that has not reached its ending yet. */
export const underWay = (phase: LifecyclePhase | undefined): boolean =>
  phase !== undefined && phase !== 'done' && phase !== 'failed' && phase !== 'rolled_back'

/** A lifecycle verb on `m`, followed to its ending; the page re-reads while it runs. */
function useLifecycle(m: ProviderMachine, waitMs: number) {
  const router = useRouter()
  const verb = useVerbRequest({
    get: (request) => fetchProviderActionFn({ data: { machine: m.machine, request } }),
    waitMs,
    onSettle: () => {
      void router.invalidate()
    },
  })
  usePoll(() => router.invalidate(), PHASE_POLL_MS, verb.busy)
  return verb
}

const failed = (o: ReturnType<typeof useVerbRequest>['outcome']) =>
  o !== null && o.state !== 'running' && o.state !== 'done' ? o.detail : null

export function LifecycleControls({ m }: { m: ProviderMachine }) {
  return (
    <div className="mt-[0.9rem] flex flex-col gap-[0.6rem]">
      <div className="flex flex-wrap items-center gap-x-[1.2rem] gap-y-[0.5rem]">
        <PowerButton m={m} />
        <AlwaysOn m={m} />
      </div>
      <InstallControl m={m} />
    </div>
  )
}

function PowerButton({ m }: { m: ProviderMachine }) {
  const { busy, outcome, start } = useLifecycle(m, POWER_WITHIN_MS)
  const running = m.presence?.running === true
  // Nothing to start before there is an install, and nothing the box can do
  // while one is under way.
  if (m.presence === null) return null
  const wanted = running ? 'stop' : 'start'
  const error = failed(outcome)
  return (
    <span className="flex items-center gap-[0.6rem]">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={busy || underWay(m.managed?.lifecycle?.phase)}
        onClick={() => {
          start(() => powerProviderFn({ data: { machine: m.machine, wanted } }))
        }}
      >
        {busy ? (running ? 'Stopping…' : 'Starting…') : running ? 'Stop' : 'Start'}
      </Button>
      {error !== null && <span className="text-[0.74rem] text-danger">{error}</span>}
      {m.asked?.wanted != null && error === null && (
        <span className="text-[0.72rem] text-muted-foreground">
          kept {m.asked.wanted === 'start' ? 'running' : 'stopped'}
        </span>
      )}
    </span>
  )
}

function AlwaysOn({ m }: { m: ProviderMachine }) {
  const { run, busy, error } = useAction()
  const stored = m.asked?.alwaysOn ?? m.managed?.startup === 'enabled'
  const [on, show] = useShown(stored, busy, error !== null)
  if (m.presence === null) return null
  return (
    <span className="min-w-[16rem] flex-1">
      <Toggle
        checked={on}
        label="Start on its own"
        hint={
          error ??
          (m.os === 'windows' ? 'with the user’s logon, from the tray' : 'with the machine’s boot')
        }
        disabled={busy}
        onChange={(v) => {
          show(v)
          run(() => setProviderAlwaysOnFn({ data: { machine: m.machine, on: v } }))
        }}
      />
    </span>
  )
}

/** Install, or move to the newest release: armed, with the notes one click away. */
function InstallControl({ m }: { m: ProviderMachine }) {
  const [armed, arm, disarm] = useArmed(ARM_MS)
  const { busy, outcome, start } = useLifecycle(m, INSTALL_WITHIN_MS)
  const latest = m.update?.latest ?? null
  const installed = m.presence !== null
  const behind = m.update?.behind ?? 0
  // An install the agent did not find the record of cannot be upgraded by it.
  const unmanaged = installed && m.managed !== null && m.managed.install === null
  const error = failed(outcome)
  const phase = m.managed?.lifecycle?.phase

  if (latest === null) {
    return <p className={EMPTY}>No release of {m.kindName} to offer: GitHub did not answer.</p>
  }
  if (busy || underWay(phase)) {
    return (
      <div className={RESTART}>
        <p className={RESTART_STATE}>
          Installing <span className={MONO}>{m.managed?.lifecycle?.version ?? `v${latest}`}</span>
          {m.managed?.lifecycle != null && ` — ${m.managed.lifecycle.message}`}
        </p>
      </div>
    )
  }
  const verb = installed ? `Update to v${latest}` : `Install v${latest}`
  const offer = !unmanaged && (!installed || behind > 0)

  return (
    <div className="flex flex-col gap-[0.5rem]">
      {installed && (
        <p className="m-0 text-[0.78rem] text-subdued">
          {behind === 0
            ? `${m.version ?? 'This version'} is the newest release.`
            : `v${latest} is out — ${String(behind)} release${behind === 1 ? '' : 's'} newer than ${m.version ?? 'what runs'}.`}
        </p>
      )}
      {installed && behind > 0 && <Notes installed={m.version} />}
      {error !== null && <p className={cn(RESTART_STATE, 'text-danger')}>{error}</p>}
      {offer &&
        (armed ? (
          <ArmedConfirm
            variant="default"
            cost={
              installed
                ? `The server stops for the install — a minute or two — and every loaded model is put down. The agent checks the new version answers and rolls back to ${m.version ?? 'the current one'} if it does not.`
                : `Downloads v${latest} from Lemonade’s GitHub releases and installs it for this machine’s user, then starts it.`
            }
            confirm={verb}
            onConfirm={() => {
              disarm()
              start(() => installProviderFn({ data: { machine: m.machine, version: latest } }))
            }}
            onCancel={disarm}
          />
        ) : (
          <span>
            <Button type="button" variant="outline" size="sm" className={GHOST_BTN} onClick={arm}>
              {verb}
            </Button>
          </span>
        ))}
    </div>
  )
}

type NotesState = {
  loading: boolean
  data: Awaited<ReturnType<typeof fetchProviderNotesFn>> | null
  error: string | null
}

/** The releases between what runs and the newest, read when opened — never on a page load. */
function Notes({ installed }: { installed: string | null }) {
  const [notes, setNotes] = useState<NotesState | null>(null)
  return (
    <details
      className="group"
      onToggle={(e) => {
        // A failed read is not kept: closing and reopening asks again.
        if (!e.currentTarget.open || (notes !== null && notes.error === null)) return
        setNotes({ loading: true, data: null, error: null })
        void fetchProviderNotesFn({ data: { installed } })
          .then((data) => {
            setNotes({ loading: false, data, error: null })
          })
          .catch((err: unknown) => {
            setNotes({ loading: false, data: null, error: errorText(err) })
          })
      }}
    >
      <summary className="cursor-pointer list-none text-[0.74rem] text-primary [&::-webkit-details-marker]:hidden">
        Release notes
      </summary>
      <div className="mt-[0.5rem]">
        {notes?.error != null ? (
          <p className={cn(EMPTY, 'text-danger')}>
            Could not read the release notes (close and reopen to retry): {notes.error}
          </p>
        ) : notes?.data == null ? (
          <p className={EMPTY}>Reading the release notes…</p>
        ) : (
          <>
            <UpgradeChain behind={notes.data.behind} />
            <ReleaseNotes
              releases={notes.data.releases}
              running={notes.data.installed}
              empty={notes.data.note ?? 'no published notes'}
            />
          </>
        )}
      </div>
    </details>
  )
}
