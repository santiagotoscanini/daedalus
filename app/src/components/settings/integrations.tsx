import { useRouter } from '@tanstack/react-router'
import { ExternalLinkIcon, ServerIcon } from 'lucide-react'
import { type ReactNode, useEffect, useId, useRef, useState, useTransition } from 'react'

import type {
  BoxSettings,
  GithubAppState,
  GithubAppStatus,
  GithubCallbackCode,
  GithubCallbackNotice,
  GithubCheck,
  IntegrationStatus,
  TokenCheck,
} from '../../core/settings/types'
import type { SiteEdit } from '../../core/site'
import type { SiteGithubApp } from '../../core/site/file'
import { tokenShapeError } from '../../lib/cloudflare-token'
import { since, until, when } from '../../lib/format'
import { mailAddressError } from '../../lib/site-fields'
import type { Tone } from '../../lib/tone'
import {
  discardGithubPendingApplyFn,
  pasteAppKeyFn,
  replaceCloudflareTokenFn,
  retryGithubApplyFn,
  startGithubAppFn,
} from '../../server/settings'
import { Alert, AlertDescription, AlertTitle } from '../ui/alert'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Textarea } from '../ui/textarea'
import { Chip, Facts } from '../viz'
import { ExtLink, Mono, NOTE, Pending, Section, Unset, Value } from './shared'
import { SiteText, SiteUnwritten } from './site-fields'

// Two kinds of fact side by side: what is CONFIGURED (ids and whether a
// credential is present — known at once, from env) and whether it WORKS
// (asked of the service — deferred, cached five minutes). `status` is null
// while the second kind is in flight, and each live cell draws a skeleton
// rather than the section waiting as a whole.
//
// The two mail addresses are the only editable rows: nix sources them from
// site.json. The ids and tokens are not — the ids are read from the running
// configuration, the tokens live in the secret tree. The GitHub App is created
// from here, but what it writes goes through its own Apply.

export type GithubAppProps = {
  app: GithubAppStatus | null
  notice: GithubCallbackNotice | null
  onDismissNotice: () => void
}

export function Integrations({
  settings,
  status,
  edit,
  github,
}: {
  settings: BoxSettings['integrations']
  status: IntegrationStatus | null
  edit: SiteEdit
  github: GithubAppProps
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
        <ReplaceToken />
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
        description="Where the app repos live, and how the box talks to GitHub: the repo-token override below, and its own App once one is created and installed."
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
            k: 'Repo token',
            v: (
              <Github
                configured={status === null || status.github.repoToken.configured}
                check={status === null ? undefined : status.github.repoToken}
              />
            ),
          },
        ]}
      >
        <GithubApp {...github} />
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
const ERROR_NOTE = 'm-0 text-[0.78rem] text-destructive'
const FIELD_LABEL = 'font-medium text-[0.8rem]'
const PANEL = 'flex flex-col gap-2 rounded-[9px] border border-(--border-soft) p-3'

/**
 * Replacing the Cloudflare token (core/settings/cloudflare-token.ts). The value
 * lives in this component only while it is typed, is cleared the moment it is
 * submitted, and never comes back from the server — the server answers with
 * what it checked, not with what it was given.
 */
