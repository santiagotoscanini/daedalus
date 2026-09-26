import { useRouter } from '@tanstack/react-router'
import { useState, useTransition } from 'react'

import { cn } from '../../../lib/cn'
import type { Machine } from '../../../lib/dashboard/machines'
import { since } from '../../../lib/format'
import { errorText } from '../../../lib/redact'
import {
  approveNodeFn,
  forgetNodeFn,
  requestUpdateCheckFn,
  revokeNodeFn,
} from '../../../server/nodes'
import { Button } from '../../ui/button'
import { ERROR_NOTE, MONO, NOTE } from '../shared'

// A machine's trust: pending, approved or revoked, and the buttons that move
// it between them. A machine that was only found (no hello, so no key) has
// nothing to decide, and says why.

/** The box's decision about the machine, and the buttons that change it. */
export function Decision({ m }: { m: Machine }) {
  const router = useRouter()
  const [busy, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const node = m.node
  const act = (fn: (opts: { data: { id: string } }) => Promise<unknown>) => {
    if (node === null) return
    setError(null)
    start(async () => {
      try {
        await fn({ data: { id: node.id } })
        await router.invalidate()
      } catch (e) {
        setError(errorText(e))
      }
    })
  }

  if (node === null) {
    return (
      <p className={NOTE}>
        Its status page answers but no hello has reached the box, so there is no key to trust: the
        agent is older than 0.3.0, or it cannot find the box in DNS. It will announce itself on its
        next update; nothing to press here.
      </p>
    )
  }

  const line =
    node.state === 'pending'
      ? `Announced itself ${since(node.lastSeenAgo)} and is waiting for a decision. Approve it if this is your machine.`
      : node.state === 'approved'
        ? `Approved ${node.approvedAt !== null ? since((Date.now() - Date.parse(node.approvedAt)) / 1000) : ''}${node.approvedBy !== null ? ` by ${node.approvedBy}` : ''}; last hello ${since(node.lastSeenAgo)}.${node.updateCheckRequested ? ' An update is queued for its next hello: the agent reads the release feed and installs what it finds.' : ''}`
        : `Revoked; the box ignores its hellos. Approve to trust its key again, or forget it.`

  return (
    <div className="flex flex-col gap-2">
      <p className={NOTE}>{line}</p>
      <div className="flex flex-wrap items-center gap-2">
        {node.state !== 'approved' && (
          <Button size="sm" disabled={busy} onClick={() => act(approveNodeFn)}>
            Approve
          </Button>
        )}
        {node.state === 'approved' && (
          <>
            {/* Rides the next hello's answer, so within a minute. */}
            <Button
              size="sm"
              variant="outline"
              disabled={busy || node.updateCheckRequested}
              onClick={() => act(requestUpdateCheckFn)}
            >
              {node.updateCheckRequested ? 'Update queued' : 'Update now'}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => act(revokeNodeFn)}>
              Revoke
            </Button>
          </>
        )}
        {node.state !== 'approved' && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => act(forgetNodeFn)}>
            Forget
          </Button>
        )}
        <span
          className={cn(MONO, 'text-[0.7rem] text-(--dim)')}
          title="sha256 of the machine's public key, the first 16 hex digits: what the box trusts"
        >
          key {node.id}
        </span>
      </div>
      {error !== null && <p className={ERROR_NOTE}>{error}</p>}
    </div>
  )
}
