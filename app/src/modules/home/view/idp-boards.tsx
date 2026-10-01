// Home › Sign-in's boards: signing in, declared against live, who, the logs.

import { GrafanaLogs, LogDetails } from '../../../components/logs'
import { EMPTY, FOOT, MONO, NOTE, SUB } from '../../../components/tokens'
import { Board, Chip, Columns, Measures } from '../../../components/viz'
import { num } from '../../../lib/format'
import type { IdpData } from '../data/signin'
import { AppList, COUNT } from './idp-apps'
import { LIST, MAIN, SIDE } from './shared'

/* An identifier in the side slot: the slot's own size, in monospace. */
const SIDE_MONO = `${SIDE} font-mono`

/* The ends of a column chart's window. Pulled inside the board body's own gap:
   the axis belongs to the chart above it. */
const COLAXIS =
  'mt-[-0.35rem] flex justify-between gap-[0.6rem] text-[0.66rem] tabular-nums text-muted-foreground'

export function SigningInBoard({
  d,
  w,
  shared,
  idle,
  max,
}: {
  d: IdpData
  w: IdpData['window']
  shared: IdpData['clients']
  idle: number
  max: number
}) {
  return (
    <Board
      title="Signing in"
      icon="key"
      span={6}
      aside={
        <span className={NOTE}>
          {w.days} days · {d.clients.length} applications registered
        </span>
      }
    >
      <Measures
        items={[
          { k: 'passkey sign-ins', v: num(w.signIns) },
          { k: 'apps opened', v: num(w.authorizations) },
          { k: 're-consents', v: num(w.consents) },
          { k: 'people', v: num(w.people) },
        ]}
      />

      <Columns
        points={d.daily.map((p) => ({
          label: p.date.slice(5),
          value: p.authorizations,
          display: `${num(p.authorizations)} app${p.authorizations === 1 ? '' : 's'} opened`,
        }))}
        tone="ok"
        height={100}
        empty="nothing in the window"
      />
      {d.daily.length > 0 && (
        <p className={COLAXIS}>
          <span>{d.daily[0]?.date.slice(5)}</span>
          <span>applications opened per day</span>
          <span>{d.daily[d.daily.length - 1]?.date.slice(5)}</span>
        </p>
      )}

      <AppList clients={d.clients} max={max} />

      {shared.length > 0 && (
        <p className={FOOT}>
          {/* A declared pair, not a duplicate — see `role` in data/signin.ts. */}
          <b>{num(shared.length)}</b> registrations answer for one hostname (
          {[...new Set(shared.map((c) => c.host ?? c.name))].join(', ')}), by design rather than as
          a leftover: the proxy gate and the app&rsquo;s own login are different consumers with
          different callbacks, and one client cannot hold both, because the generated one would
          overwrite the hand-written callbacks on every rebuild. Each of the pair says which it is.
          What is lost is attribution: both carry the same display name and the audit log records
          only the name, so one count covers the pair and cannot be split.
        </p>
      )}

      <p className={FOOT}>
        The measures are the value of single sign-on stated as a subtraction:{' '}
        <b>{num(w.signIns)} passkey sign-ins</b> against{' '}
        <b>{num(w.authorizations)} applications opened</b> is {num(w.authorizations - w.signIns)}{' '}
        logins that did not have to happen. The list is ordered by when each was last used rather
        than by volume, so the five above are the recent activity and the {num(idle)} nobody opened
        at all sit at the end of the full one. For a proxy-gated app that means nobody visited it,
        not that the registration is dead. Open a row for who went in and from what; the full log is
        in Pocket ID. A <b>re-consent</b> is not a first use: rewriting a client drops its stored
        consent, and the convergence job rewrites every one of them on every rebuild, so these mark
        where a rebuild made everybody agree again.
        {d.truncated && ' The window is longer than the pages read, so these are a lower bound.'}
      </p>
    </Board>
  )
}

export function DeclaredBoard({ d }: { d: IdpData }) {
  return (
    <Board
      title={
        d.nix.orphans.length === 0 && d.nix.unsynced.length === 0
          ? 'Declared and live agree'
          : 'Declared vs live'
      }
      icon="▣"
      span={12}
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
      ) : d.nix.orphans.length === 0 && d.nix.unsynced.length === 0 ? (
        <p className={EMPTY}>
          Every live client is declared in <span className={MONO}>fleet.ssoClients</span>, and every
          declaration exists at the IdP. Nothing has outlived its stack.
        </p>
      ) : (
        <ul className={LIST}>
          {d.nix.orphans.map((c) => (
            <li key={c.id}>
              <Chip tone="warn">orphan</Chip>
              <span className={MAIN}>{c.name}</span>
              <span className={SIDE_MONO}>{c.id}</span>
              <span className={SIDE}>live at the IdP, declared nowhere</span>
            </li>
          ))}
          {d.nix.unsynced.map((c) => (
            <li key={c.id}>
              <Chip tone="warn">not synced</Chip>
              <span className={MAIN}>{c.name}</span>
              <span className={SIDE_MONO}>{c.id}</span>
              <span className={SIDE}>declared, absent at the IdP</span>
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

export function WhoBoard({ d }: { d: IdpData }) {
  return (
    <Board title="Who" icon="◑" span={3}>
      <ul className={LIST}>
        {d.users.map((u) => (
          <li key={u.username} title={u.groups.join(', ')}>
            <span className={MAIN}>
              {u.displayName}
              {u.admin && <span className="text-subdued"> · admin</span>}
            </span>
            {u.disabled && <Chip tone="bad">disabled</Chip>}
            {/* An admin account that is not a person, and the only place
                on this dashboard it is visible at all. */}
            {u.service && (
              <Chip tone="muted">
                <span title="The principal behind STATIC_API_KEY, how daedalus reads this page">
                  api key
                </span>
              </Chip>
            )}
            <span className={SIDE}>
              {u.service ? 'never signs in' : (u.lastSignInAgo ?? 'not in the window')}
            </span>
          </li>
        ))}
      </ul>

      <h4 className={SUB}>Groups</h4>
      <ul className={LIST}>
        {d.groups.map((g) => (
          <li key={g.name}>
            <span className={MAIN}>{g.name}</span>
            <span className={SIDE}>
              {g.members === 0
                ? 'nobody in it'
                : `${String(g.members)} member${g.members === 1 ? '' : 's'}`}
            </span>
          </li>
        ))}
      </ul>

      {/* Grouped, not listed — see `IdpData['devices']`. */}
      <h4 className={SUB}>Devices that signed in</h4>
      {d.devices.length === 0 ? (
        <p className={EMPTY}>nobody signed in during the window</p>
      ) : (
        <ul className={LIST}>
          {d.devices.map((v) => (
            <li key={v.name}>
              <span className={MAIN} title={v.name}>
                {v.name}
              </span>
              <span className={SIDE}>{v.lastAgo}</span>
              <span className={COUNT}>{num(v.signIns)}</span>
            </li>
          ))}
        </ul>
      )}

      {/* A quarter of the width, so this says the things that change what
          the three lists above mean, and stops. */}
      <p className={FOOT}>
        A group is what an application restricts itself to, so an empty one is an application nobody
        can reach through it. A passkey belongs to a device, so the devices are the credentials. One
        you do not recognise is the thing to notice here. Sign-ups are{' '}
        <b>{d.signups ?? 'unknown'}</b>, read back from the IdP rather than restated here.
      </p>
    </Board>
  )
}

export function LogsBoard() {
  return (
    <Board title="Logs" icon="logs" span={9}>
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