function ReplaceToken() {
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

// ── GitHub App ─────────────────────────────────────────────────────────────

const WAITING_FOR_HOST = 'Waiting for the host to support GitHub Apps.'

const APP_STATE: Record<GithubAppState, { tone: Tone; label: string }> = {
  none: { tone: 'muted', label: 'not created' },
  created: { tone: 'warn', label: 'not installed' },
  installed: { tone: 'ok', label: 'installed' },
  'installed-elsewhere': { tone: 'warn', label: 'installed elsewhere' },
  'pending-apply': { tone: 'warn', label: 'waiting for Apply' },
}

/**
 * The box's own GitHub App (core/settings/github-app.ts). Creating one is a
 * real form POST to github.com; GitHub sends the browser back to
 * /settings/github/callback, and the server trades the code for the App's
 * credentials, seals them and applies. No secret ever reaches this component
 * except the ones typed into the recovery form, which are cleared on submit.
 */
function GithubApp({ app, notice, onDismissNotice }: GithubAppProps) {
  return (
    <div className="flex flex-col gap-3 border-t border-(--border-soft) pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="m-0 font-medium text-[0.9rem]">GitHub App</h3>
        {app === null ? (
          <Pending className="w-20" />
        ) : (
          <Chip tone={APP_STATE[app.state].tone}>{APP_STATE[app.state].label}</Chip>
        )}
      </div>
      {notice !== null && <CallbackNotice notice={notice} app={app} onDismiss={onDismissNotice} />}
      {app !== null &&
        (app.state === 'none' ? (
          <CreateApp app={app} />
        ) : (
          <>
            {app.pending !== undefined && (
              <PendingApply
                enabled={app.enabled}
                pending={app.pending}
                owner={app.owner}
                appsUrl={app.appsUrl}
              />
            )}
            {app.identity !== undefined && <AppFacts app={app} identity={app.identity} />}
            {app.identity !== undefined && (
              <PasteKey enabled={app.enabled} settingsUrl={app.settingsUrl} />
            )}
          </>
        ))}
    </div>
  )
}

/**
 * One sentence per callback code (core/settings/github-app.ts). The redirect
 * carries only the code, so no text from a URL ever reaches the page, and a
 * code this table does not know reads as `unknown`.
 */
const CALLBACK_SENTENCES: Record<GithubCallbackCode, string> = {
  disabled: 'The host does not support GitHub Apps yet, so nothing was kept.',
  'state-expired':
    'The creation expired. GitHub has to send you back within an hour of starting it.',
  'state-mismatch':
    'The answer from GitHub did not match an App creation started here, or it had already been used.',
  'other-actor': 'Someone else started this App creation. Start it again yourself.',
  'conversion-failed': 'GitHub did not hand over the App’s credentials.',
  'conversion-timeout':
    'GitHub took too long to hand over the App’s credentials, and the code it sent works only once.',
  'owner-mismatch':
    'GitHub created the App under a different account from the one this box builds for.',
  'seal-failed': 'The App’s credentials could not be encrypted, so nothing was applied.',
  'apply-refused':
    'The Apply was refused. The App’s key and secrets are kept here, encrypted, until it goes through; retry from the banner below.',
  'already-created':
    'This box already has a GitHub App, and this creation was not started as a replacement.',
  unknown: 'Something failed on this server while finishing the App.',
}

const callbackSentence = (code: string | null): string =>
  code !== null && Object.hasOwn(CALLBACK_SENTENCES, code)
    ? CALLBACK_SENTENCES[code as GithubCallbackCode]
    : CALLBACK_SENTENCES.unknown

function CallbackNotice({
  notice,
  app,
  onDismiss,
}: {
  notice: GithubCallbackNotice
  app: GithubAppStatus | null
  onDismiss: () => void
}) {
  const view =
    notice.github === 'created'
      ? {
          variant: 'success' as const,
          title: 'GitHub App created',
          body: 'Its private key and secrets are encrypted and the Apply has started. Install the App once the rebuild finishes.',
        }
      : notice.github === 'installed'
        ? {
            variant: 'success' as const,
            title: 'Installed on GitHub',
            body: 'The box is fetching access now; this can take a minute.',
          }
        : notice.github === 'pending'
          ? {
              variant: 'warning' as const,
              title: 'GitHub App created, but not applied',
              body: CALLBACK_SENTENCES['apply-refused'],
            }
          : {
              variant: 'destructive' as const,
              title: 'The GitHub App was not set up',
              body: callbackSentence(notice.code),
            }
  return (
    <Alert variant={view.variant}>
      <AlertTitle>{view.title}</AlertTitle>
      <AlertDescription>
        <p className="m-0">{view.body}</p>
        {/* GitHub registers the App before it redirects, so a failed callback
            can leave one behind holding the name. The link comes from the
            server's status, never from the query. */}
        {notice.github === 'failed' && (
          <p className="m-0">
            If GitHub created the App anyway, delete it before starting again, or its name stays
            taken:{' '}
            {app === null ? (
              'Developer settings › GitHub Apps on GitHub'
            ) : (
              <a
                href={app.appsUrl}
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2"
              >
                {app.owner}’s GitHub Apps
              </a>
            )}
            .
          </p>
        )}
        <Button type="button" variant="ghost" size="sm" className="-ml-2 h-7" onClick={onDismiss}>
          Dismiss
        </Button>
      </AlertDescription>
    </Alert>
  )
}

type Launch = { action: string; manifest: string; state: string }

function CreateApp({ app }: { app: GithubAppStatus }) {
  const id = useId()
  const [name, setName] = useState(app.defaultName)
  const [busy, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [launch, setLaunch] = useState<Launch | null>(null)
  const launcher = useRef<HTMLFormElement>(null)

  // GitHub reads the manifest from a form body and answers with its own
  // confirmation page, so this has to be a top-level POST, not a fetch.
  useEffect(() => {
    if (launch !== null) launcher.current?.submit()
  }, [launch])

  // Back from GitHub without confirming: a page restored from the bfcache
  // still holds the launch, and with it a disabled button.
  useEffect(() => {
    const reset = (e: PageTransitionEvent) => {
      if (e.persisted) setLaunch(null)
    }
    window.addEventListener('pageshow', reset)
    return () => {
      window.removeEventListener('pageshow', reset)
    }
  }, [])

  const trimmed = name.trim()
  const tooLong = [...trimmed].length > app.nameMax
  const canCreate = app.enabled && !busy && launch === null && trimmed !== '' && !tooLong

  const create = () => {
    if (!canCreate) return
    setError(null)
    start(async () => {
      try {
        const r = await startGithubAppFn({ data: { name: trimmed } })
        if (r.ok) setLaunch({ action: r.action, manifest: r.manifest, state: r.state })
        else setError(r.reason)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    })
  }

  return (
    <div className="flex flex-col gap-2">
      <p className={NOTE}>
        The box registers an App of its own under {app.owner}. GitHub shows what the App may do and
        sends you back here once you confirm. Its private key and secrets are exchanged on the
        server and encrypted before they are applied; this page never holds them.
      </p>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          create()
        }}
      >
        <div className="flex min-w-[14rem] flex-1 flex-col gap-1">
          <label htmlFor={id} className={FIELD_LABEL}>
            App name
          </label>
          <Input
            id={id}
            value={name}
            maxLength={app.nameMax}
            disabled={!app.enabled}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={tooLong}
            onChange={(e) => {
              setName(e.target.value)
            }}
            className="h-9 font-mono md:text-[0.8rem]"
          />
        </div>
        <Button type="submit" size="sm" className="h-9" disabled={!canCreate}>
          {busy || launch !== null ? 'Opening GitHub…' : 'Create GitHub App…'}
        </Button>
      </form>
      <p className={NOTE}>
        {app.enabled
          ? `App names are unique across GitHub, ${String(app.nameMax)} characters at most.`
          : `${WAITING_FOR_HOST} Until then it has nowhere to keep the App’s private key.`}
      </p>
      {error !== null && (
        <p role="alert" className={ERROR_NOTE}>
          {error}
        </p>
      )}
      {launch !== null && (
        <form ref={launcher} method="post" action={launch.action} className="hidden">
          <input type="hidden" name="manifest" defaultValue={launch.manifest} />
          <input type="hidden" name="state" defaultValue={launch.state} />
        </form>
      )}
    </div>
  )
}

type Installation = NonNullable<GithubAppStatus['installation']>

function AppFacts({ app, identity }: { app: GithubAppStatus; identity: SiteGithubApp }) {
  const inst = app.installation
  const installed = app.state === 'installed' || app.state === 'installed-elsewhere'
  const rows: { k: string; v: ReactNode }[] = [
    { k: 'App', v: <ExtLink href={identity.htmlUrl}>{identity.slug}</ExtLink> },
    { k: 'App id', v: <Mono>{String(identity.id)}</Mono> },
    { k: 'Client id', v: <Mono>{identity.clientId}</Mono> },
    { k: 'Owner', v: <Mono>{identity.owner}</Mono> },
  ]
  if (installed && inst !== undefined) {
    rows.push(
      {
        k: 'Installed on',
        v:
          inst.account === null ? (
            <Unset />
          ) : (
            <ExtLink href={`https://github.com/${inst.account.login}`}>
              {inst.account.login}
            </ExtLink>
          ),
      },
      {
        k: 'Repositories',
        v:
          inst.repositorySelection === 'all' ? (
            <span>every repository</span>
          ) : inst.repositorySelection === 'selected' ? (
            <span>selected repositories</span>
          ) : (
            <Unset />
          ),
      },
      { k: 'Token', v: <TokenFreshness installation={inst} /> },
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <Facts rows={rows} list />
      {app.state === 'created' && app.installUrl !== undefined && (
        <div className="flex flex-col gap-2">
          <div>
            <Button asChild size="sm">
              <a href={app.installUrl} target="_blank" rel="noreferrer">
                Install on GitHub
                <ExternalLinkIcon />
              </a>
            </Button>
          </div>
          <p className={NOTE}>{installNote(inst)}</p>
        </div>
      )}
      {app.state === 'installed-elsewhere' && inst?.account != null && (
        <p className={NOTE}>
          The installation the host found is on {inst.account.login}, but the box builds{' '}
          {identity.owner}’s repositories. Install the App on {identity.owner} as well.
        </p>
      )}
      {installed && app.settingsUrl !== undefined && (
        <div>
          <Button asChild variant="outline" size="sm">
            <a href={app.settingsUrl} target="_blank" rel="noreferrer">
              App settings
              <ExternalLinkIcon />
            </a>
          </Button>
        </div>
      )}
    </div>
  )
}

function installNote(inst: Installation | undefined): string {
  const pick = 'Pick the repositories the box should build; more can be added later.'
  if (inst === undefined) {
    return `Not installed yet. ${pick} It shows as installed here once the host’s token minter has run.`
  }
  if (inst.state === 'error') {
    return `Not installed yet. ${pick} The host’s token minter says: ${inst.reason ?? 'error'}.`
  }
  return `Not installed yet. ${pick}`
}

function TokenFreshness({ installation: i }: { installation: Installation }) {
  const expires = i.expiresAt === null ? Number.NaN : Date.parse(i.expiresAt)
  if (!i.hasToken || !Number.isFinite(expires)) return <Chip tone="bad">no token</Chip>
  const left = (expires - Date.now()) / 1000
  return (
    <span className="inline-flex flex-col items-end gap-[0.1rem]">
      <span className="inline-flex items-center gap-2">
        <Chip tone={left <= 0 ? 'bad' : i.stale ? 'warn' : 'ok'}>
          {left <= 0 ? 'expired' : i.stale ? 'stale' : 'fresh'}
        </Chip>
        {left > 0 && (
          <span className="text-[0.78rem] text-(--text-muted)">expires in {until(left)}</span>
        )}
      </span>
      {i.mintedAt !== '' && (
        <span className="text-[0.72rem] text-(--dim)">minted {when(i.mintedAt)}</span>
      )}
    </span>
  )
}

function PendingApply({
  enabled,
  pending,
  owner,
  appsUrl,
}: {
  enabled: boolean
  pending: NonNullable<GithubAppStatus['pending']>
  owner: string
  appsUrl: string
}) {
  const router = useRouter()
  const [busy, start] = useTransition()
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null)
  const [discarded, setDiscarded] = useState<string | null>(null)

  const discard = () => {
    setOutcome(null)
    start(async () => {
      try {
        const r = await discardGithubPendingApplyFn()
        if (r.ok) setDiscarded(r.slug)
        else setOutcome({ ok: false, text: r.reason })
      } catch (e) {
        setOutcome({ ok: false, text: e instanceof Error ? e.message : String(e) })
      }
    })
  }

  // Held on screen rather than refreshed away: the tab would redraw as if
  // nothing had happened, while the one step left is on GitHub.
  if (discarded !== null) {
    return (
      <Alert>
        <AlertTitle>Discarded {discarded}</AlertTitle>
        <AlertDescription>
          <p className="m-0">
            The box forgot its encrypted key and secrets, so it can no longer use this App. The App
            itself may still exist on GitHub: delete it from{' '}
            <a
              href={appsUrl}
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2"
            >
              {owner}’s GitHub Apps
            </a>{' '}
            if nothing else uses it, or its name stays taken.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              void router.invalidate()
            }}
          >
            Done
          </Button>
        </AlertDescription>
      </Alert>
    )
  }

  const retry = () => {
    setOutcome(null)
    start(async () => {
      try {
        const r = await retryGithubApplyFn()
        if (r.ok) {
          setOutcome({ ok: true, text: 'Applying. Install the App once the rebuild finishes.' })
          await router.invalidate()
        } else {
          setOutcome({ ok: false, text: r.reason })
        }
      } catch (e) {
        setOutcome({ ok: false, text: e instanceof Error ? e.message : String(e) })
      }
    })
  }

  return (
    <Alert variant="warning">
      <AlertTitle>{pending.slug} exists on GitHub but has not been applied</AlertTitle>
      <AlertDescription>
        <p className="m-0">{pending.reason}</p>
        <p className="m-0">
          Its key and secrets are kept here, encrypted, since {when(pending.at)}. Retry once nothing
          else is waiting to be applied, or discard them if this App is not the one to keep.
        </p>
        <div className="flex flex-wrap items-center gap-3 pt-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy || !enabled}
            onClick={retry}
          >
            {busy ? 'Working…' : 'Retry Apply'}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy || !enabled}
            onClick={discard}
          >
            Discard
          </Button>
          {outcome !== null && (
            <span className={outcome.ok ? NOTE : ERROR_NOTE}>{outcome.text}</span>
          )}
          {!enabled && <span className={NOTE}>{WAITING_FOR_HOST}</span>}
        </div>
      </AlertDescription>
    </Alert>
  )
}

