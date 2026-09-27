import { useState, useTransition } from 'react'

import type { NodeCommand } from '../lib/agent/policy'
import { errorText } from '../lib/redact'
import { sendNodeCommandFn } from '../server/nodes'
import { Button } from './ui/button'

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
  command: NodeCommand
  label: string
  /** What the instruction does, shown until it is sent. */
  note?: string
  className?: string
}) {
  const [busy, start] = useTransition()
  const [said, setSaid] = useState<{ text: string; failed: boolean } | null>(null)
  const send = () => {
    setSaid(null)
    start(async () => {
      try {
        const r = await sendNodeCommandFn({ data: { id, command } })
        setSaid({ text: r.delivered ? OUTCOME.delivered : OUTCOME.queued, failed: false })
      } catch (e) {
        setSaid({ text: errorText(e), failed: true })
      }
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
            said.failed ? 'text-[0.74rem] text-destructive' : 'text-[0.74rem] text-(--dim)'
          }
        >
          {said.text}
        </span>
      ) : (
        note !== undefined && <span className="text-[0.74rem] text-(--dim)">{note}</span>
      )}
    </span>
  )
}
