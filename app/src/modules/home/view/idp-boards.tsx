// Home › Sign-in's boards: signing in, the applications, declared against
// live, the logs. Who and the devices are in ./idp-who.tsx.

import { GrafanaLogs, LogDetails } from '../../../components/logs'
import { BOARD_TABLE, BOARD_TABLE_HEAD, BOARD_TABLE_ROW } from '../../../components/modules/parts'
import { CELL_MONO, CELL_NAME, CELL_QUIET } from '../../../components/table'
import { AXIS, CAPTION, EMPTY, FOOT, MONO, NOTE } from '../../../components/tokens'
import { Board, Chip, Columns, Measures } from '../../../components/viz'
import { cn } from '../../../lib/cn'
import { num } from '../../../lib/format'
import type { IdpData } from '../data/signin'
import { AppList } from './idp-apps'

export function SigningInBoard({ d, w }: { d: IdpData; w: IdpData['window'] }) {
  return (
    <Board
      title="Signing in"
      icon="key"
      span={8}
      aside={<span className={NOTE}>last {w.days} days</span>}
    >
      <Measures
        items={[
          { k: 'Passkey sign-ins', v: num(w.signIns) },
          { k: 'Apps opened', v: num(w.authorizations) },
          { k: 'Re-consents', v: num(w.consents) },
          { k: 'People', v: num(w.people) },
        ]}
      />

      <Columns
        points={d.daily.map((p) => ({
          label: p.date.slice(5),
          value: p.authorizations,
          display: `${num(p.authorizations)} app${p.authorizations === 1 ? '' : 's'} opened`,
        }))}
        tone="ok"
        height={120}
        empty="nothing in the window"
      />
      {d.daily.length > 0 && (
        <p className={AXIS}>
          <span>{d.daily[0]?.date.slice(5)}</span>
          <span>applications opened per day</span>
          <span>{d.daily[d.daily.length - 1]?.date.slice(5)}</span>
        </p>
      )}

      <p className={FOOT}>
        The measures are the value of single sign-on stated as a subtraction:{' '}
        <b>{num(w.signIns)} passkey sign-ins</b> against{' '}
        <b>{num(w.authorizations)} applications opened</b> is {num(w.authorizations - w.signIns)}{' '}
        logins that did not have to happen. A <b>re-consent</b> is not a first use: rewriting a
        client drops its stored consent, and the convergence job rewrites every one of them on every
        rebuild, so these mark where a rebuild made everybody agree again.
      </p>
      {d.truncated && (
        <p className={CAPTION}>
          The window is longer than the pages read, so these are a lower bound.
        </p>
      )}
    </Board>
  )
}

/**
 * The registrations, as a table. One board, not a chronological sign-in list
 * beside the per-app aggregate: both are the same audit log, and a
 * chronological list fills with whatever re-authorises on a timer. The
 * per-row drill-down keeps the part an aggregate loses — who, from what.
 */
export function AppsBoard({
  d,
  shared,
  idle,
  max,
}: {
  d: IdpData
  shared: IdpData['clients']
  idle: number
  max: number
}) {
  return (
    <Board
      title="Applications"
      icon="rows"
      span={12}
      aside={
        <span className={NOTE}>
          {d.clients.length} registered · {num(idle)} not opened in {d.window.days} days
        </span>
      }
    >
      <AppList clients={d.clients} max={max} />

      {shared.length > 0 && (
        <>
          {/* A declared pair, not a duplicate — see `role` in data/signin.ts. The
              count and the hostnames are a reading; why they pair folds. */}
          <p className={CAPTION}>
            <b>{num(shared.length)}</b> registrations answer for one hostname (
            {[...new Set(shared.map((c) => c.host ?? c.name))].join(', ')}).
          </p>
          <p className={FOOT}>
            By design rather than as a leftover: the proxy gate and the app&rsquo;s own login are
            different consumers with different callbacks, and one client cannot hold both, because
            the generated one would overwrite the hand-written callbacks on every rebuild. Each of
            the pair says which it is. What is lost is attribution: both carry the same display name
            and the audit log records only the name, so one count covers the pair and cannot be
            split.
          </p>
        </>
      )}

      <p className={FOOT}>
        The table is ordered by when each was last used rather than by volume, so the five above are
        the recent activity and the {num(idle)} nobody opened at all sit at the end of the full one.
        For a proxy-gated app that means nobody visited it, not that the registration is dead. Open
        a row for who went in and from what; the full log is in Pocket ID.
      </p>
    </Board>
  )
}

