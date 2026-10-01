import { useRouter } from '@tanstack/react-router'
import { useEffect, useId, useRef, useState, useTransition } from 'react'

import { TYPED_LENGTH, typedMatches } from '../../../lib/agent/enroll'
import { errorText } from '../../../lib/redact'
import type { NodeRow } from '../../../lib/repo/nodes'
import { grantSantreeFn } from '../../../server/nodes'
import { Button } from '../../ui/button'
import { Input } from '../../ui/input'
import { ASIDE, ERROR_NOTE, FIELD_LABEL, Mono, NOTE, Rows } from '../shared'

// "Turn on santree": the one way santree is turned on for a machine, from
// the card's switch or from the machine itself — a Mac's "santree on the box"
// and santree's own card open this page at `?tab=machines&node=<id>&santree=on`
// (agent settings.rs `confirm_url`), which opens this under that machine.
// santree on is a shell on the box as its operator, who has root through
// sudo, so the grant is protected where it is made, not where it is asked
// for: the admin types the first characters of the machine's key, read off
// its menu bar (Connection ▸ This Mac's key) or santree's card, and
// lib/repo/nodes.ts `grantSantree` checks them — and the key shown here —
// against the row. The server function is an admin's POST, which the app
// takes from its own pages alone (TanStack Start's CSRF check: server/fn.ts).

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
  const inputId = useId()
  const box = useRef<HTMLDivElement>(null)
  const [typed, setTyped] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [busy, start] = useTransition()
  const matches = typedMatches(n.fingerprint, typed)

  // Opened from a link: brought into view, the field focused.
  useEffect(() => {
    box.current?.scrollIntoView({ block: 'center' })
  }, [])

  const confirm = () => {
    setError(null)
    start(async () => {
      try {
        const r = await grantSantreeFn({
          data: { id: n.id, fingerprint: n.fingerprint, typed },
        })
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
      aria-labelledby={`${inputId}-title`}
      className="flex flex-col gap-3 rounded-md border border-(--border-soft) p-3"
    >
      <h4 id={`${inputId}-title`} className="m-0 font-medium text-[0.92rem]">
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
        santree on this machine can then open terminals and run commands on the box as its operator,
        who has root through sudo. Confirm only if you just asked for this from this machine's menu
        bar or santree, or mean to turn it on from here.
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
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (matches && !busy) confirm()
          }}
        >
          <label className={FIELD_LABEL} htmlFor={inputId}>
            The first {TYPED_LENGTH} characters of its key
          </label>
          <Input
            id={inputId}
            className="max-w-[10rem] font-mono"
            value={typed}
            maxLength={12}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            autoFocus
            onChange={(e) => setTyped(e.target.value)}
          />
          <span className={ASIDE}>
            On a Mac: the menu bar's Connection ▸ This Mac's key, or santree's Daedalus card.
          </span>
          {error !== null && <p className={ERROR_NOTE}>{error}</p>}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" disabled={!matches || busy}>
              Turn on santree
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </div>
  )
}
