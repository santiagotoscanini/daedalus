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
import type { IdpData } from '../../lib/dashboard/categories/idp'
import { DASH, num } from '../../lib/format'
import { GrafanaLogs, LogDetails } from '../logs'
import { Changelog } from '../release-notes'
import { LinkRow, ServiceHead, verdictOf } from '../service-head'
import { Button } from '../ui/button'
import { Board, BoardGrid, Chip, Columns, Measures } from '../viz'

/** How many registrations the list shows before it is asked for the rest. */
const APPS_SHOWN = 5

/* The board vocabulary styles.css used to carry, as utilities. Restated per
   category file rather than shared: the legacy sheet is being retired file by
   file, so a common module would be a second place to keep in step. */
const MONO = 'font-mono text-[0.86em] [overflow-wrap:anywhere]'
const NOTE = 'text-[0.73rem] text-(--dim)'
const FOOT = 'mt-[0.15rem] text-[0.73rem] leading-[1.45] text-(--dim) [overflow-wrap:anywhere]'
const SUB =
  'mt-[0.35rem] mb-[-0.2rem] text-[0.73rem] tracking-normal text-(--dim) [font-weight:550]'
const EMPTY = 'py-[0.9rem] text-center text-[0.8rem] text-(--dim) [overflow-wrap:anywhere]'

/* A flat list of named things, each led by a chip saying what kind it is and
   trailed by whatever detail that kind has. Rows of a table, not a stack of
   pills: a hairline between rows says the same thing at a fraction of the ink.
   The row rules hang off the list so the <li>s stay bare. */
const LIST =
  'flex list-none flex-col [&>li]:flex [&>li]:min-w-0 [&>li]:items-center [&>li]:gap-[0.45rem] [&>li]:px-[0.1rem] [&>li]:py-[0.34rem] [&>li]:text-[0.77rem] [&>li+li]:border-t [&>li+li]:border-(--border-soft)'
/* The name takes the slack, so the detail is pushed right without a spacer.
   Both truncate: one long row must not widen the panel. */
const MAIN = 'min-w-0 flex-auto truncate text-foreground'
const SIDE = 'max-w-[60%] min-w-0 flex-[0_1_auto] truncate text-[0.68rem] tabular-nums text-(--dim)'
/* An identifier in the side slot keeps the slot's own size — the legacy
   `.mono` sat earlier in the sheet and lost that half of the pair. */
const SIDE_MONO = `${SIDE} font-mono`

/* The ends of a column chart's window. Pulled inside the board body's own gap:
   the axis belongs to the chart above it. */
const COLAXIS =
  'mt-[-0.35rem] flex justify-between gap-[0.6rem] text-[0.66rem] tabular-nums text-(--dim)'

/* The "show all 33" toggle under the registration list, on `Button
   variant="outline"`. Left-aligned with the rows rather than centred: it is
   the continuation of the list, not a footer action. */
const BTN_MORE =
  'mt-[0.35rem] h-auto self-start px-[0.5rem] py-[0.18rem] text-[0.7rem] text-(--text-muted) hover:border-foreground/30'

/* The registration list. Half-width board, so the name column gives before the
   bar does: the bar is the comparison and a 3rem one compares nothing, while a
   truncated name is still recognisable and has its full form on hover. */
const APPS = 'mt-[0.5rem] flex list-none flex-col gap-[0.1rem]'
const APP = '[&[open]>summary]:bg-(--panel-2)'
const APP_SUMMARY =
  'grid cursor-pointer list-none grid-cols-[minmax(6rem,11rem)_minmax(3rem,1fr)_2.2rem_auto] items-center gap-[0.6rem] rounded-[7px] px-[0.45rem] py-[0.3rem] text-[0.78rem] hover:bg-(--panel-2) [&::-webkit-details-marker]:hidden'
/* The `em`s are the same badge the ranking rows wear, so a state that changes
   what the row means reads identically wherever it appears. */
const APP_NAME =
  'flex min-w-0 items-center gap-[0.4rem] text-foreground [&>span:first-child]:truncate [&>em]:flex-none [&>em]:rounded-full [&>em]:border [&>em]:border-warning/40 [&>em]:px-[0.35rem] [&>em]:py-[0.02rem] [&>em]:text-[0.6rem] [&>em]:text-warning [&>em]:not-italic'
