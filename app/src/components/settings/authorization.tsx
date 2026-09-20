import { useRouter } from '@tanstack/react-router'
import { ShieldCheckIcon } from 'lucide-react'
import { useEffect, useState, useTransition } from 'react'
import { ADMIN_GROUP } from '../../core/auth'
import { cn } from '../../lib/cn'
import { errorText } from '../../lib/redact'
import { type AuthorizationView, setEnforceAdminsFn } from '../../server/settings'
import { GHOST_BTN } from '../apps/shared'
import { Button } from '../ui/button'
import { Chip } from '../viz'
import { ERROR_NOTE, Mono, NOTE, PANEL, Section, Unset } from './shared'

// The arming panel for the `admins` check (core/authz.ts).
//
// ── what it shows, and why it is the request and not the config ───────────
//
// The rows are the decision for THE REQUEST THAT RENDERED THIS PAGE: the
// email traefik forwarded, and the groups header exactly as it arrived —
// absent, blank, unparseable, or a list. Reading the nix file would say what
// the proxy is configured to send; this says what it sent, which is the only
// fact that makes arming safe. A page reached under the gate (shotter dials
// the container directly) honestly shows `absent`, and the switch refuses.
//
// ── the switch ────────────────────────────────────────────────────────────
//
// Two steps, like the box and server restarts on the Claude page, with the
// cost spelled out at arm time: enforcement refuses every mutation from an
// account outside `admins`, including this one if the rows above do not name
// it. The server refuses that case on its own (setEnforcingAdmins) — the
// disabled button here is a courtesy, not the check. Disarming is one click
// and always allowed: it is the way back out.

const ARM_MS = 10_000

const HEADER_COPY: Record<
  AuthorizationView['header'],
  { tone: 'ok' | 'warn' | 'bad' | 'muted' | 'info'; label: string; note: string }
> = {
  absent: {
    tone: 'warn',
    label: 'absent',
    note: 'No groups header reached this request — it came in under the gate, on a bypassed path, or before the nix change that sets it was switched.',
  },
  blank: {
    tone: 'warn',
    label: 'blank',
    note: 'The header is present and empty: the strip middleware ran and the forward-auth plugin never re-set it, which is what a bypassed path looks like.',
  },
  unparseable: {
    tone: 'bad',
    label: 'unparseable',
    note: 'The header is present but is not a JSON array of strings. daedalus.nix should pipe the claim through mapToJsonArray.',
  },
  list: { tone: 'ok', label: 'list', note: 'A JSON array, parsed.' },
  local: {
    tone: 'info',
    label: 'local session',
    note: 'This request is signed in through the break-glass local login, which is implicitly in admins and carries no header.',
  },
}

export function Authorization({ view }: { view: AuthorizationView }) {
  const header = HEADER_COPY[view.header]
  return (
    <Section
      title="Authorization"
      icon={<ShieldCheckIcon />}
      description={
        <>
          Whether a mutation refuses a caller outside the <Mono>{ADMIN_GROUP}</Mono> group. The rows
          are what <em>this</em> request carried, not what the proxy is configured to send.
        </>
      }
      rows={[
        {
          k: 'Actor',
          v:
            view.actor === null ? (
              <Unset label="none — the request carried no signed-in identity" />
            ) : (
              <Mono>{view.actor}</Mono>
            ),
        },
        {
          k: 'Groups header',
          v: (
            <span className="inline-flex items-center gap-2">
              <Chip tone={header.tone}>{header.label}</Chip>
              {view.header === 'list' && (
                <Mono>{view.groups.length === 0 ? '[]' : view.groups.join(' · ')}</Mono>
              )}
            </span>
          ),
        },
        {
          k: 'Admin',
          v: view.admin ? (
            <Chip tone="ok">yes</Chip>
          ) : (
            <span className="inline-flex items-center gap-2">
              <Chip tone="bad">no</Chip>
              <span className="text-[0.78rem] text-danger">
                Arming now would refuse this very account.
              </span>
            </span>
          ),
        },
        {
          k: 'Enforcement',
          v: view.enforced ? (
            <Chip tone="ok">refusing</Chip>
          ) : (
            <Chip tone="muted">reporting only</Chip>
          ),
        },
      ]}
    >
      <p className={NOTE}>{header.note}</p>
      <EnforceControl view={view} />
    </Section>
  )
}

function EnforceControl({ view }: { view: AuthorizationView }) {
  const router = useRouter()
  const [armed, setArmed] = useState(false)
  const [busy, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => {
      setArmed(false)
    }, ARM_MS)
    return () => {
      clearTimeout(t)
    }
  }, [armed])

  const flip = (on: boolean) => {
    setArmed(false)
    setError(null)
    setDone(null)
    start(async () => {
      try {
        const r = await setEnforceAdminsFn({ data: { on } })
        if (r.ok) {
          setDone(on ? 'Enforcement is on.' : 'Enforcement is off; the check reports only.')
          await router.invalidate()
        } else setError(r.reason)
      } catch (e) {
        setError(errorText(e))
      }
    })
  }

  if (view.enforced) {
    return (
      <div className={PANEL}>
        <p className={NOTE}>
          Every mutation refuses an account outside <Mono>{ADMIN_GROUP}</Mono>. Turning it off goes
          back to reporting only, and can only widen who is allowed.
        </p>
        {done !== null && <p className={cn(NOTE, 'text-success')}>{done}</p>}
        {error !== null && <p className={ERROR_NOTE}>{error}</p>}
        <div>
          <Button
            variant="outline"
            size="sm"
            className={GHOST_BTN}
            disabled={busy}
            onClick={() => flip(false)}
          >
            Turn enforcement off
          </Button>
        </div>
      </div>
    )
  }

  if (armed) {
    return (
      <div
        className={cn(PANEL, 'border-[color-mix(in_srgb,var(--danger)_40%,var(--border-soft))]')}
      >
        <p className={NOTE}>
          Enforcement refuses <b>every</b> mutation — Apply, deploys, image pins, secrets, this
          switch — from an account outside <Mono>{ADMIN_GROUP}</Mono>, including this one if the
          groups shown above do not include it. There is no other way back in but the box's console.
          The request that confirms is the proof: it must itself carry the group.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="destructive"
            size="sm"
            disabled={busy}
            onClick={() => flip(true)}
          >
            Confirm: refuse non-admins
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={GHOST_BTN}
            onClick={() => {
              setArmed(false)
            }}
          >
            Cancel
          </Button>
          <span className="text-[0.7rem] text-muted-foreground">
            disarms on its own in {ARM_MS / 1000}s
          </span>
        </div>
      </div>
    )
  }

  return (
    <div className={PANEL}>
      <p className={NOTE}>
        The check runs on every mutation and reports, but does not refuse. Turn it on once the rows
        above name <Mono>{ADMIN_GROUP}</Mono> for a request that came through the gate.
      </p>
      {done !== null && <p className={cn(NOTE, 'text-success')}>{done}</p>}
      {error !== null && <p className={ERROR_NOTE}>{error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy || !view.admin}
          onClick={() => {
            setArmed(true)
          }}
        >
          Turn enforcement on…
        </Button>
        {!view.admin && (
          <span className="text-[0.72rem] text-(--dim)">
            disabled: this request is not in <Mono>{ADMIN_GROUP}</Mono>; the server refuses it too
          </span>
        )}
      </div>
    </div>
  )
}
