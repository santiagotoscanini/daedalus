import { useRouter } from '@tanstack/react-router'
import { useId, useState, useTransition } from 'react'
import type { TokenCheck } from '../../core/settings/types'
import { tokenShapeError } from '../../lib/cloudflare-token'
import { errorText } from '../../lib/redact'
import { replaceCloudflareTokenFn } from '../../server/settings'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Chip } from '../viz'
import { Bad, ERROR_NOTE, Mono, NOTE, Pending, Unset } from './shared'

// The Cloudflare half of Settings › Integrations: the cells that say what the
// box is configured with and whether the token can still read it, and the one
// form that replaces the token.
//
// Its own module because the token is the only credential on this page the
// operator can change from here, and the rules around it — checked before it
// is kept, never echoed back — are the whole reason the form exists.

/** An id the box is configured with, and the name the service knows it by. */
export function Identified({
  id,
  live,
  needs,
}: {
  id: string
  live: { name: string; status: string } | null | undefined
  /** The token permission that makes this readable, named when it is not. */
  needs: string
}) {
  if (id === '') return <Unset />
  return (
    <span className="inline-flex flex-col items-end gap-[0.1rem]">
      {live === undefined ? (
        <Pending />
      ) : live === null ? (
        <>
          <span className="text-[0.82rem] text-(--dim)">not readable with the token</span>
          <span className="text-[0.72rem] text-(--text-muted)">needs {needs}</span>
        </>
      ) : (
        <span className="inline-flex items-center gap-2">
          <Chip tone={live.status === 'active' || live.status === 'healthy' ? 'ok' : 'warn'}>
            {live.status || 'unknown'}
          </Chip>
          <Mono>{live.name}</Mono>
        </span>
      )}
      <span className="text-[0.72rem] text-(--dim)">{id}</span>
    </span>
  )
}

export function Token({
  configured,
  check,
}: {
  configured: boolean
  check: TokenCheck | undefined
}) {
  if (!configured) return <Chip tone="muted">not configured</Chip>
  if (check === undefined) return <Pending />
  if (!check.ok) return <Bad>{check.reason ?? 'rejected'}</Bad>
  return (
    <span className="inline-flex items-center gap-2">
      <Chip tone="ok">{check.value.status ?? 'active'}</Chip>
      <span className="text-[0.78rem] text-(--text-muted)">
        {check.value.expiresOn === null
          ? 'no expiry'
          : `expires ${check.value.expiresOn.slice(0, 10)}`}
      </span>
    </span>
  )
}

/**
 * Replacing the Cloudflare token (core/settings/cloudflare-token.ts). The value
 * lives in this component only while it is typed, is cleared the moment it is
 * submitted, and never comes back from the server — the server answers with
 * what it checked, not with what it was given.
 */
export function ReplaceToken() {
  const id = useId()
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [token, setToken] = useState('')
  const [busy, start] = useTransition()
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null)

  const local = token === '' ? null : tokenShapeError(token)
  const submit = () => {
    if (token === '' || local !== null) return
    const value = token
    setToken('')
    setOutcome(null)
    start(async () => {
      try {
        const r = await replaceCloudflareTokenFn({ data: { token: value } })
        if (r.ok) {
          setOpen(false)
          setOutcome({
            ok: true,
            text: `Checked and applying. It sees ${r.value.zones.join(', ')}; the rebuild restarts everything that reads the token.`,
          })
          await router.invalidate()
        } else {
          setOutcome({ ok: false, text: r.reason })
        }
      } catch (e) {
        setOutcome({ ok: false, text: errorText(e) })
      }
    })
  }

  if (!open) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setOpen(true)
            setOutcome(null)
          }}
        >
          Replace token…
        </Button>
        {outcome !== null && <span className={outcome.ok ? NOTE : ERROR_NOTE}>{outcome.text}</span>}
      </div>
    )
  }

  return (
    <form
      className="flex flex-col gap-2 rounded-[9px] border border-(--border-soft) p-3"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <label htmlFor={id} className="font-medium text-[0.8rem]">
        New API token
      </label>
      <Input
        id={id}
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={token}
        onChange={(e) => {
          setToken(e.target.value)
        }}
        aria-invalid={local !== null}
        className="h-9 font-mono md:text-[0.8rem]"
      />
      <p className={NOTE}>
        Before anything changes it is checked against Cloudflare: the zone, a DNS record written and
        removed, the tunnel. Then it is encrypted here, saved to site/vault/ and applied, and
        everything that reads it restarts on its own.
      </p>
      {(local ?? (outcome !== null && !outcome.ok ? outcome.text : null)) !== null && (
        <p role="alert" className={ERROR_NOTE}>
          {local ?? outcome?.text}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy || token === '' || local !== null}>
          {busy ? 'Checking…' : 'Check and apply'}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            setOpen(false)
            setToken('')
          }}
        >
          Cancel
        </Button>
      </div>
    </form>
  )
}
