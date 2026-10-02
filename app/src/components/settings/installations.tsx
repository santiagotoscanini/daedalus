import type { InstallationStatus } from '../../core/settings/types'
import { Chip } from '../viz'
import { ExtLink, NOTE } from './shared'

// Every account and org the box's GitHub App is installed on: the owner's,
// which builds and reports, and any other, whose read-only token is how the
// off-box list finds that account's Pages sites. A permission the box asks
// for and the installation has not accepted is named with the two clicks
// that grant it — GitHub offers no API for it, so it is the operator's step.

export function Installations({
  list,
  settingsUrl,
  installUrl,
}: {
  list: InstallationStatus[]
  settingsUrl: string | null
  installUrl: string | null
}) {
  const missing = list.some((i) => i.missing.length > 0)
  return (
    <div className="flex flex-col gap-1.5">
      {list.length === 0 && <span className="text-[0.82rem] text-subdued">none yet</span>}
      {list.map((i) => (
        <span key={i.account} className="inline-flex flex-wrap items-center gap-2">
          <Chip tone={!i.ok ? 'bad' : i.missing.length > 0 ? 'warn' : 'ok'}>
            {!i.ok ? 'no token' : i.owner ? 'builds' : 'reads'}
          </Chip>
          <ExtLink href={`https://github.com/${i.account}`}>{i.account}</ExtLink>
          {i.selection !== null && (
            <span className="text-[0.76rem] text-subdued">
              {i.selection === 'all' ? 'every repository' : 'selected repositories'}
            </span>
          )}
          {i.missing.length > 0 && (
            <span className="text-[0.76rem] text-subdued">not granted: {i.missing.join(', ')}</span>
          )}
          {!i.ok && i.reason !== null && (
            <span className="text-[0.76rem] text-subdued">{i.reason}</span>
          )}
        </span>
      ))}
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
      {installUrl !== null && (
        <p className={NOTE}>
          <ExtLink href={installUrl}>Install on another account or org</ExtLink> to list its Pages
          sites too.
        </p>
      )}
    </div>
  )
}
