import { useRouter } from '@tanstack/react-router'
import { ExternalLinkIcon, ServerIcon } from 'lucide-react'
import { type ReactNode, useEffect, useId, useState, useTransition } from 'react'

import type {
  BoxSettings,
  GithubCheck,
  IntegrationStatus,
  TokenCheck,
} from '../../core/settings/types'
import type { SiteEdit } from '../../core/site'
import { tokenShapeError } from '../../lib/cloudflare-token'
import { since, when } from '../../lib/format'
import { mailAddressError } from '../../lib/site-fields'
import {
  pollGithubSignInFn,
  replaceCloudflareTokenFn,
  startGithubSignInFn,
} from '../../server/settings'
import { Button, buttonVariants } from '../ui/button'
import { Input } from '../ui/input'
import { Chip } from '../viz'
import { ExtLink, Mono, Pending, Section, Unset, Value } from './shared'
import { SiteText, SiteUnwritten } from './site-fields'

// Two kinds of fact side by side: what is CONFIGURED (ids and whether a
// credential is present — known at once, from env) and whether it WORKS
// (asked of the service — deferred, cached five minutes). `status` is null
// while the second kind is in flight, and each live cell draws a skeleton
// rather than the section waiting as a whole.
//
// The two mail addresses are the only editable rows: nix sources them from
// site.json. The ids and tokens are not — the ids are read from the running
// configuration, the tokens live in the secret tree.

export function Integrations({
  settings,
  status,
  edit,
}: {
  settings: BoxSettings['integrations']
  status: IntegrationStatus | null
  edit: SiteEdit
}) {
  const cf = settings.cloudflare
  const gh = settings.github
  return (
    <div className="flex flex-col gap-6">
      <SiteUnwritten edit={edit} />

      <Section
        title="Cloudflare"
        icon="/icon-cloudflare.svg"
        description="The zone every hostname lives in, the tunnel public traffic arrives through, and the one token that drives both."
        rows={[
          { k: 'Account', v: <Value v={cf.accountId} /> },
          {
            k: 'Zone',
            v: (
              <Identified
                id={cf.zoneId}
                live={status === null ? undefined : status.cloudflare.zone}
                needs="Zone › Zone › Read"
              />
            ),
          },
          {
            k: 'Tunnel',
            v: (
              <Identified
                id={cf.tunnelId}
                live={status === null ? undefined : status.cloudflare.tunnel}
                needs="Account › Cloudflare One Connector: cloudflared › Read"
              />
            ),
          },
          {
            k: 'API token',
            v: (
              <Token
                configured={cf.tokenConfigured}
                check={status === null ? undefined : status.cloudflare.token}
              />
            ),
          },
        ]}
      >
        <ReplaceToken enabled={cf.tokenFromSite} />
        <p className="m-0 text-[0.78rem] text-(--text-muted)">
          One token does all of it: Zone › Zone › Read and Zone › DNS › Edit for the certificate,
          the tunnel's records, the dynamic address and the domain picker, and Account › Cloudflare
          One Connector: cloudflared › Read for the tunnel. The zone and tunnel names are read with
          it, which is what proves the scope rather than just the token.
        </p>
      </Section>

      <Section
        title="GitHub"
        icon="/icon-github.svg"
        mono
        description="Where the app repos live, and the tokens the box uses to read releases and drive CI."
        rows={[
          {
            k: 'Owner',
            v:
              gh.owner === '' ? (
                <Unset />
              ) : (
                <ExtLink href={`https://github.com/${gh.owner}`}>{gh.owner}</ExtLink>
              ),
          },
          {
            k: 'Token',
            v: (
              <Github
                configured={gh.tokenConfigured}
                check={status === null ? undefined : status.github.token}
              />
            ),
          },
          {
            k: 'Repo token',
            v: (
              <Github
                configured={gh.repoTokenConfigured}
                check={status === null ? undefined : status.github.repoToken}
              />
            ),
          },
        ]}
      >
        <GithubSignIn ready={gh.signInReady} fromSite={gh.tokenFromSite} owner={gh.owner} />
      </Section>

      <Section
        title="Mail relay"
        icon="/icon-gmail.svg"
        description="Every alert and failure mail on the box leaves through one Gmail relay."
        rows={[
          {
            k: 'Sender',
            v: (
              <SiteText
                edit={edit}
                field="mail.sender"
                label="Sender"
                validate={mailAddressError}
              />
            ),
          },
          {
            k: 'Alerts to',
            v: (
              <SiteText
                edit={edit}
                field="mail.alertTo"
                label="Alerts to"
                validate={mailAddressError}
              />
            ),
          },
          {
            k: 'Last send',
            v:
              status === null ? (
                <Pending />
              ) : status.mail.lastSentAt === null ? (
                <Unset label="nothing in the last 30 days" />
              ) : (
                <span className="inline-flex flex-col items-end gap-[0.1rem]">
                  <Mono>{when(status.mail.lastSentAt)}</Mono>
                  {status.mail.lastRecipient !== null && (
                    <span className="text-[0.78rem] text-(--text-muted)">
                      to {status.mail.lastRecipient}
                    </span>
                  )}
                </span>
              ),
          },
        ]}
      />

      <Section
        title="On this box"
        icon={<ServerIcon />}
        rows={[
          {
            k: 'Image registry',
            v:
              settings.registryUrl === '' ? (
                <Unset />
              ) : (
                <AppLink icon="/icon-zot.png" href={settings.registryUrl} />
              ),
          },
          {
            k: 'Grafana',
            v:
              settings.grafanaUrl === '' ? (
                <Unset />
              ) : (
                <AppLink icon="/icon-grafana.svg" href={settings.grafanaUrl} />
              ),
          },
        ]}
      />

      {status !== null && (
        <p className="m-0 text-[0.74rem] text-(--dim)">
          Checked {since((Date.now() - Date.parse(status.checkedAt)) / 1000)}; each service is asked
          at most every five minutes.
        </p>
      )}
    </div>
  )
}

