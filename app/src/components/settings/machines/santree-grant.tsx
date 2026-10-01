import { useRouter } from '@tanstack/react-router'
import { useEffect, useId, useRef, useState, useTransition } from 'react'

import { errorText } from '../../../lib/redact'
import type { NodeRow } from '../../../lib/repo/nodes'
import { grantSantreeFn } from '../../../server/nodes'
import { Button } from '../../ui/button'
import { ERROR_NOTE, Mono, NOTE, Rows } from '../shared'

// "Turn on santree": the one way santree is turned on for a machine, from
// the card's switch or from the machine itself — a Mac's "santree on the box"
// and santree's own card open this page at `?tab=machines&node=<id>&santree=on`
// (agent settings.rs `confirm_url`), which opens this under that machine.
// santree on is a shell on the box as its operator, who has root through
// sudo, so the grant is a consent page: it names the machine and shows its
// full key, and lib/repo/nodes.ts `grantSantree` checks the key shown here
// against the row, the row's approval and the box's session host. The server
// function is an admin's POST, which the app takes from its own pages alone
// (TanStack Start's CSRF check: server/fn.ts). The buttons are not a form, so
// a click before the page hydrated does nothing.

export function SantreeGrant({
  n,
  os,
  agentVersion,
  onClose,
}: {
  n: NodeRow
  os: string
  agentVersion: string
  onClose: () => void
}) {
  const router = useRouter()
  const titleId = useId()
  const box = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [busy, start] = useTransition()

  // Opened from a link: brought into view.
  useEffect(() => {
    box.current?.scrollIntoView({ block: 'center' })
  }, [])

  const confirm = () => {
    if (busy) return
    setError(null)
    start(async () => {
      try {
        const r = await grantSantreeFn({ data: { id: n.id, fingerprint: n.fingerprint } })
        if (!r.ok) {
          setError(r.reason)
          return
        }
        setDone(
          r.already
            ? `santree was already on for ${n.name}.`
            : `santree is on for ${n.name}. Its menu bar and santree show it within seconds.`,
        )
        await router.invalidate()
      } catch (e) {
        setError(errorText(e))
      }
    })
  }

  return (
    <div
      ref={box}
      role="dialog"
      aria-labelledby={titleId}
      className="flex flex-col gap-3 rounded-md border border-(--border-soft) p-3"
    >
      <h4 id={titleId} className="m-0 font-medium text-[0.92rem]">
        Turn on santree for {n.name}
      </h4>
      <Rows
        rows={[
          { k: 'Machine', v: <span>{n.name}</span> },
          { k: 'System', v: <span>{`${os} · agent ${agentVersion}`}</span> },
          { k: 'Its key', v: <Mono>{n.fingerprint}</Mono> },
          { k: 'Node', v: <Mono>{n.id}</Mono> },
        ]}
      />
      <p className={NOTE}>
        santree on this machine can then open terminals and run commands on the box: a shell on the
        box, as its operator, who has root through sudo. Confirm only if you just asked for this
        from that machine.
      </p>
      {done !== null ? (
        <div className="flex flex-col gap-2">
          <p className={NOTE}>{done}</p>
          <div>
            <Button size="sm" variant="outline" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {error !== null && <p className={ERROR_NOTE}>{error}</p>}
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" disabled={busy} onClick={confirm}>
              Turn on santree
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
