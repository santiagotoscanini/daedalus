// The Remote control board's first verb: move the pinned Claude Code to the
// current release. Not armed — nothing is killed.
import { Link } from '@tanstack/react-router'

// Types ONLY: the host module behind this type reads node:fs, so a value
// import would put that in the browser bundle. The server functions below are
// the client-safe door to it.
import type { ClaudeCodeUpdateStatus } from '../../../host/claude-code-update'
import { cn } from '../../../lib/cn'
import { num, text } from '../../../lib/format'
import { fetchClaudeCodeUpdateStatus, requestClaudeCodeUpdateFn } from '../../../server/claude'
import { GHOST_BTN } from '../../apps/shared'
import { usePolledStatus } from '../../status'
import { Button } from '../../ui/button'
import { RESTART, RESTART_NOTE, RESTART_STATE } from '../shared'

const CC_IDLE: ClaudeCodeUpdateStatus = {
  id: null,
  state: 'idle',
  phase: '',
  error: '',
  from: '',
  to: '',
  startedAt: null,
  finishedAt: null,
  commit: null,
}

/**
 * Move this box's Claude Code to the current release.
 *
 * The CLI here is a nix package sealed with `DISABLE_UPDATES`, so
 * `claude update` is not a path — it would leave the store binary alone and
 * build a second, native install nothing reverts, which is what it did
 * before the seal (platform/claude-code/claude-code.nix carries the
 * measurement). The supported move is a pin: the engine's release manifest,
 * then the configuration's lock, then a rebuild.
 *
 * Two agents do it. `daedalus-claude-code-update` fetches the release,
 * verifies its signature, commits the manifest into the engine and pushes —
 * then asks for an engine update, which is the half that builds and
 * switches. So this control's `done` means PINNED, not installed.
 *
 * It does NOT narrate the engine half, and that is deliberate. The engine's
 * status is one file with one run in it, so a second poller here would
 * either report somebody else's history — the stale-status bug
 * `usePolledStatus`'s claim mechanism exists to prevent — or need its own
 * copy of that mechanism plus the nine-phase tracker System › Updates
 * already draws. Naming where the rest of the move is being narrated costs a
 * sentence and cannot be wrong.
 *
 * Not armed, unlike the restart beside it: nothing is killed. The switch
 * deliberately does not restart the Remote Control server, so every live
 * session keeps running on the old binary and the page flips to
 * "restart pending" — which is the other button's job.
 */
export function UpdateClaudeCodeControl({
  pinned,
  latest,
  behind,
}: {
  pinned: string | null
  latest: string | null
  behind: number
}) {
  const { status, running, refusal, start } = usePolledStatus<ClaudeCodeUpdateStatus>({
    initial: CC_IDLE,
    fetch: () => fetchClaudeCodeUpdateStatus(),
    claimTimeoutMs: 30_000,
  })
  const upToDate = latest !== null && pinned !== null && latest === pinned
  const moved = status.state === 'done' && status.to !== '' && status.to !== status.from

  if (running) {
    return (
      <div className={RESTART}>
        <p className={RESTART_STATE}>
          {status.phase === 'verifying'
            ? 'Checking the release signature…'
            : status.phase === 'committing'
              ? 'Pinning it in the engine…'
              : status.phase === 'handing-off'
                ? 'Pinned. Asking for the rebuild…'
                : `Pinning Claude Code… (${status.phase || 'starting'})`}
        </p>
      </div>
    )
  }

  return (
    <div className={RESTART}>
      {status.state === 'done' && !moved && (
        <p className={RESTART_STATE}>Already pinned to {status.to} — nothing to move.</p>
      )}
      {moved && (
        <p className={cn(RESTART_STATE, 'text-success')}>
          Pinned {status.from} → {status.to}
          {status.commit === null || status.commit === '' ? '' : ` (${status.commit})`}. The rebuild
          that installs it is running as an engine update —{' '}
          <Link to="/c/$category" params={{ category: 'system' }} search={{ tab: 'updates' }}>
            System › Updates
          </Link>{' '}
          narrates it. Every live session keeps the binary it started on until the server restarts.
        </p>
      )}
      {refusal !== null && <p className={cn(RESTART_STATE, 'text-danger')}>{refusal}</p>}
      {refusal === null && status.state === 'failed' && (
        <p className={cn(RESTART_STATE, 'text-danger')}>{status.error}</p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={GHOST_BTN}
          disabled={upToDate}
          onClick={() => {
            start(async () => {
              const r = await requestClaudeCodeUpdateFn()
              return r.ok ? { ok: true, value: r.id } : { ok: false, reason: r.reason }
            })
          }}
        >
          {upToDate ? 'Claude Code is current' : 'Update Claude Code'}
        </Button>
        <span className={RESTART_NOTE}>
          {upToDate
            ? `the flake holds ${text(pinned)}, which is the current release`
            : `pins the release manifest in the engine — signature-checked — then builds and switches onto it${behind > 0 ? `, ${num(behind)} release${behind === 1 ? '' : 's'} ahead of what the flake holds` : ''}. No session is interrupted.`}
        </span>
      </div>
    </div>
  )
}
