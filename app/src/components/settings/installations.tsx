import { useState } from 'react'
import type { InstallationStatus } from '../../core/settings/types'
import { useShown } from '../../lib/shown'
import { trustAccountFn, trustInstallationFn, untrustAccountFn } from '../../server/settings'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Switch } from '../ui/switch'
import { useAction } from '../use-action'
import { Chip } from '../viz'
import { ASIDE, ERROR_NOTE, ExtLink, NOTE } from './shared'

// The accounts the box's GitHub App may read: the owner's installation, which
// builds, and every account the operator switched on (site.json
// github.trustedAccounts, core/site/trusted-accounts.ts). Trust comes first
// and installing second: switch an org on here, Apply, then install the App
// on it from the row's link. An account that installs the App without being
// switched on is listed too — with no token until it is.
//
// A permission the box asks for and an installation has not accepted is
// named with the clicks that grant it; GitHub offers no API for that.

export function Installations({
  list,
  settingsUrl,
  installUrl,
}: {
  list: InstallationStatus[]
  settingsUrl: string | null
  installUrl: string | null
}) {
  const action = useAction()
  const missing = list.some((i) => i.missing.length > 0)
  return (
    <div className="flex flex-col gap-2">
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
        {list.map((i) => (
          <AccountRow
            key={i.accountId ?? i.account}
            i={i}
            installUrl={installUrl}
            action={action}
          />
        ))}
      </ul>
      <AddAccount action={action} />
      {action.error !== null && <p className={ERROR_NOTE}>{action.error}</p>}
      {action.notice !== null && <p className={NOTE}>{action.notice}</p>}
      {missing && (
        <p className={NOTE}>
          To grant a missing permission: the App's{' '}
          {settingsUrl === null ? (
            'settings'
          ) : (
            <ExtLink href={`${settingsUrl}/permissions`}>permissions</ExtLink>
          )}{' '}
          → Repository permissions → set it to Read-only → Save; then accept the request on each
          installation. The box picks it up within half an hour.
        </p>
      )}
    </div>
  )
}

type Action = ReturnType<typeof useAction>

const avatar = (id: number | null) =>
  id === null ? null : `https://avatars.githubusercontent.com/u/${String(id)}?s=48`

function AccountRow({
  i,
  installUrl,
  action,
}: {
  i: InstallationStatus
  installUrl: string | null
  action: Action
}) {
  const trusted = i.owner || (i.pending !== null ? i.pending === 'trust' : i.state !== 'untrusted')
  const [shown, show] = useShown(trusted, action.busy, action.error !== null)
  const src = avatar(i.accountId)
  const toggle = (on: boolean) => {
    const { installationId, accountId, account } = i
    if (accountId === null) return
    show(on)
    action.run(
      () =>
        on
          ? installationId !== null
            ? trustInstallationFn({ data: { installationId } })
            : trustAccountFn({ data: { login: account } })
          : untrustAccountFn({ data: { id: accountId } }),
      {
        notice: on
          ? `${account} is trusted on the next Apply.`
          : `${account} stops being trusted on the next Apply.`,
      },
    )
  }
  return (
    <li className="flex min-w-0 flex-wrap items-center gap-2.5">
      <Switch
        checked={shown}
        disabled={i.owner || action.busy || i.accountId === null}
        aria-label={i.owner ? `${i.account} owns the App` : `Trust ${i.account}`}
        onCheckedChange={toggle}
      />
      {src !== null && <img src={src} alt="" width={22} height={22} className="rounded-[5px]" />}
      <ExtLink href={`https://github.com/${i.account}`}>{i.account}</ExtLink>
      <Chip tone={tone(i)}>{label(i)}</Chip>
      <span className={ASIDE}>{detail(i)}</span>
      {i.state === 'not-installed' && trusted && installUrl !== null && i.accountId !== null && (
        <a
          className="text-[0.78rem]"
          href={`${installUrl}/permissions?target_id=${String(i.accountId)}`}
          target="_blank"
          rel="noreferrer"
        >
          Install on {i.account} ↗
        </a>
      )}
    </li>
  )
}

/** An account to trust before it installs the App, by its GitHub name. */
function AddAccount({ action }: { action: Action }) {
  const [login, setLogin] = useState('')
  return (
    <form
      className="flex max-w-[26rem] items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        const value = login.trim()
        if (value === '') return
        action.run(() => trustAccountFn({ data: { login: value } }), {
          onDone: () => {
            setLogin('')
          },
          notice: `${value} is trusted on the next Apply; install the App on it from its row.`,
        })
      }}
    >
      <Input
        value={login}
        onChange={(e) => {
          setLogin(e.target.value)
        }}
        placeholder="an org or account name"
        aria-label="GitHub account to trust"
        spellCheck={false}
        className="h-8 md:text-[0.8rem]"
      />
      <Button
        type="submit"
        variant="outline"
        size="sm"
        disabled={action.busy || login.trim() === ''}
      >
        Trust
      </Button>
    </form>
  )
}

function label(i: InstallationStatus): string {
  if (i.owner) return i.state === 'ok' ? 'builds' : 'no token'
  switch (i.state) {
    case 'untrusted':
      return 'not trusted'
    case 'not-installed':
      return 'not installed'
    case 'ok':
      return 'reads'
    case 'error':
      return 'no token'
  }
}

function tone(i: InstallationStatus): 'ok' | 'warn' | 'bad' | 'muted' {
  if (i.state === 'error') return 'bad'
  if (i.state === 'untrusted') return 'warn'
  if (i.state === 'not-installed') return 'muted'
  return i.missing.length > 0 ? 'warn' : 'ok'
}

function detail(i: InstallationStatus): string {
  const parts: string[] = []
  if (i.selection !== null) {
    parts.push(i.selection === 'all' ? 'every repository' : 'selected repositories')
  }
  if (i.missing.length > 0) parts.push(`not granted: ${i.missing.join(', ')}`)
  if (i.state === 'error' && i.reason !== null) parts.push(i.reason)
  if (i.pending === 'trust') parts.push('trusted on the next Apply')
  if (i.pending === 'untrust') parts.push('untrusted on the next Apply')
  return parts.join(' · ')
}
