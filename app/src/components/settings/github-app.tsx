import { useRouter } from '@tanstack/react-router'
import { ExternalLinkIcon } from 'lucide-react'
import { type ReactNode, useEffect, useId, useRef, useState, useTransition } from 'react'
import type {
  GithubAppState,
  GithubAppStatus,
  GithubCallbackCode,
  GithubCallbackNotice,
  GithubCheck,
} from '../../core/settings/types'
import type { SiteGithubApp } from '../../core/site/file'
import { until, when } from '../../lib/format'
import { errorText } from '../../lib/redact'
import type { Tone } from '../../lib/tone'
import {
  discardGithubPendingApplyFn,
  retryGithubApplyFn,
  startGithubAppFn,
} from '../../server/settings'
import { Alert, AlertDescription, AlertTitle } from '../ui/alert'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Chip } from '../viz'
import { PasteKey } from './github-paste-key'
import {
  ASIDE,
  Bad,
  ERROR_NOTE,
  ExtLink,
  FIELD_LABEL,
  Mono,
  NOTE,
  Pending,
  Rows,
  Stack,
  Unset,
  WAITING_FOR_HOST,
} from './shared'

// The GitHub half of Settings › Integrations: the repo-token cell, and the
// box's own GitHub App from creation through installation.
//
// One module because it is one state machine — `GithubAppStatus.state` moves
// none → created → installed, the callback banner explains how the last
// transition went, and the pending-Apply banner is the state it gets stuck in.
// Reading any one of those alone tells you very little.

export type GithubAppProps = {
  app: GithubAppStatus | null
  notice: GithubCallbackNotice | null
  onDismissNotice: () => void
}

export function Github({
  configured,
  check,
}: {
  configured: boolean
  check: GithubCheck | undefined
}) {
  if (!configured) return <Chip tone="muted">not configured</Chip>
  if (check === undefined) return <Pending />
  if (!check.ok) return <Bad>{check.reason ?? 'rejected'}</Bad>
  const { kind, login, scopes, rateLimit } = check.value
  const budget =
    rateLimit === null
      ? null
      : `${String(rateLimit.remaining)} of ${String(rateLimit.limit)} requests left this hour`
  return (
    <Stack>
      <span className="inline-flex items-center gap-2">
        <Chip tone="ok">{kind}</Chip>
        {login !== null && <Mono>{login}</Mono>}
      </span>
      <span className="text-[0.78rem] text-(--text-muted)">
        {kind === 'fine-grained'
          ? 'scopes are per-repository and not reported by the API'
          : scopes.length === 0
            ? 'no scopes'
            : scopes.join(', ')}
      </span>
      {budget !== null && <span className={ASIDE}>{budget}</span>}
    </Stack>
  )
}

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
export function GithubApp({ app, notice, onDismissNotice }: GithubAppProps) {
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
        if (r.ok) setLaunch(r.value)
        else setError(r.reason)
      } catch (e) {
        setError(errorText(e))
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
      <Rows rows={rows} />
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
    <Stack>
      <span className="inline-flex items-center gap-2">
        <Chip tone={left <= 0 ? 'bad' : i.stale ? 'warn' : 'ok'}>
          {left <= 0 ? 'expired' : i.stale ? 'stale' : 'fresh'}
        </Chip>
        {left > 0 && (
          <span className="text-[0.78rem] text-(--text-muted)">expires in {until(left)}</span>
        )}
      </span>
      {i.mintedAt !== '' && <span className={ASIDE}>minted {when(i.mintedAt)}</span>}
    </Stack>
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
        if (r.ok) setDiscarded(r.value.slug)
        else setOutcome({ ok: false, text: r.reason })
      } catch (e) {
        setOutcome({ ok: false, text: errorText(e) })
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
        setOutcome({ ok: false, text: errorText(e) })
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
