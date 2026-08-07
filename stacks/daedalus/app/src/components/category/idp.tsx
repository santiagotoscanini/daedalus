// Home › Sign-in: Pocket ID.
//
// Its own file rather than a section of home.tsx because it is the longest of
// that category's tabs by a wide margin — the audit log carries a list of
// registrations, a list of people, a list of devices and a drill-down behind
// every row — and folding it in would bury seven short tabs under one long
// one.
//
// It was a category of its own until now, and before that the second half of
// the proxy's page. The argument that split it from traefik still holds: that
// is infrastructure with a release cycle, this is the account every person in
// the house signs in with. What it is NOT is a subject of its own — beside the
// automation, the photos and the files it is plainly one of the household's
// things, and the join it keeps with the proxy is one column on a table about
// routing.

import { useState } from 'react'

import { Board, BoardGrid, Chip, Columns, Measures } from '../viz'
import { Changelog } from '../release-notes'
import { LinkRow, ServiceHead, verdictOf } from '../service-head'
import { GrafanaLogs, LogDetails } from '../logs'
import { DASH, num } from '../../lib/dashboard/format'
import type { IdpData } from '../../lib/dashboard/idp'

/** How many registrations the list shows before it is asked for the rest. */
const APPS_SHOWN = 5

/**
 * Pocket ID: who can get in, and who did.
 *
 * The audit log is the panel. It is the only record on this box of a person
 * signing in — traefik sees a 302 to the IdP and a 200 afterwards and cannot
 * tell you which human that was — and it is also the only way to find out
 * which of the registered applications anybody actually uses.
 */
