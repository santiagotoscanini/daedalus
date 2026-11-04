import { RebootRequired } from '../../../components/reboot-required'
import { MONO, NOTE } from '../../../components/tokens'
import { Alert, AlertDescription, AlertTitle } from '../../../components/ui/alert'
import type { VersionUpdateStatus } from '../../../host/version-update'
import { cn } from '../../../lib/cn'
import { REBOOT_REQUIRED } from '../../../lib/reboot-required'

// What both game tabs' version boards share: the option rows, the confirm
// box, and the run as drawn under the button. The host agent is one
// (host/version-update.ts), so a run of the other game is not this tab's to
// report.

export const OPTION = cn(
  'flex w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-xl border px-3 py-2 text-left transition-colors',
  'border-hairline bg-foreground/[0.03] hover:bg-foreground/[0.05]',
)
export const OPTION_ON = 'border-primary/60 bg-foreground/[0.075] hover:bg-foreground/[0.075]'
export const CONFIRM = 'rounded-xl border border-warning/30 bg-warning/[0.07] px-3.5 py-3'

const PHASE: Record<string, string> = {
  validating: 'checking the request',
  waiting: 'waiting for another rebuild to finish',
  writing: 'rewriting the pin',
  committing: 'committing',
  building: 'building the system',
  snapshotting: 'snapshotting the saved data',
  switching: 'switching — the server restarts now',
  verifying: 'waiting for the server to come up on the new version',
  'rolling-back': 'rolling back',
  pushing: 'pushing the commit',
}

export function VersionProgress({
  target,
  status: s,
  running,
  refusal,
}: {
  /** The fleet.versionPins id this tab moves. */
  target: string
  status: VersionUpdateStatus
  running: boolean
  refusal: string | null
}) {
  if (refusal !== null) return <p className={cn(NOTE, 'm-0 text-danger')}>{refusal}</p>
  if (s.id === null || s.target !== target) return null
  const moved = s.moves.map((m) => `${m.field} ${m.from} → ${m.to}`).join(', ')
  if (running || s.state === 'running') {
    return (
      <p className={cn(NOTE, 'm-0')}>
        {PHASE[s.phase] ?? s.phase}…{moved === '' ? '' : ` (${moved})`}
      </p>
    )
  }
  if (s.state === 'done' && s.phase === REBOOT_REQUIRED) {
    return (
      <div>
        <RebootRequired note={s.error} />
      </div>
    )
  }
  if (s.state === 'done') {
    return (
      <p className={cn(NOTE, 'm-0 text-success')}>
        {s.phase === 'no-change'
          ? 'already there — nothing to move'
          : `updated${moved === '' ? '' : `: ${moved}`}${s.commit === null || s.commit === '' ? '' : ` (commit ${s.commit})`}.`}
        {s.snapshot !== '' && (
          <>
            {' '}
            The way back is <span className={MONO}>{s.snapshot}</span>.
          </>
        )}
      </p>
    )
  }
  if (s.state === 'failed') {
    return (
      <Alert variant="destructive">
        <AlertTitle>
          The update failed while {PHASE[s.phase] ?? s.phase}
          {s.rolledBack ? ', and was rolled back' : ''}.
        </AlertTitle>
        <AlertDescription>
          <pre className="m-0 max-h-[12rem] overflow-auto text-[0.72rem] whitespace-pre-wrap">
            {s.error}
          </pre>
        </AlertDescription>
      </Alert>
    )
  }
  return null
}