/**
 * Recovery: a new private key for the App site.json names. The three values
 * are typed here, sent once, and cleared on submit; nothing comes back.
 */
function PasteKey({ enabled, settingsUrl }: { enabled: boolean; settingsUrl: string | undefined }) {
  const pemId = useId()
  const webhookId = useId()
  const clientId = useId()
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pem, setPem] = useState('')
  const [webhookSecret, setWebhookSecret] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [busy, start] = useTransition()
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null)

  const clear = () => {
    setPem('')
    setWebhookSecret('')
    setClientSecret('')
  }
  const ready = enabled && !busy && pem.trim() !== '' && webhookSecret !== '' && clientSecret !== ''

  const submit = () => {
    if (!ready) return
    const data = { pem, webhookSecret, clientSecret }
    clear()
    setOutcome(null)
    start(async () => {
      try {
        const r = await pasteAppKeyFn({ data })
        if (r.ok) {
          setOpen(false)
          setOutcome({
            ok: true,
            text: 'Encrypted and applying. The new webhook secret has to be saved on GitHub too.',
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
          type="button"
          variant="ghost"
          size="sm"
          className="-ml-2"
          onClick={() => {
            setOpen(true)
            setOutcome(null)
          }}
        >
          Paste a private key…
        </Button>
        {outcome !== null && <span className={outcome.ok ? NOTE : ERROR_NOTE}>{outcome.text}</span>}
      </div>
    )
  }

  return (
    <form
      className={PANEL}
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <p className={NOTE}>
        For a lost or rotated key. The box keeps the key, the webhook secret and the client secret
        in one sealed file it cannot read back, so all three are replaced together. On the App’s
        settings page, generate a private key and a new client secret, and set a new webhook secret
        there as well: deliveries fail to verify while the two sides disagree.
      </p>
      <label htmlFor={pemId} className={FIELD_LABEL}>
        Private key
      </label>
      <Textarea
        id={pemId}
        rows={6}
        value={pem}
        disabled={!enabled}
        spellCheck={false}
        autoComplete="off"
        placeholder="-----BEGIN RSA PRIVATE KEY-----"
        onChange={(e) => {
          setPem(e.target.value)
        }}
        className="max-h-60 font-mono text-[0.74rem] md:text-[0.74rem]"
      />
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <label htmlFor={webhookId} className={FIELD_LABEL}>
            Webhook secret
          </label>
          <Input
            id={webhookId}
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={webhookSecret}
            disabled={!enabled}
            onChange={(e) => {
              setWebhookSecret(e.target.value)
            }}
            className="h-9 font-mono md:text-[0.8rem]"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={clientId} className={FIELD_LABEL}>
            Client secret
          </label>
          <Input
            id={clientId}
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={clientSecret}
            disabled={!enabled}
            onChange={(e) => {
              setClientSecret(e.target.value)
            }}
            className="h-9 font-mono md:text-[0.8rem]"
          />
        </div>
      </div>
      {!enabled && <p className={NOTE}>{WAITING_FOR_HOST}</p>}
      {outcome !== null && !outcome.ok && (
        <p role="alert" className={ERROR_NOTE}>
          {outcome.text}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={!ready}>
          {busy ? 'Encrypting…' : 'Encrypt and apply'}
        </Button>
        {settingsUrl !== undefined && (
          <Button asChild variant="outline" size="sm">
            <a href={settingsUrl} target="_blank" rel="noreferrer">
              App settings
              <ExternalLinkIcon />
            </a>
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            setOpen(false)
            clear()
          }}
        >
          Cancel
        </Button>
      </div>
    </form>
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