export function IdpView({ d }: { d: IdpData }) {
  const { window: w } = d
  const shared = d.clients.filter((c) => c.sharesHost)
  const idle = d.clients.filter((c) => c.used === 0).length
  // The bar's scale. Not the list's order — see the note on the loader.
  const max = Math.max(...d.clients.map((c) => c.used), 1)

  return (
    <>
      <ServiceHead
        logo="/icon-pocket-id.svg"
        name="Pocket ID"
        version={d.version}
        versionNote="pinned in the flake"
        verdict={verdictOf(d.gap)}
        compare={[
          {
            k: 'Latest',
            v: d.gap.latest,
            note:
              d.gap.latest === null ? 'GitHub did not answer'
              : d.gap.behind.length === 0 ? 'this is what is running'
              : `${String(d.gap.behind.length)} release${d.gap.behind.length === 1 ? '' : 's'} between them`,
          },
          { k: 'Pinned by', v: null, note: 'an exact tag in stacks/pocket-id — it serves no version' },
        ]}
        lede={
          <>
            Passkeys only — there is no password on this box to guess, phish or reuse. Every admin
            UI either sits behind it at the proxy or signs in against it directly, so a single
            authentication here is what opens all of them for the day.
          </>
        }
        actions={
          <a
            className="btn btn-primary"
            href="https://id.toscanini.me"
            target="_blank"
            rel="noreferrer"
          >
            Open Pocket ID ↗
          </a>
        }
      />
      <LinkRow
        links={[
          { label: 'Docs', href: 'https://pocket-id.org/docs/introduction' },
          { label: 'GitHub', href: 'https://github.com/pocket-id/pocket-id' },
        ]}
      />

      <BoardGrid>
        {/* One board, not two. "Signing in" and "Applications" were the same
            audit log read twice — the chronological copy and the aggregate —
            and on a box where the control plane re-authorises on a timer, the
            chronological one spent ten of its twelve rows saying "opened
            Daedalus". What survives the merge is the half no aggregate covers:
            a credential actually being presented, and from what. */}
        <Board
          title="Signing in"
          icon="⚿"
          span={6}
          aside={
            <span className="board-note">
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
            <p className="colaxis">
              <span>{d.daily[0]?.date.slice(5)}</span>
              <span>applications opened per day</span>
              <span>{d.daily[d.daily.length - 1]?.date.slice(5)}</span>
            </p>
          )}

          <AppList clients={d.clients} max={max} />

          {shared.length > 0 && (
            <p className="board-foot">
              {/* This said "duplicate" and blamed a rename. Both were wrong:
                  the pair is declared, and the module that declares it says
                  why. Reading a coincidence as a defect is worse than not
                  noticing it. */}
              <b>{num(shared.length)}</b> registrations answer for one hostname —{' '}
              {[...new Set(shared.map((c) => c.host ?? c.name))].join(', ')} — and that is a design
              rather than a leftover: the proxy gate and the app&rsquo;s own login are different
              consumers with different callbacks, and one client cannot hold both, because the
              generated one would overwrite the hand-written callbacks on every rebuild. Each of the
              pair says which it is. What is genuinely lost is attribution — both carry the same
              display name and the audit log records only the name, so one count covers the pair and
              cannot be split.
            </p>
          )}

          <p className="board-foot">
            The measures are the value of single sign-on stated as a subtraction:{' '}
            <b>{num(w.signIns)} passkey sign-ins</b> against{' '}
            <b>{num(w.authorizations)} applications opened</b> is{' '}
            {num(w.authorizations - w.signIns)} logins that did not have to happen. The list is
            ordered by when each was last used rather than by volume, so the five above are the
            recent activity and the {num(idle)} nobody opened at all sit at the end of the full one
            — which for a proxy-gated app means nobody visited it, not that the registration is
            dead. Open a row for who went in and from what; the full log is in Pocket ID. A{' '}
            <b>re-consent</b> is not a first use:
            rewriting a client drops its stored consent, and the convergence job rewrites every one
            of them on every rebuild, so these mark where a rebuild made everybody agree again.
            {d.truncated && ' The window is longer than the pages read, so these are a lower bound.'}
          </p>
        </Board>

        <Changelog gap={d.gap} span={6} />

        <Board title="Who" icon="◑" span={3}>
          <ul className="itemlist">
            {d.users.map((u) => (
              <li key={u.username} title={u.groups.join(', ')}>
                <span className="item-main">
                  {u.displayName}
                  {u.admin && <span className="muted"> · admin</span>}
                </span>
                {u.disabled && <Chip tone="bad">disabled</Chip>}
                {/* An admin account that is not a person, and the only place
                    on this dashboard it is visible at all. */}
                {u.service && (
                  <Chip tone="muted">
                    <span title="The principal behind STATIC_API_KEY — how daedalus reads this page">
                      api key
                    </span>
                  </Chip>
                )}
                <span className="item-side">
                  {u.service ? 'never signs in' : (u.lastSignInAgo ?? 'not in the window')}
                </span>
              </li>
            ))}
          </ul>

          <h4 className="board-sub">Groups</h4>
          <ul className="itemlist">
            {d.groups.map((g) => (
              <li key={g.name}>
                <span className="item-main">{g.name}</span>
                <span className="item-side">
                  {g.members === 0 ? 'nobody in it' : `${String(g.members)} member${g.members === 1 ? '' : 's'}`}
                </span>
              </li>
            ))}
          </ul>

          {/* Grouped, not listed: a passkey belongs to a device, so this is
              the inventory of things that can authenticate as somebody. The
              raw stream of when each one did is a log, and Pocket ID's own
              audit page is the place for that. */}
          <h4 className="board-sub">Devices that signed in</h4>
          {d.devices.length === 0 ?
            <p className="viz-empty">nobody signed in during the window</p>
          : <ul className="itemlist">
              {d.devices.map((v) => (
                <li key={v.name}>
                  <span className="item-main" title={v.name}>
                    {v.name}
                  </span>
                  <span className="item-side">{v.lastAgo}</span>
                  <span className="item-n">{num(v.signIns)}</span>
                </li>
              ))}
            </ul>
          }

          {/* A quarter of the width, so this says the things that change what
              the three lists above mean, and stops. */}
          <p className="board-foot">
            A group is what an application restricts itself to, so an empty one is an application
            nobody can reach through it. A passkey belongs to a device, so the devices are the
            credentials — one appearing that you do not recognise is the thing to notice here.
            Sign-ups are <b>{d.signups ?? 'unknown'}</b>, read back from the IdP rather than
            restated here.
          </p>
        </Board>

        <Board title="Logs" icon="≡" span={9}>
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
              <p className="board-foot">
                A systemd oneshot on the host, not a container — journal lines rather than container
                logs. Defined in <code>stacks/pocket-id/clients.nix</code>, ordered after the IdP,
                and run on every rebuild: it upserts one OIDC client per{' '}
                <code>fleet.ssoClients</code> entry — name, redirect URIs, allowed groups — with a
                full PUT of the body whether or not anything changed, which is what drops everyone’s
                stored consent. It creates and updates; it never deletes.
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
              <p className="board-foot">
                The other host oneshot from the same file, and the one that runs first. It generates
                a client secret per <code>fleet.ssoClients</code> entry into a gitignored file on
                disk, so the credential never enters the nix store — which is also why it cannot be
                a container: it writes host state the IdP is then told about. An app that suddenly
                cannot complete a login, having been fine, is usually this having handed it a secret
                the IdP no longer holds.
              </p>
            }
          />
        </Board>
      </BoardGrid>
    </>
  )
}

