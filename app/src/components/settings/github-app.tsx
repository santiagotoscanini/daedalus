import { ExternalLinkIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import type {
  GithubAppState,
  GithubAppStatus,
  GithubCallbackCode,
  GithubCallbackNotice,
} from '../../core/settings/types'
import type { SiteGithubApp } from '../../core/site/file'
import type { Tone } from '../../lib/tone'
import { Until, When } from '../ago'
import { useNow } from '../poll'
import { Alert, AlertDescription, AlertTitle } from '../ui/alert'
import { Button } from '../ui/button'
import { Chip } from '../viz'
import { CreateApp, PendingApply } from './github-app-steps'
import { PasteKey } from './github-paste-key'
import {
  ASIDE,
  Band,
  ExtLink,
  Mono,
  NOTE_SHOWN,
  Pending,
  Rows,
  Section,
  Stack,
  Unset,
} from './shared'

// The GitHub half of Settings › Integrations: the box's own GitHub App from
// creation through installation.
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
  const identity = app !== null && app.state !== 'none' ? app.identity : undefined
  return (
    <Section
      title="GitHub App"
      icon="/icon-github.svg"
      mono
      description="The box’s own App, which is how it talks to GitHub once created and installed."
      aside={
        app === null ? (
          <Pending className="w-20" />
        ) : (
          <Chip tone={APP_STATE[app.state].tone}>{APP_STATE[app.state].label}</Chip>
        )
      }
      body={
        <>
          {(notice !== null ||
            (app !== null && (app.state === 'none' || app.pending !== undefined))) && (
            <Band>
              {notice !== null && (
                <CallbackNotice notice={notice} app={app} onDismiss={onDismissNotice} />
              )}
              {app !== null && app.state === 'none' && <CreateApp app={app} />}
              {app !== null && app.state !== 'none' && app.pending !== undefined && (
                <PendingApply pending={app.pending} owner={app.owner} appsUrl={app.appsUrl} />
              )}
            </Band>
          )}
          {app !== null && identity !== undefined && <Rows framed rows={appFacts(app, identity)} />}
        </>
      }
    >
      {app !== null && identity !== undefined && (
        <div className="flex flex-wrap items-center gap-2 [&>form]:basis-full">
          <AppActions app={app} identity={identity} />
          <PasteKey settingsUrl={app.settingsUrl} />
        </div>
      )}
    </Section>
  )
}

/**
 * One sentence per callback code (core/settings/github-app.ts). The redirect
 * carries only the code, so no text from a URL ever reaches the page, and a
 * code this table does not know reads as `unknown`.
 */
const CALLBACK_SENTENCES: Record<GithubCallbackCode, string> = {
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

type Installation = NonNullable<GithubAppStatus['installation']>

/** The App's facts, as the section's rows: what it is, and — once installed — where and how fresh. */
function appFacts(app: GithubAppStatus, identity: SiteGithubApp): { k: string; v: ReactNode }[] {
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
  return rows
}

/** What the App's state asks for next: install it, install it on the owner too, or its settings. */
function AppActions({ app, identity }: { app: GithubAppStatus; identity: SiteGithubApp }) {
  const inst = app.installation
  const installed = app.state === 'installed' || app.state === 'installed-elsewhere'
  return (
    <div className="flex flex-col gap-3 empty:hidden has-[p]:basis-full">
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
          <p className={NOTE_SHOWN}>{installNote(inst)}</p>
        </div>
      )}
      {app.state === 'installed-elsewhere' && inst?.account != null && (
        <p className={NOTE_SHOWN}>
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
  // Before mount the server's clock would decide "expired" and the browser's
  // could disagree: read as fresh until the browser's own clock says.
  const now = useNow(false)
  const expires = i.expiresAt === null ? Number.NaN : Date.parse(i.expiresAt)
  if (!i.hasToken || !Number.isFinite(expires)) return <Chip tone="bad">no token</Chip>
  const left = now === null ? Number.POSITIVE_INFINITY : (expires - now) / 1000
  return (
    <Stack>
      <span className="inline-flex items-center gap-2">
        {left > 0 && !i.stale ? (
          <span className="text-[0.78rem] text-muted-foreground">fresh</span>
        ) : (
          <Chip tone={left <= 0 ? 'bad' : 'warn'}>{left <= 0 ? 'expired' : 'stale'}</Chip>
        )}
        {left > 0 && (
          <span className="text-[0.78rem] text-subdued">
            expires in <Until at={expires} />
          </span>
        )}
      </span>
      {i.mintedAt !== '' && <span className={ASIDE}>minted {<When at={i.mintedAt} />}</span>}
    </Stack>
  )
}