const APP_WHEN = 'text-right text-[0.7rem] whitespace-nowrap tabular-nums text-(--dim)'
const APP_BODY = 'flex flex-col gap-[0.35rem] pt-[0.3rem] pr-[0.45rem] pb-[0.7rem] pl-[1.2rem]'

/* The usage bar the ORDER no longer carries. */
const TRACK = 'h-[5px] overflow-hidden rounded-[3px] bg-(--raise)'
const FILL =
  'block h-full origin-left animate-[bar-grow_600ms_cubic-bezier(0.2,0.9,0.2,1)_both] rounded-[3px] bg-info opacity-85 motion-reduce:animate-none'
const COUNT = 'text-right text-[0.79rem] whitespace-nowrap tabular-nums text-foreground'

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
              d.gap.latest === null
                ? 'GitHub did not answer'
                : d.gap.behind.length === 0
                  ? 'this is what is running'
                  : `${String(d.gap.behind.length)} release${d.gap.behind.length === 1 ? '' : 's'} between them`,
          },
          {
            k: 'Pinned by',
            v: null,
            note: 'an exact tag in stacks/pocket-id — it serves no version',
          },
        ]}
        lede={
          <>
            Passkeys only. There is no password on this box to guess, phish or reuse. Every admin UI
            either sits behind it at the proxy or signs in against it directly, so a single
            authentication here is what opens all of them for the day.
          </>
        }
        actions={
          <Button asChild size="sm">
            <a href="https://id.toscanini.me" target="_blank" rel="noreferrer">
              Open Pocket ID ↗
            </a>
          </Button>
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
              {/* This said "duplicate" and blamed a rename. Both were wrong:
                  the pair is declared, and the module that declares it says
                  why. Reading a coincidence as a defect is worse than not
                  noticing it. */}
              <b>{num(shared.length)}</b> registrations answer for one hostname (
              {[...new Set(shared.map((c) => c.host ?? c.name))].join(', ')}), by design rather than
              as a leftover: the proxy gate and the app&rsquo;s own login are different consumers
              with different callbacks, and one client cannot hold both, because the generated one
              would overwrite the hand-written callbacks on every rebuild. Each of the pair says
              which it is. What is lost is attribution: both carry the same display name and the
              audit log records only the name, so one count covers the pair and cannot be split.
            </p>
          )}

          <p className={FOOT}>
            The measures are the value of single sign-on stated as a subtraction:{' '}
            <b>{num(w.signIns)} passkey sign-ins</b> against{' '}
            <b>{num(w.authorizations)} applications opened</b> is{' '}
            {num(w.authorizations - w.signIns)} logins that did not have to happen. The list is
            ordered by when each was last used rather than by volume, so the five above are the
            recent activity and the {num(idle)} nobody opened at all sit at the end of the full one.
            For a proxy-gated app that means nobody visited it, not that the registration is dead.
            Open a row for who went in and from what; the full log is in Pocket ID. A{' '}
            <b>re-consent</b> is not a first use: rewriting a client drops its stored consent, and
            the convergence job rewrites every one of them on every rebuild, so these mark where a
            rebuild made everybody agree again.
            {d.truncated &&
              ' The window is longer than the pages read, so these are a lower bound.'}
          </p>
        </Board>

        <Changelog gap={d.gap} span={6} />

        {/* The join nothing else can make. The convergence job creates and
            updates but never prunes, so nix believes a deleted stack's client
            is gone while the IdP keeps trusting its redirect URIs forever —
            and neither side alone can see the difference. */}
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
              /export/sso.json is not published, so the declared side of the diff is missing and
              nothing here can be called an orphan yet.
            </p>
          ) : d.nix.orphans.length === 0 && d.nix.unsynced.length === 0 ? (
            <p className={EMPTY}>
              Every live client is declared in <span className={MONO}>fleet.ssoClients</span>, and
              every declaration exists at the IdP. Nothing has outlived its stack.
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
            still holds trusted redirect URIs and still accepts logins, and only a hand edit in
            Pocket ID removes it. <b>Not synced</b> is the other direction and usually transient: a
            declaration the convergence job has not pushed yet, or a sync that failed. Its journal
            is in the Logs board below. Matched on the client id, because the nix attr name IS the
            OIDC <span className={MONO}>client_id</span>.
          </p>
        </Board>

        <Board title="Who" icon="◑" span={3}>
          <ul className={LIST}>
            {d.users.map((u) => (
              <li key={u.username} title={u.groups.join(', ')}>
                <span className={MAIN}>
                  {u.displayName}
                  {u.admin && <span className="text-(--text-muted)"> · admin</span>}
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

          {/* Grouped, not listed: a passkey belongs to a device, so this is
              the inventory of things that can authenticate as somebody. The
              raw stream of when each one did is a log, and Pocket ID's own
              audit page is the place for that. */}
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
            A group is what an application restricts itself to, so an empty one is an application
            nobody can reach through it. A passkey belongs to a device, so the devices are the
            credentials. One you do not recognise is the thing to notice here. Sign-ups are{' '}
            <b>{d.signups ?? 'unknown'}</b>, read back from the IdP rather than restated here.
          </p>
        </Board>

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
                A systemd oneshot on the host, so these are journal lines rather than container
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
              <p className={FOOT}>
                The other host oneshot from the same file, and the one that runs first. It generates
                a client secret per <code>fleet.ssoClients</code> entry into a gitignored file on
                disk, so the credential never enters the nix store. That is also why it cannot be a
                container: it writes host state the IdP is then told about. An app that suddenly
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
      <h4 className={SUB}>{all ? 'Every registration' : `Last ${String(APPS_SHOWN)} used`}</h4>
      <ul className={APPS}>
        {shown.map((c) => (
          <AppRow key={c.id} c={c} max={max} />
        ))}
      </ul>
      {rest > 0 && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={BTN_MORE}
          onClick={() => {
            setAll(!all)
          }}
        >
          {all ? 'Show fewer' : `Show all ${String(clients.length)}`}
        </Button>
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
      <details className={APP}>
        <summary className={APP_SUMMARY}>
          <span className={APP_NAME}>
            <span title={c.host ?? c.name}>{c.name}</span>
            {!c.restricted && <em title="Open to every account, not a named group">any account</em>}
            {/* Which of a hostname's registrations this one is. Not a fault
                badge — see the note on `role`. The legacy `is-muted` marker it
                used to carry never resolved here (the rule for it is scoped to
                `.rank-name`), so it is still drawn as one. */}
            {c.role !== null && (
              <em
                title={
                  c.role === 'gate'
                    ? 'The credential traefik’s forward-auth middleware signs in with, before the request reaches the app'
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
          <span className={idle ? `${TRACK} opacity-25` : TRACK}>
            {!idle && (
              <span
                className={FILL}
                style={{ width: `${String(Math.max(1.5, (c.used / max) * 100))}%` }}
              />
            )}
          </span>
          <span className={COUNT}>{idle ? DASH : num(c.used)}</span>
          <span className={APP_WHEN}>{c.lastAgo ?? 'not in the window'}</span>
        </summary>

        <div className={APP_BODY}>
          {c.opens.length === 0 ? (
            <p className={EMPTY}>
              Nobody opened this in the window. For an app behind the proxy gate that means nobody
              visited it. The registration is what the middleware itself signs in with.
            </p>
          ) : (
            <ul className={LIST}>
              {c.opens.map((o) => (
                <li key={o.id}>
                  {/* Not "first time": the event recurs, and an access older
                      than it sitting below it is what gave that away. */}
                  {o.consent && (
                    <Chip tone="info">
                      <span title="A consent record was created here rather than reused. Pocket ID drops the stored one whenever the client is rewritten, which every rebuild does">
                        re-consented
                      </span>
                    </Chip>
                  )}
                  <span className={MAIN}>{o.username}</span>
                  <span className={SIDE}>{o.device}</span>
                  <span className={SIDE}>{o.ago}</span>
                </li>
              ))}
            </ul>
          )}
          {c.used > c.opens.length && (
            <p className={FOOT}>
              The {num(c.opens.length)} most recent of {num(c.used)}. The rest are in Pocket ID.
            </p>
          )}
        </div>
      </details>
    </li>
  )
}