/**
 * The registration list, five deep until asked.
 *
 * Thirty-three rows is the whole answer to "which of these is still in use"
 * and about a screen and a half of it, most of which is the tail nobody
 * looks at. Five is the part that changes — the list is ordered by recency,
 * so the top of it IS the recent activity — and the rest is one click away
 * for the times the question is about the tail.
 */
function AppList({ clients, max }: { clients: IdpData['clients']; max: number }) {
  const [all, setAll] = useState(false)
  const shown = all ? clients : clients.slice(0, APPS_SHOWN)
  const rest = clients.length - APPS_SHOWN

  return (
    <>
      <h4 className="board-sub">
        {all ? 'Every registration' : `Last ${String(APPS_SHOWN)} used`}
      </h4>
      <ul className="idp-apps">
        {shown.map((c) => (
          <AppRow key={c.id} c={c} max={max} />
        ))}
      </ul>
      {rest > 0 && (
        <button
          type="button"
          className="btn btn-ghost idp-more"
          onClick={() => {
            setAll(!all)
          }}
        >
          {all ? 'Show fewer' : `Show all ${String(clients.length)}`}
        </button>
      )}
    </>
  )
}

/**
 * One registered application, with its accesses folded behind it.
 *
 * A `<details>` rather than two panels, because the two questions are nested
 * rather than parallel: "which of these is still in use" is asked of the whole
 * list at a glance, and "who went into THAT one, from what" is asked of one
 * row you are already looking at. Side by side, the second one was a column of
 * near-identical lines that read as a log — and this page is not trying to be
 * one. Pocket ID's own audit page is.
 *
 * A never-opened registration still gets a row, and still opens: it says so,
 * which is the answer.
 */
function AppRow({ c, max }: { c: IdpData['clients'][number]; max: number }) {
  const idle = c.used === 0

  return (
    <li>
      <details className="idp-app">
        <summary>
          <span className="idp-app-name">
            <span title={c.host ?? c.name}>{c.name}</span>
            {!c.restricted && <em title="Open to every account, not a named group">any account</em>}
            {/* Which of a hostname's registrations this one is. Not a fault
                badge — see the note on `role`. */}
            {c.role !== null && (
              <em
                className="is-muted"
                title={
                  c.role === 'gate' ?
                    'The credential traefik’s forward-auth middleware signs in with, before the request reaches the app at all'
                  : 'The credential the app itself runs its own login with'
                }
              >
                {c.role === 'gate' ? 'proxy gate' : 'app login'}
              </em>
            )}
          </span>
          {/* The bar carries the magnitude the ORDER no longer does. Muted
              for a row with nothing in it, so the tail of the list reads as
              a tail rather than as forty empty tracks. */}
          <span className={idle ? 'rank-track is-idle' : 'rank-track'}>
            {!idle && (
              <span
                className="rank-fill"
                style={{ width: `${String(Math.max(1.5, (c.used / max) * 100))}%` }}
              />
            )}
          </span>
          <span className="rank-n">{idle ? DASH : num(c.used)}</span>
          <span className="idp-app-when">{c.lastAgo ?? 'not in the window'}</span>
        </summary>

        <div className="idp-app-body">
          {c.opens.length === 0 ?
            <p className="viz-empty">
              Nobody opened this in the window. For an app behind the proxy gate that means nobody
              visited it — the registration is what the middleware itself signs in with.
            </p>
          : <ul className="itemlist">
              {c.opens.map((o) => (
                <li key={o.id}>
                  {/* Not "first time": the event recurs, and an access older
                      than it sitting below it is what gave that away. */}
                  {o.consent && (
                    <Chip tone="info">
                      <span title="A consent record was created here rather than reused — Pocket ID drops the stored one whenever the client is rewritten, which every rebuild does">
                        re-consented
                      </span>
                    </Chip>
                  )}
                  <span className="item-main">{o.username}</span>
                  <span className="item-side">{o.device}</span>
                  <span className="item-side">{o.ago}</span>
                </li>
              ))}
            </ul>
          }
          {c.used > c.opens.length && (
            <p className="board-foot">
              The {num(c.opens.length)} most recent of {num(c.used)}. The rest are in Pocket ID.
            </p>
          )}
        </div>
      </details>
    </li>
  )
}