/** A link to one of the box's own services, beside that service's mark. */
function AppLink({ icon, href }: { icon: string; href: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <img src={icon} alt="" width={16} height={16} className="size-4 flex-none object-contain" />
      <ExtLink href={href} />
    </span>
  )
}

/** An id the box is configured with, and the name the service knows it by. */
function Identified({
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

function Token({ configured, check }: { configured: boolean; check: TokenCheck | undefined }) {
  if (!configured) return <Chip tone="muted">not configured</Chip>
  if (check === undefined) return <Pending />
  if (!check.ok) return <Bad>{check.error ?? check.status ?? 'rejected'}</Bad>
  return (
    <span className="inline-flex items-center gap-2">
      <Chip tone="ok">{check.status ?? 'active'}</Chip>
      <span className="text-[0.78rem] text-(--text-muted)">
        {check.expiresOn === null ? 'no expiry' : `expires ${check.expiresOn.slice(0, 10)}`}
      </span>
    </span>
  )
}

function Github({ configured, check }: { configured: boolean; check: GithubCheck | undefined }) {
  if (!configured) return <Chip tone="muted">not configured</Chip>
  if (check === undefined) return <Pending />
  if (!check.ok) return <Bad>{check.error ?? 'rejected'}</Bad>
  const budget =
    check.rateLimit === null
      ? null
      : `${String(check.rateLimit.remaining)} of ${String(check.rateLimit.limit)} requests left this hour`
  return (
    <span className="inline-flex flex-col items-end gap-[0.1rem]">
      <span className="inline-flex items-center gap-2">
        <Chip tone="ok">{check.kind}</Chip>
        {check.login !== null && <Mono>{check.login}</Mono>}
      </span>
      <span className="text-[0.78rem] text-(--text-muted)">
        {check.kind === 'fine-grained'
          ? 'scopes are per-repository and not reported by the API'
          : check.scopes.length === 0
            ? 'no scopes'
            : check.scopes.join(', ')}
      </span>
      {budget !== null && <span className="text-[0.72rem] text-(--dim)">{budget}</span>}
    </span>
  )
}

const NOTE = 'm-0 text-[0.78rem] text-(--text-muted)'

/**
 * Replacing the Cloudflare token (core/settings/cloudflare-token.ts). The value
 * lives in this component only while it is typed, is cleared the moment it is
 * submitted, and never comes back from the server — the server answers with
 * what it checked, not with what it was given.
 */
function ReplaceToken({ enabled }: { enabled: boolean }) {
  const id = useId()
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [token, setToken] = useState('')
  const [busy, start] = useTransition()
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null)

  if (!enabled) {
    return (
      <p className={NOTE}>
        The box reads this token from stacks/cloudflared/env.sops for now, so it is replaced there.
        Once it reads the copy in site/vault/, it can be replaced from here.
      </p>
    )
  }

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
            text: `Checked and applying. It sees ${r.zones.join(', ')}; the rebuild restarts everything that reads the token.`,
          })
          await router.invalidate()
        } else {
          setOutcome({ ok: false, text: r.reason })
        }
      } catch (e) {
        setOutcome({ ok: false, text: e instanceof Error ? e.message : String(e) })
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
        {outcome !== null && (
          <span className={outcome.ok ? NOTE : 'm-0 text-[0.78rem] text-destructive'}>
            {outcome.text}
          </span>
        )}
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
        <p role="alert" className="m-0 text-[0.78rem] text-destructive">
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

type DeviceCode = { flow: string; userCode: string; verificationUri: string; interval: number }

/**
 * Signing the box in to GitHub (core/settings/github-signin.ts). The page only
 * ever holds the short code a person enters on github.com: the device code
 * that redeems it, and the token it becomes, stay on the server.
 */
function GithubSignIn({
  ready,
  fromSite,
  owner,
}: {
  ready: boolean
  fromSite: boolean
  owner: string
}) {
  const router = useRouter()
  const [code, setCode] = useState<DeviceCode | null>(null)
  const [starting, start] = useTransition()
  const [copied, setCopied] = useState(false)
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null)

  // One poll at a time, on the interval GitHub set. The server keeps the same
  // interval and answers an early poll itself, so a slow tab cannot hurry it.
  useEffect(() => {
    if (code === null) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const wait = (seconds: number) => {
      timer = setTimeout(async () => {
        try {
          const r = await pollGithubSignInFn({ data: { flow: code.flow } })
          if (stopped) return
          if (r.state === 'pending') {
            wait(r.interval)
            return
          }
          setCode(null)
          if (r.state === 'failed') {
            setOutcome({ ok: false, text: r.reason })
            return
          }
          setOutcome({
            ok: true,
            text: r.inUse
              ? `Signed in as ${r.login}. Applying: the rebuild restarts everything that uses the token.`
              : `Signed in as ${r.login}. The token is saved to site/vault/; the box moves to it once fleet.github.tokenFromSite is on.`,
          })
          await router.invalidate()
        } catch (e) {
          if (stopped) return
          setCode(null)
          setOutcome({ ok: false, text: e instanceof Error ? e.message : String(e) })
        }
      }, seconds * 1000)
    }
    wait(code.interval)
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [code, router])

  if (!ready) {
    return (
      <p className={NOTE}>
        Signing in from here needs the daedalus OAuth App's client id, which this engine does not
        carry yet.
      </p>
    )
  }

  if (code !== null) {
    return (
      <div className="flex flex-col gap-2 rounded-[9px] border border-(--border-soft) p-3">
        <p className={NOTE}>On GitHub, signed in as {owner}, enter this code:</p>
        <div className="flex flex-wrap items-center gap-3">
          <Mono className="text-[1.35rem] tracking-[0.14em]">{code.userCode}</Mono>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              navigator.clipboard.writeText(code.userCode).then(
                () => {
                  setCopied(true)
                },
                () => undefined,
              )
            }}
          >
            {copied ? 'Copied' : 'Copy code'}
          </Button>
          <a
            href={code.verificationUri}
            target="_blank"
            rel="noreferrer"
            className={buttonVariants({ size: 'sm' })}
          >
            Open GitHub
            <ExternalLinkIcon />
          </a>
        </div>
        <p className={NOTE}>
          Waiting for your approval. GitHub shows the daedalus app asking for the repo scope; once
          you approve, the token is checked, encrypted here, saved to site/vault/ and applied.
        </p>
        <div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setCode(null)
            }}
          >
            Cancel
          </Button>
        </div>
      </div>
    )
  }

  const begin = () => {
    setOutcome(null)
    start(async () => {
      try {
        const r = await startGithubSignInFn()
        if (r.ok) {
          setCopied(false)
          setCode({
            flow: r.flow,
            userCode: r.userCode,
            verificationUri: r.verificationUri,
            interval: r.interval,
          })
        } else {
          setOutcome({ ok: false, text: r.reason })
        }
      } catch (e) {
        setOutcome({ ok: false, text: e instanceof Error ? e.message : String(e) })
      }
    })
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" size="sm" disabled={starting} onClick={begin}>
          {starting ? 'Starting…' : fromSite ? 'Sign in again…' : 'Sign in with GitHub…'}
        </Button>
        {outcome !== null && (
          <span className={outcome.ok ? NOTE : 'm-0 text-[0.78rem] text-destructive'}>
            {outcome.text}
          </span>
        )}
      </div>
      <p className={NOTE}>
        {fromSite
          ? 'The box uses the token a sign-in wrote to site/vault/.'
          : 'The box still uses its older tokens.'}{' '}
        Signing in uses GitHub's device flow: you approve the daedalus app on github.com, and the
        token it grants never passes through this page.
      </p>
    </div>
  )
}

function Bad({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2">
      <Chip tone="bad">failing</Chip>
      <span className="text-[0.78rem] text-(--text-muted)">{children}</span>
    </span>
  )
}
