// The Sign-in board: the login this server connects with, and the one date on
// it worth acting on.
import type { ClaudeFacts } from '../../lib/dashboard/claude'
import { DASH, text, until } from '../../lib/format'
import { EMPTY, FOOT, MONO } from '../tokens'
import { Board, Facts } from '../viz'

export function SignInBoard({
  credentials,
  refreshIn,
}: {
  credentials: ClaudeFacts['credentials']
  /** Seconds until the refresh token runs out, or null with no credentials. */
  refreshIn: number | null
}) {
  return (
    <Board title="Sign-in" icon="▣" span={6}>
      {!credentials.present ? (
        <p className={EMPTY}>
          No credentials file. Nobody has run <span className={MONO}>/login</span> on this box,
          which means Remote Control cannot connect at all.
        </p>
      ) : (
        <>
          <Facts
            list
            rows={[
              { k: 'Plan', v: text(credentials.subscriptionType) },
              {
                k: 'Rate limit tier',
                v: <span className={MONO}>{text(credentials.rateLimitTier)}</span>,
              },
              {
                k: 'Access token',
                v:
                  credentials.expiresAt === null
                    ? DASH
                    : until((credentials.expiresAt - Date.now()) / 1000),
              },
              { k: 'Refresh token', v: refreshIn === null ? DASH : until(refreshIn) },
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
          <p className={FOOT}>
            Two clocks, and only the second is a date to act on. The access token is refreshed
            automatically about once an hour and its expiry is never the problem. The <b>refresh</b>{' '}
            token running out is: Remote Control stops connecting, with no other warning anywhere on
            this box. The fix is manual and takes a minute: SSH in, run{' '}
            <span className={MONO}>claude</span> in the configuration checkout,{' '}
            <span className={MONO}>/login</span>, then the restart control on this page. Neither
            token is in the snapshot this page reads; only the two dates and the plan are copied
            out.
          </p>
        </>
      )}
    </Board>
  )
}
