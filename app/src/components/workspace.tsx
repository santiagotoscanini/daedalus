import { useRouter } from '@tanstack/react-router'
import type { WorkspaceRequestStatus } from '../lib/workspaces'
import { cloneWorkspaceFn, fetchWorkspaceRequestStatus } from '../server/registry'
import { usePolledStatus } from './status'
import { Button } from './ui/button'

// The one workspace action, shared by the app detail page and the off-box
// project rows. "Clone" and "Pull now" are the same request — the host
// treats a clone of an existing workspace as a pull — so one button changes
// its label rather than two buttons pretending to be different verbs.
//
// One bridge, one status file: every instance of this button polls the same
// status, so while a clone runs the others show busy too. That is the truth
// (the host serialises workspace mutations behind one lock), not a UI
// shortcut.

export function CloneButton({
  repo,
  cloned,
  initial,
}: {
  repo: string
  cloned: boolean
  initial: WorkspaceRequestStatus
}) {
  const router = useRouter()
  const { status, running, start } = usePolledStatus({
    initial,
    fetch: () => fetchWorkspaceRequestStatus(),
    onSettle: () => {
      void router.invalidate()
    },
  })

  const mine = status.repo === repo
  const busyLabel = cloned ? '⇣ pulling…' : '⇣ cloning…'

  return (
    <span className="inline-flex items-center gap-2">
      {status.state === 'failed' && mine && (
        <span className="text-danger text-xs" title={status.error}>
          failed
        </span>
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={running}
        onClick={() => {
          start(async () => (await cloneWorkspaceFn({ data: { repo } })).id)
        }}
      >
        {running
          ? // A foreign running status means some other project's clone holds
            // the lock — busy is honest, but not with this button's verb.
            mine || status.state !== 'running'
            ? busyLabel
            : '⇣ busy…'
          : cloned
            ? '⇣ Pull now'
            : '⇣ Clone'}
      </Button>
    </span>
  )
}