/* Declared against live: what the row is, which client, its id, what that means. */
const DECLARED_GRID = cn(
  'grid items-center gap-x-6 px-5',
  'grid-cols-[6.5rem_minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,1.2fr)]',
  '@max-[44rem]/table:grid-cols-[6.5rem_minmax(0,1fr)_minmax(0,1.2fr)]',
)
const HIDE_NARROW = '@max-[44rem]/table:hidden'

export function DeclaredBoard({ d }: { d: IdpData }) {
  const rows = [
    ...d.nix.orphans.map((c) => ({
      ...c,
      state: 'orphan',
      what: 'live at the IdP, declared nowhere',
    })),
    ...d.nix.unsynced.map((c) => ({
      ...c,
      state: 'not synced',
      what: 'declared, absent at the IdP',
    })),
  ]
  return (
    <Board
      title={rows.length === 0 ? 'Declared and live agree' : 'Declared vs live'}
      icon="▣"
      span={8}
      aside={
        <span className={NOTE}>
          {num(d.nix.declared)} declared in nix · {num(d.clients.length)} live at the IdP
        </span>
      }
    >
      {!d.nix.available ? (
        <p className={EMPTY}>
          /export/sso.json is not published, so the declared side of the diff is missing and nothing
          here can be called an orphan yet.
        </p>
      ) : rows.length === 0 ? (
        <p className={EMPTY}>
          Every live client is declared in <span className={MONO}>fleet.ssoClients</span>, and every
          declaration exists at the IdP. Nothing has outlived its stack.
        </p>
      ) : (
        <ul className={BOARD_TABLE}>
          <li className={cn(DECLARED_GRID, BOARD_TABLE_HEAD)}>
            <span>State</span>
            <span>Client</span>
            <span className={HIDE_NARROW}>Client id</span>
            <span>Meaning</span>
          </li>
          {rows.map((c) => (
            <li key={c.id} className={cn(DECLARED_GRID, BOARD_TABLE_ROW)}>
              <span>
                <Chip tone="warn">{c.state}</Chip>
              </span>
              <span className={CELL_NAME}>{c.name}</span>
              <span className={cn(CELL_MONO, HIDE_NARROW)} title={c.id}>
                {c.id}
              </span>
              <span className={cn(CELL_QUIET, 'truncate')}>{c.what}</span>
            </li>
          ))}
        </ul>
      )}
      <p className={FOOT}>
        <span className={MONO}>pocket-id-clients.service</span> converges every{' '}
        <span className={MONO}>fleet.ssoClients</span> entry on each rebuild but{' '}
        <b>never deletes</b>, so an <b>orphan</b> is a client whose declaring stack is gone. It
        still holds trusted redirect URIs and still accepts logins, and only a hand edit in Pocket
        ID removes it. <b>Not synced</b> is the other direction and usually transient: a declaration
        the convergence job has not pushed yet, or a sync that failed. Its journal is in the Logs
        board below. Matched on the client id, because the nix attr name IS the OIDC{' '}
        <span className={MONO}>client_id</span>.
      </p>
    </Board>
  )
}

export function LogsBoard() {
  return (
    <Board title="Logs" icon="logs" span={12}>
      <GrafanaLogs source={{ container: 'pocket-id' }} title="Pocket ID logs" />
      {/* The two units that WRITE the client list above. Neither is a
          container and neither has anywhere else on this dashboard to be
          read, which is the bar — and when a redirect URI is wrong after a
          rebuild, this is the log that says why. */}
      <LogDetails
        summary={
          <>
            <code>pocket-id-clients.service</code> — what put the applications there
          </>
        }
        source={{ unit: 'pocket-id-clients.service' }}
        title="pocket-id-clients"
        foot={
          <p className={FOOT}>
            A systemd oneshot on the host, so these are journal lines rather than container logs.
            Defined in <code>stacks/pocket-id/clients.nix</code>, ordered after the IdP, and run on
            every rebuild: it upserts one OIDC client per <code>fleet.ssoClients</code> entry —
            name, redirect URIs, allowed groups — with a full PUT of the body whether or not
            anything changed, which is what drops everyone’s stored consent. It creates and updates;
            it never deletes.
          </p>
        }
      />
      <LogDetails
        summary={
          <>
            <code>sso-client-secrets.service</code> — where each app’s credential comes from
          </>
        }
        source={{ unit: 'sso-client-secrets.service' }}
        title="sso-client-secrets"
        foot={
          <p className={FOOT}>
            The other host oneshot from the same file, and the one that runs first. It generates a
            client secret per <code>fleet.ssoClients</code> entry into a gitignored file on disk, so
            the credential never enters the nix store. That is also why it cannot be a container: it
            writes host state the IdP is then told about. An app that suddenly cannot complete a
            login, having been fine, is usually this having handed it a secret the IdP no longer
            holds.
          </p>
        }
      />
    </Board>
  )
}
