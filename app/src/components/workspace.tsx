import { useRouter } from '@tanstack/react-router'
import { ArrowDownToLineIcon } from 'lucide-react'
import { cloneWorkspaceFn } from '../server/registry'
import { GHOST_BTN } from './apps/shared'
import { useRootAction } from './root-action'
import { Button } from './ui/button'

// The one workspace action, shared by the app detail page and the off-box
// project rows. "Clone" and "Pull now" are the same request — the host
// treats a clone of an existing workspace as a pull — so one button changes
// its label rather than two buttons pretending to be different verbs.
//
// The click waits for the root helper's word (host/workspaces.ts): the
// button is busy until the clone has finished, then shows a refusal or a
// failure in the host's words. The host runs one clone at a time; a click
// elsewhere while one runs is refused and says so.

export function CloneButton({ repo, cloned }: { repo: string; cloned: boolean }) {
  const router = useRouter()
  const { running, answer, start } = useRootAction({
    onSettle: () => {
      void router.invalidate()
    },
  })

  return (
    <span className="inline-flex items-center gap-2">
      {answer !== null && answer.outcome !== 'done' && (
        <span className="text-[0.75rem] text-danger" title={answer.detail || undefined}>
          {answer.outcome === 'refused' ? answer.detail : 'failed'}
        </span>
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className={GHOST_BTN}
        disabled={running}
        onClick={() => {
          start(() => cloneWorkspaceFn({ data: { repo } }))
        }}
      >
        {/* The same icon-and-word shape as Redeploy beside it. */}
        <ArrowDownToLineIcon aria-hidden="true" className={running ? 'animate-pulse' : undefined} />
        {running ? (cloned ? 'Pulling…' : 'Cloning…') : cloned ? 'Pull now' : 'Clone'}
      </Button>
    </span>
  )
}
