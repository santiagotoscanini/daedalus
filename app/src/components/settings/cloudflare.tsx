import { type ReactNode, useId, useState } from 'react'
import type { TokenCheck } from '../../core/settings/types'
import { tokenShapeError } from '../../lib/cloudflare-token'
import { cn } from '../../lib/cn'
import type { Result } from '../../lib/result'
import { replaceCloudflareTokenFn } from '../../server/settings'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { useAction } from '../use-action'
import { Chip } from '../viz'
import {
  ASIDE,
  Bad,
  ERROR_NOTE,
  FIELD_LABEL,
  INSET,
  Mono,
  NOTE_SHOWN,
  Pending,
  Stack,
  Unset,
} from './shared'

// The Cloudflare half of Settings › Integrations: the cells that say what the
// box is configured with and whether the token can still read it, and the one
// form that replaces the token.
//
// Its own module because the rules around the token — checked before it is
// kept, never echoed back — are the whole reason the form exists (the GitHub
// App's key has its own file, github-paste-key.tsx, for the same reason).

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
    <Stack>
      {live === undefined ? (
        <Pending />
      ) : live === null ? (
        <>
          <span className="text-[0.82rem] text-muted-foreground">not readable with the token</span>
          <span className="text-[0.72rem] text-subdued">needs {needs}</span>
        </>
      ) : (
        <span className="inline-flex items-center gap-2">
          <Chip tone={live.status === 'active' || live.status === 'healthy' ? 'ok' : 'warn'}>
            {live.status || 'unknown'}
          </Chip>
          <Mono>{live.name}</Mono>
        </span>
      )}
      <span className={ASIDE}>{id}</span>
    </Stack>
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
      <span className="text-[0.78rem] text-subdued">
        {check.value.expiresOn === null
          ? 'no expiry'
          : `expires ${check.value.expiresOn.slice(0, 10)}`}
      </span>
    </span>
  )
}

/** Replacing the Cloudflare token (core/settings/cloudflare-token.ts). */
export function ReplaceToken() {
  return (
    <TokenForm
      opener="Replace token…"
      label="New API token"
      shapeError={tokenShapeError}
      apply={(token) => replaceCloudflareTokenFn({ data: { token } })}
      notice={(v) =>
        `Checked and applying. It sees ${v.zones.join(', ')}; the rebuild restarts everything that reads the token.`
      }
    >
      Before anything changes it is checked against Cloudflare: the zone, a DNS record written and
      removed, the tunnel. Then it is encrypted here, saved to site/vault/ and applied, and
      everything that reads it restarts on its own.
    </TokenForm>
  )
}

/**
 * A credential pasted in, checked by the server and sealed for site/vault/.
 * The value lives in this component only while it is typed, is cleared the
 * moment it is submitted, and never comes back from the server — the server
 * answers with what it checked, not with what it was given. Cloudflare's
 * token and Vercel's (./vercel) both go through it.
 */
export function TokenForm<V>({
  opener,
  label,
  shapeError,
  apply,
  notice,
  children,
}: {
  opener: string
  label: string
  shapeError: (v: string) => string | null
  apply: (token: string) => Promise<Result<V>>
  /** What the page says once it is applying, from what the server checked. */
  notice: (checked: V) => string
  /** What happens to the token once submitted, under the field. */
  children: ReactNode
}) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [token, setToken] = useState('')
  const { run, busy, error, notice: done, clear } = useAction()

  const local = token === '' ? null : shapeError(token)
  const submit = () => {
    if (token === '' || local !== null) return
    const value = token
    setToken('')
    run(() => apply(value), {
      onDone: () => {
        setOpen(false)
      },
      notice: (r) => notice(r.value),
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
            clear()
          }}
        >
          {opener}
        </Button>
        {error !== null ? (
          <span className={ERROR_NOTE}>{error}</span>
        ) : (
          done !== null && <span className={NOTE_SHOWN}>{done}</span>
        )}
      </div>
    )
  }

  return (
    <form
      className={cn(INSET, 'gap-2')}
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <label htmlFor={id} className={FIELD_LABEL}>
        {label}
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
        className="font-mono md:text-[0.8rem]"
      />
      <p className={NOTE_SHOWN}>{children}</p>
      {(local ?? error) !== null && (
        <p role="alert" className={ERROR_NOTE}>
          {local ?? error}
        </p>
      )}
      <div className="mt-1 flex gap-2">
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
