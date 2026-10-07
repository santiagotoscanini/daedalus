// The Sign-in board: the login this server connects with, and the one date on
// it worth acting on.

import type { ClaudeFacts } from '../../lib/dashboard/claude'
import { DASH, text } from '../../lib/format'
import { Until } from '../ago'
import { EMPTY, FOOT, MONO } from '../tokens'
import { Board, Facts } from '../viz'
import { LEFT_FACTS } from './shared'

export function SignInBoard({
  credentials,
  reporting,
}: {
  credentials: ClaudeFacts['credentials']
  /** Whether the controller reported: the login's dates are in its report. */
  reporting: boolean
}) {
  return (
    <Board title="Sign-in" icon="▣" span={6}>
      {!reporting ? (
        <p className={EMPTY}>
          Nothing reported. The login's plan and dates come with the controller's Remote Control
          report.
        </p>
      ) : !credentials.present ? (
        <p className={EMPTY}>
          No credentials file. Nobody has run <span className={MONO}>/login</span> on this box,
          which means Remote Control cannot connect at all.
        </p>
      ) : (
        <>
          <div className={LEFT_FACTS}>
            <Facts
              list
              rows={[
                { k: 'Plan', v: text(credentials.subscription_type) },
                {
                  k: 'Rate limit tier',
                  v: <span className={MONO}>{text(credentials.rate_limit_tier)}</span>,
                },
                {
                  k: 'Access token',
                  v: credentials.expires_at === null ? DASH : <Until at={credentials.expires_at} />,
                },
                {
                  k: 'Refresh token',
                  v:
                    credentials.refresh_expires_at === null ? (
                      DASH
                    ) : (
                      <Until at={credentials.refresh_expires_at} />
                    ),
                },
                {
                  k: 'Scopes',
                  v: (
                    <span className={MONO}>
                      {credentials.scopes.length === 0 ? DASH : credentials.scopes.join(' · ')}
                    </span>
                  ),
                },
              ]}
            />
          </div>
          <p className={FOOT}>
            Two clocks, and only the second is a date to act on. The access token is refreshed
            automatically about once an hour and its expiry is never the problem. The <b>refresh</b>{' '}
            token running out is: Remote Control stops connecting, with no other warning anywhere on
            this box. The fix is manual and takes a minute: SSH in, run{' '}
            <span className={MONO}>claude</span> in the configuration checkout,{' '}
            <span className={MONO}>/login</span>, then the restart control on this page. Neither
            token leaves the credentials file; only the two dates, the plan and the scopes are
            copied out.
          </p>
        </>
      )}
    </Board>
  )
}
