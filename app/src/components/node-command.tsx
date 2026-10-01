import type { Command } from '../host/controller/generated'
import { sendNodeCommandFn } from '../server/nodes'
import { Button } from './ui/button'
import { useAction } from './use-action'

// One button that sends a machine one instruction through the controller
// (server/nodes.ts `sendNodeCommandFn`), and says what became of it: taken
// by the machine now, or kept by the controller for its next connection.
// Nothing reloads — an instruction changes no row — so the answer is shown
// beside the button until the next click.

const OUTCOME = {
  delivered: 'the machine took it',
  queued: 'the machine is not connected; the controller gives it at its next connection',
} as const

export function NodeCommandButton({
  id,
  command,
  label,
  note,
  className,
}: {
  id: string
  command: Command
  label: string
  /** What the instruction does, shown until it is sent. */
  note?: string
  className?: string
}) {
  const { run, busy, error, notice } = useAction()
  const said = error ?? notice
  const send = () => {
    run(() => sendNodeCommandFn({ data: { id, command } }), {
      invalidate: false,
      notice: (r) => (r.delivered ? OUTCOME.delivered : OUTCOME.queued),
    })
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button size="sm" variant="outline" className={className} disabled={busy} onClick={send}>
        {label}
      </Button>
      {said !== null ? (
        <span
          className={
            error !== null ? 'text-[0.74rem] text-destructive' : 'text-[0.74rem] text-(--dim)'
          }
        >
          {said}
        </span>
      ) : (
        note !== undefined && <span className="text-[0.74rem] text-(--dim)">{note}</span>
      )}
    </span>
  )
}
