// One declared task: when it runs, what it runs, how its last run ended, and Run now.

import { useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { cn } from '../../../lib/cn'

import { runTaskNow } from '../../../server/registry'
import { Until, When } from '../../ago'
import { useRootAction } from '../../root-action'
import { CAPTION } from '../../tokens'
import { Button } from '../../ui/button'
import { Chip } from '../../viz'
import { GLASS } from '../../viz/board'
import { CHIP, GHOST_BTN } from '../shared'
import type { TaskRow } from './types'

export function TaskCard({
  app,
  task,
  running,
  readOnly,
  busy,
  onEdit,
  onRemove,
}: {
  app: string
  task: TaskRow
  running: boolean
  readOnly: boolean
  busy: boolean
  onEdit: () => void
  onRemove: () => void
}) {
  // Two clicks to remove, rather than a dialog or a typed name: what is lost
  // is a declaration that can be written again in a minute, but the command
  // itself is only in this row — so the second click is worth asking for and
  // a modal is not.
  const [confirming, setConfirming] = useState(false)

  return (
    <li className={cn(GLASS, 'rounded-xl px-4 py-3.5')}>
      <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1.5">
        <code className="text-[0.9rem] font-[560]">{task.id}</code>
        <Outcome task={task} />
        <span className="ml-auto flex flex-wrap items-center gap-2">
          <RunNowButton app={app} task={task} running={running} />
          {!readOnly && (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className={GHOST_BTN}
                disabled={busy}
                onClick={onEdit}
              >
                Edit
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className={cn(
                  GHOST_BTN,
                  confirming && 'border-danger/50 text-danger hover:text-danger',
                )}
                disabled={busy}
                onBlur={() => {
                  setConfirming(false)
                }}
                onClick={() => {
                  if (confirming) onRemove()
                  else setConfirming(true)
                }}
              >
                {confirming ? 'Remove — sure?' : 'Remove'}
              </Button>
            </>
          )}
        </span>
      </div>

      <p className="mt-2 mr-0 mb-0 ml-0 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[0.85rem]">
        <span>{task.scheduleText}</span>
        {/* The raw string beside the sentence, always. The sentence is this
            app's reading of it; the string is what systemd was given. */}
        <code className="text-[0.75rem] text-muted-foreground">{task.schedule}</code>
      </p>

      {/* argv, joined for reading only — the quotes mark where one argument
          ends, since that is exactly what a shell string would lose. */}
      <p className="mt-2 mr-0 mb-0 ml-0 font-mono text-[0.8rem] text-subdued [overflow-wrap:anywhere]">
        {task.command.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}
      </p>

      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[0.75rem] text-muted-foreground">
        <span>last run {task.lastRunAt === null ? 'never' : <When at={task.lastRunAt} />}</span>
        <span>
          next {task.nextRunAt === null ? 'not scheduled' : <Until at={task.nextRunAt} />}
        </span>
        <span>timeout {task.timeoutSec}s</span>
        <code>{task.unit}</code>
      </div>

      {task.lastRunAt === null && (
        <p className={CAPTION}>
          No run recorded. Either the timer has not fired since the last boot, or the Apply that
          generates this unit has not happened yet.
        </p>
      )}
    </li>
  )
}

/**
 * How the last run ended, or an admission that nothing is known.
 *
 * Deliberately silent when there is no run to describe: systemd reports
 * success and exit status 0 for a service that has never started, and a green
 * "success" pill on a task that has never run is the most expensive kind of
 * wrong this page could be.
 */
function Outcome({ task }: { task: TaskRow }) {
  if (task.result === null) {
    return <Chip className={cn(CHIP, 'text-subdued')}>no run yet</Chip>
  }
  if (task.result === 'success') {
    return (
      <Chip tone="ok" className={CHIP}>
        success
      </Chip>
    )
  }
  return (
    <Chip tone="bad" className={CHIP}>
      {task.result}
      {task.exitStatus === null ? '' : ` · exit ${String(task.exitStatus)}`}
    </Chip>
  )
}

/**
 * Start this task's unit now instead of at its next elapse.
 *
 * The same unit the timer starts, with the same timeout and the same failure
 * mail — so a manual run is indistinguishable from a scheduled one, and this
 * is not a second code path to keep working. Shaped like the Redeploy button
 * on the Overview: the host answers when the run has finished, refused when
 * the task is already running.
 */
function RunNowButton({ app, task, running }: { app: string; task: TaskRow; running: boolean }) {
  const router = useRouter()
  const {
    running: inFlight,
    answer,
    start,
  } = useRootAction({
    onSettle: () => {
      // The run moves `lastRunAt` and the outcome, and both come from the
      // loader.
      void router.invalidate()
    },
  })

  return (
    <span className="inline-flex items-center gap-2.5 text-[0.75rem]">
      {answer !== null && answer.outcome !== 'done' && (
        <span className="text-danger" title={answer.detail || undefined}>
          {answer.outcome === 'refused' ? answer.detail : 'the run failed'}
        </span>
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className={GHOST_BTN}
        disabled={inFlight || !running}
        title={
          running ? undefined : 'the app is not set up yet — there is no container to run this in'
        }
        onClick={() => {
          start(() => runTaskNow({ data: { name: app, task: task.id } }))
        }}
      >
        {inFlight ? '▷ running…' : '▷ Run now'}
      </Button>
    </span>
  )
}
