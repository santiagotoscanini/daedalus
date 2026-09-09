import { useState } from 'react'
import { cn } from '../../../lib/cn'
import type { NetworkData } from '../../../lib/dashboard/categories/network'
import { bytes, compact, DASH, ms, num, pct, since, until } from '../../../lib/format'
import { Segmented } from '../../controls'
import { LogBoard } from '../../logs'
import { Changelog } from '../../release-notes'
import { LinkRow, ServiceHead, verdictOf } from '../../service-head'
import type { Tone } from '../../viz'
import { BarList, Board, BoardGrid, Chip, Columns, Facts, Measures, Progress } from '../../viz'
import {
  ACTION,
  EMPTY,
  FOOT,
  GROUP,
  MAIN,
  MONO,
  N,
  NOTE,
  ROW,
  ROWS,
  SIDE,
  SUB,
  SWITCH_BAR,
  tone,
} from './shared'

// ── DNS ────────────────────────────────────────────────────────────────

type Dns = Extract<NetworkData, { tab: 'dns' }>

/* Consecutive folds get air between them, and only consecutive ones: a fold
   that follows a table of facts already has the board body's own gap. The
   marker attribute is what makes "the one before me is a fold" expressible. */
const FOLD_STACK = '[[data-fold]+&]:mt-[0.5rem]'

/**
 * How a name becomes an address, on both sides of the front door.
 *
 * Two halves of one sentence rather than two subjects: pi-hole answers
 * everything asked from inside the house, the toscanini.me zone answers
 * everything asked from outside it, and neither is legible alone. The zone
 * cannot explain why a name works on the sofa and not on mobile data; the
 * resolver cannot explain what the internet is told. The tables on both sides
 * are joined on the same list of published names.
 */
export function DnsView({ data }: { data: Dns }) {
  const [side, setSide] = useState<'resolver' | 'zone'>('resolver')
  const { resolver, zone } = data

  return (
    <>
      <div className={SWITCH_BAR}>
        <Segmented
          value={side}
          onChange={setSide}
          label="Resolver or zone"
          options={[
            { value: 'resolver', label: 'Resolver', dot: tone(resolver.queries.total !== null) },
            {
              value: 'zone',
              label: zone.domain,
              // Whether the zone could be READ, which is all this dot can
              // honestly claim. A zone does not go down — Cloudflare serves it
              // from their edge and this box is not in that path at all.
              dot: tone(zone.cf.records !== null),
            },
          ]}
        />
      </div>

      {side === 'zone' ? (
        <ZoneView d={zone} />
      ) : (
        <ResolverView d={resolver} lan={data.lan} admin={data.admin} />
      )}
    </>
  )
}

// ── DNS: the resolver ──────────────────────────────────────────────────

/** The four ways a query ends, in the order they are tried. */
const SOURCES = [
  { k: 'cached' as const, label: 'From cache', tone: 'ok' as Tone },
  { k: 'local' as const, label: 'Answered here', tone: 'accent' as Tone },
  { k: 'forwarded' as const, label: 'Forwarded', tone: 'info' as Tone },
  { k: 'blocked' as const, label: 'Blocked', tone: 'warn' as Tone },
]

function ResolverView({
  d,
  lan,
  admin,
}: {
  d: Dns['resolver']
  lan: Dns['lan']
  admin: Dns['admin']
}) {
  const { answered, queries } = d
  const sum = answered.cached + answered.local + answered.forwarded + answered.blocked
  const share = (n: number) => (sum === 0 ? null : (n / sum) * 100)
  const paused = d.blocking.on === false
  const busiest = Math.max(...d.history.map((h) => h.total), 0)
  const unserved = lan.filter((n) => n.served === false)

  return (
    <>
      <ServiceHead
        logo="/icon-pihole.svg"
        name="Pi-hole"
        version={d.version}
        versionNote="from the package the service runs"
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
            k: 'Read from',
            v: null,
            // Worth stating: FTL does serve /api/info/version, and on this
            // installation it fails — it reads a file only the Docker image
            // writes. The NixOS package is the honest answer instead.
            note: 'the NixOS package, not FTL’s own version endpoint',
          },
        ]}
        lede={
          <>
            Every device in the house resolves through this, including this box. It answers for the{' '}
            {d.clients.total === null ? 'LAN' : `${num(d.clients.total)} clients`} it has seen, and
            forwards whatever it cannot answer itself. The addresses those clients hold are the{' '}
            <b>DHCP</b> tab.
          </>
        }
        actions={
          admin !== null && (
            <a className={ACTION} href={`${admin}/`} target="_blank" rel="noreferrer">
              Open the admin ↗
            </a>
          )
        }
      />
      <LinkRow
        links={[
          { label: 'Docs', href: 'https://docs.pi-hole.net/' },
          { label: 'GitHub', href: 'https://github.com/pi-hole/FTL' },
        ]}
      />

      <BoardGrid>
        <Board
          title="The names we declare"
          icon="⌂"
          span={8}
          aside={
            <span className={NOTE}>
              {lan.length} entries · {lan.filter((n) => n.public).length} also public
            </span>
          }
        >
          {/* Forty short names. A wrapping flex rather than a grid of fixed
              columns: `jellyfin` and `homeassistant` differ by a factor of two,
              and a column wide enough for the longest leaves the shortest
              floating in whitespace. Wrapping puts as many on each line as fit
              and nothing anywhere else. */}
          <ul className="m-0 flex list-none flex-wrap gap-[0.3rem] p-0">
            {lan.map((n) => (
              <li
                key={n.fqdn}
                className={cn(
                  'inline-flex min-w-0 items-center gap-[0.35rem] rounded-[7px] bg-(--panel-2) px-2 py-[0.22rem] text-[0.75rem]',
                  // The one state worth interrupting the wall of names for.
                  n.served === false && 'shadow-[inset_0_0_0_1px_var(--danger)]',
                )}
              >
                <span className={cn(MONO, 'text-foreground')}>{n.short}</span>
                {/* Printed only when the entry does not point at this box, so
                    it is a distinction rather than a column — it earns the eye
                    by being rare. */}
                {n.elsewhere && (
                  <span className={cn(MONO, 'text-[0.68rem] text-(--dim) tabular-nums')}>
                    {n.ip}
                  </span>
                )}
                {n.public && <Chip tone="info">public</Chip>}
                {n.served === false && <Chip tone="bad">no route</Chip>}
              </li>
            ))}
          </ul>
          <p className={FOOT}>
            The names this house answers for itself instead of asking anyone. Each one is an entry
            in pi-hole’s hosts file generated from the stack that owns it, so a name gets here by
            being declared and never by being typed into the admin. Nothing in this list can outlive
            the thing it points at. An address is printed only when the entry points somewhere other
            than this box. <b>public</b> marks the ones the zone publishes as well, which is the
            same set the other side of this tab lists, seen from outside.
            {unserved.length === 0
              ? ' Everything pointed at this box has a traefik router behind it.'
              : ' A name marked no route resolves, then lands on the default certificate and 404s.'}
          </p>
        </Board>

        <Board
          title="Where answers come from"
          icon="◈"
          span={4}
          aside={
            <span className={NOTE}>
              {queries.perSecond === null ? DASH : num(queries.perSecond, 1)}/s
            </span>
          }
        >
          {/* Four rows, one per way a query can end. A grid rather than the
              flat row default because the bars only compare if they start at
              the same x — ragged bars are four separate readings rather than
              one breakdown. */}
          <ul className={cn(ROWS, 'mt-[0.2rem]')}>
            {SOURCES.map((s) => (
              <li key={s.k} className={cn(ROW, 'grid grid-cols-[7.5rem_1fr_3.2rem] gap-[0.6rem]')}>
                <span className={MAIN}>{s.label}</span>
                <Progress pct={share(answered[s.k])} tone={s.tone} height={6} />
                <span className={N}>{pct(share(answered[s.k]), 1)}</span>
              </li>
            ))}
          </ul>
          <p className={FOOT}>
            {num(sum)} queries in the window FTL keeps in memory. Cache and the hosts file never
            left the box, which is the whole job. The forwarded slice is the only part any upstream
            sees.
          </p>

          <h4 className={SUB}>Upstreams</h4>
          {/* Narrow board, so the address leads and everything else is allowed
              to be small: two resolvers at the same host name are told apart by
              their address, never by their label. The chip breaks the row's
              grid when it is there, which is the point — it only appears for a
              resolver that should not be in the list at all. */}
          <ul className={ROWS}>
            {d.upstreams.map((u) => (
              <li
                key={u.ip}
                className={cn(
                  ROW,
                  'grid gap-[0.4rem]',
                  u.declared
                    ? 'grid-cols-[minmax(5.5rem,1fr)_auto_3.6rem_3rem]'
                    : 'grid-cols-[1fr_auto] gap-y-[0.15rem]',
                )}
              >
                <span className={cn(MAIN, MONO)}>{u.ip}</span>
                {!u.declared && <Chip tone="warn">not configured</Chip>}
                <span className={N}>{u.replyMs === null ? DASH : ms(u.replyMs)}</span>
                <span className={cn(MONO, SIDE, 'max-w-none text-right')}>{compact(u.count)}</span>
              </li>
            ))}
          </ul>
          <p className={FOOT}>
            Mean round trip, as FTL measured it. That is what a page load waits for on a name nobody
            has asked for recently.
          </p>
        </Board>

        <Board
          title="Traffic"
          icon="⌁"
          span={8}
          aside={<span className={NOTE}>an hour per column</span>}
        >
          <Columns
            points={d.history.map((h) => ({
              label: h.label,
              value: h.total,
              display: `${num(h.total)} queries · ${num(h.forwarded)} forwarded`,
            }))}
            empty="pi-hole returned no history"
          />
          <p className={FOOT}>
            The last day, busiest hour {num(busiest)}. A house at rest still asks thousands of
            questions an hour, most of it background chatter from devices nobody is touching, which
            is why the cache share above is what it is.
          </p>
        </Board>

        <Board
          title="The resolver itself"
          icon="⚙"
          span={4}
          aside={paused ? <Chip tone="bad">blocking paused</Chip> : undefined}
        >
          <Measures
            items={[
              {
                k: 'Blocking',
                v:
                  d.blocking.on === null
                    ? DASH
                    : d.blocking.on
                      ? 'on'
                      : `off, back in ${until(d.blocking.resumesIn)}`,
                tone: d.blocking.on === false ? 'bad' : 'ok',
              },
              {
                k: 'Cache',
                v: d.cache.evicted === 0 ? 'not full' : `${num(d.cache.evicted)} evicted`,
                tone: d.cache.evicted === 0 ? 'ok' : 'warn',
              },
              { k: 'Clients', v: num(d.clients.active), tone: 'muted' },
              { k: 'On the list', v: compact(d.lists.gravity), tone: 'muted' },
            ]}
          />
          <p className={FOOT}>
            The four that can go wrong quietly. Blocking is left off by a “disable for 5 minutes”
            nobody came back to; a cache with <i>evictions</i> is too small for the traffic, which
            expiries do not mean.
          </p>

          <details data-fold className={GROUP}>
            <summary>
              What is being asked
              <Chip tone="muted">{d.types.length}</Chip>
            </summary>
            <BarList
              items={d.types.slice(0, 6).map((t) => ({
                label: t.label,
                value: t.value,
                display: compact(t.value),
              }))}
              tone="info"
              empty="no query types reported"
            />
            <p className={FOOT}>
              A and AAAA are one question asked twice. Every modern client wants both addresses at
              once. PTR is reverse lookups, mostly this box naming its own LAN.
            </p>
          </details>

          <details data-fold className={cn(GROUP, FOLD_STACK)}>
            <summary>
              The query store
              <Chip tone="muted">{bytes(d.store.bytes)}</Chip>
            </summary>
            <Facts
              rows={[
                { k: 'Queries kept', v: compact(d.store.queries) },
                { k: 'Oldest', v: since(d.store.sinceSeconds) },
                { k: 'Allowed by hand', v: num(d.lists.allowed) },
                { k: 'Denied by hand', v: num(d.lists.denied) },
              ]}
            />
            <p className={FOOT}>
              Every query, with the client that asked and the domain it asked for. It is the most
              revealing file on the machine, which is why the admin sits behind the gate rather than
              behind a password.
            </p>
          </details>
        </Board>

        <Changelog gap={d.gap} span={12} />

        <LogBoard
          source={{ unit: 'pihole-ftl.service' }}
          title="pihole-FTL logs"
          foot={
            <p className={FOOT}>
              Not the journal. FTL is the one service on this box that keeps its own log file, and
              the only journal lines about the unit come from systemd, so these are shipped out of{' '}
              <span className={MONO}>/var/log/pihole/FTL.log</span> by alloy. Startup, gravity runs,
              DHCP leases, NTP and upstream trouble. Individual queries are not here and
              deliberately never will be: that log is two gigabytes of every domain every device in
              the house asked for.
            </p>
          }
        />
      </BoardGrid>
    </>
  )
}

// ── DNS: the zone ──────────────────────────────────────────────────────

/** Under a month is the point at which an expiry stops being a date. */
const EXPIRY_WARN_DAYS = 45

function expiryVerdict(r: Dns['zone']['registration']): { label: string; tone: Tone } {
  if (r.expiresIn === null) return { label: 'unknown', tone: 'muted' }
  const days = Math.floor(r.expiresIn / 86400)
  if (days < 0) return { label: 'expired', tone: 'bad' }
  if (days < EXPIRY_WARN_DAYS) return { label: `${String(days)} days left`, tone: 'warn' }
  return { label: `${String(days)} days left`, tone: 'ok' }
}

function ZoneView({ d }: { d: Dns['zone'] }) {
  const { registration: reg } = d
  const locked = reg.status.some((s) => s.includes('transfer prohibited'))
  const drift =
    d.drift.publishedWithoutLan.length +
    d.drift.lanWithoutRoute.length +
    d.drift.tunnelWithoutApp.length
  // What the mail board is a reading OF. Derived rather than typed out: every
  // record in the zone is in exactly one of the four groups, so whatever is
  // not in the other three is mail.
  const mailRecords =
    d.cf.records === null
      ? 0
      : d.cf.records - d.names.length - d.elsewhere.length - d.leftovers.length

  return (
    <>
      <ServiceHead
        logo="/icon-cloudflare.svg"
        name={d.domain}
        // The registrar in the version slot, because for a domain that IS the
        // fact with a state: who currently holds it, and the verdict beside it
        // is how long they hold it for.
        version={reg.registrar}
        versionNote="the registrar, from the registry’s RDAP"
        verdict={expiryVerdict(reg)}
        compare={[
          { k: 'Expires', v: reg.expiresOn, note: 'renewing early does not lose the remainder' },
          {
            k: 'Registered',
            v: reg.registeredAgo === null ? null : `${since(reg.registeredAgo)}`,
            note: 'first registration, per the registry',
          },
          {
            k: 'Last changed',
            v: reg.changedAgo === null ? null : `${since(reg.changedAgo)}`,
            note: 'a nameserver, contact or lock change',
          },
        ]}
        lede={
          <>
            One domain name, and every hostname on this box is a label under it. That means one
            wildcard certificate, one tunnel, one set of OIDC redirect URIs and one expiry date. The
            zone lives at Cloudflare; the registration does not.
          </>
        }
        actions={
          <a
            className={ACTION}
            href={`https://dash.cloudflare.com/?to=/:account/${d.domain}/dns`}
            target="_blank"
            rel="noreferrer"
          >
            Open the zone ↗
          </a>
        }
      />
      <LinkRow
        links={[
          ...(reg.registrarUrl === null ? [] : [{ label: 'Registrar', href: reg.registrarUrl }]),
          // The registrar's control panel for THIS domain, which is where a
          // nameserver or transfer-lock change is actually made — RDAP gives
          // the registrar's front page, which is a different place.
          {
            label: 'Registrar panel',
            href: `https://ap.www.namecheap.com/Domains/DomainControlPanel/${d.domain}/advancedns`,
          },
          {
            label: 'RDAP record',
            href: `https://rdap.identitydigital.services/rdap/domain/${d.domain}`,
          },
        ]}
      />

      {d.note !== null && <p className={EMPTY}>{d.note}</p>}

      <BoardGrid>
        <Board
          title="This house, on the internet"
          icon="⌂"
          span={8}
          aside={
            <span className={NOTE}>
              {d.names.length} of {d.lanOnly + d.names.length} names that point here
            </span>
          }
        >
          {/* One row per name the zone points home, with the chips carrying the
              meaning and the age pushed to the right. Auto columns rather than
              fixed: the chips differ per row and a fixed grid would leave a
              hole in every row that has neither. */}
          <ul className={ROWS}>
            {d.names.map((n) => (
              <li key={n.fqdn} className={cn(ROW, 'gap-[0.4rem]')}>
                <span className={cn(MAIN, MONO, 'min-w-[7rem] flex-none')}>{n.short}</span>
                <Chip tone={n.away === 'tunnel' ? 'info' : 'warn'}>
                  {n.away === 'tunnel' ? 'tunnel' : 'this address'}
                </Chip>
                {n.proxied && <Chip tone="ok">proxied</Chip>}
                {!n.managed && <Chip tone="muted">by hand</Chip>}
                <span className={cn(SIDE, 'max-w-none flex-auto text-left')}>
                  {n.atHome ? 'answered on the LAN' : 'not short-circuited at home'}
                </span>
                <span className={N}>{n.changedAgo === null ? DASH : since(n.changedAgo)}</span>
              </li>
            ))}
          </ul>
          <p className={FOOT}>
            The names the zone points back here. Everything else — {d.lanOnly} of them — exists only
            in pi-hole, so the internet is told nothing about them and a request from outside the
            house never gets as far as the tunnel. A name <b>answered on the LAN</b> is
            short-circuited by pi-hole, which is what keeps traffic from the sofa from going out to
            Cloudflare and back in; <b>proxied</b> means Cloudflare answers with its own address, so
            this one is never published. The <b>tunnel</b> ones carry HTTP and only HTTP. The{' '}
            <span className={MONO}>this address</span> record is the WAN address itself, which is
            how anything speaking another protocol is reached and why it is deliberately not
            short-circuited.
          </p>

          {drift > 0 && (
            <div className="mt-4 border-t border-(--border-soft) pt-[0.7rem]">
              <h4 className={cn(SUB, 'flex items-center gap-[0.45rem]')}>
                Not in step
                <Chip tone="warn">{drift}</Chip>
              </h4>
              {/* Each drift line is a sentence with a list in it, not a table
                  row — so it keeps the foot's type size and gets air between
                  the lines instead. */}
              {d.drift.publishedWithoutLan.length > 0 && (
                <p className={cn(FOOT, '[p+&]:mt-[0.45rem]')}>
                  <b>Published, but pi-hole does not answer for it:</b>{' '}
                  <span className={MONO}>{d.drift.publishedWithoutLan.join(', ')}</span>. Reachable
                  at home only by going out to Cloudflare and back in.
                </p>
              )}
              {d.drift.lanWithoutRoute.length > 0 && (
                <p className={cn(FOOT, '[p+&]:mt-[0.45rem]')}>
                  <b>pi-hole points these here and traefik has no router for them:</b>{' '}
                  <span className={MONO}>{d.drift.lanWithoutRoute.join(', ')}</span>. They resolve,
                  then land on the default certificate and 404.
                </p>
              )}
              {d.drift.tunnelWithoutApp.length > 0 && (
                <p className={cn(FOOT, '[p+&]:mt-[0.45rem]')}>
                  <b>Tunnel records with nothing behind them:</b>{' '}
                  <span className={MONO}>{d.drift.tunnelWithoutApp.join(', ')}</span>. The
                  reconciler only sweeps records carrying its own comment, so these were made by
                  hand and it will not remove them.
                </p>
              )}
            </div>
          )}
        </Board>

        <Board
          title="The registration"
          icon="clock"
          span={4}
          aside={<span className={NOTE}>rdap</span>}
        >
          <Facts
            rows={[
              { k: 'Registrar', v: reg.registrar ?? DASH },
              { k: 'Expires', v: reg.expiresOn ?? DASH },
              {
                k: 'That is in',
                v:
                  reg.expiresIn === null ? (
                    DASH
                  ) : (
                    <span
                      className={expiryVerdict(reg).tone === 'ok' ? 'text-success' : 'text-warning'}
                    >
                      {until(reg.expiresIn)}
                    </span>
                  ),
              },
              {
                k: 'Held since',
                v: reg.registeredAgo === null ? DASH : `${since(reg.registeredAgo)}`,
              },
              {
                k: 'Transfer lock',
                v:
                  reg.status.length === 0 ? (
                    DASH
                  ) : locked ? (
                    <span className="text-success">on</span>
                  ) : (
                    <span className="text-warning">off</span>
                  ),
              },
              {
                k: 'DNSSEC',
                v:
                  reg.signed === null ? (
                    DASH
                  ) : reg.signed ? (
                    <span className="text-success">signed</span>
                  ) : (
                    <span className="text-(--dim)">not signed</span>
                  ),
              },
              { k: 'Zone', v: d.cf.status ?? DASH },
              { k: 'Plan', v: d.cf.plan ?? DASH },
              { k: 'Records', v: d.cf.records === null ? DASH : num(d.cf.records) },
            ]}
          />
          <details className={cn(GROUP, 'mt-[0.6rem]')}>
            <summary>Nameservers</summary>
            <ul className={ROWS}>
              {reg.nameservers.map((n) => (
                <li key={n} className={ROW}>
                  <span className={cn(MAIN, MONO)}>{n}</span>
                </li>
              ))}
            </ul>
          </details>
          <p className={FOOT}>
            {reg.note ??
              'The top half is the registry’s answer, not Cloudflare’s. The lock and the expiry live with the registrar, and nothing on this box can see them. DNSSEC is read the same way: what matters is whether the parent zone holds a DS record, because until it does, nothing validates the signatures.'}
          </p>
        </Board>

        <Board
          title="Mail"
          icon="✉"
          span={6}
          aside={<span className={NOTE}>{d.mail.length} domains</span>}
        >
          {d.mail.length === 0 ? (
            <p className={EMPTY}>no MX records in this zone</p>
          ) : (
            d.mail.map((m) => (
              // One block per mail domain: the name and its MX on a line, the
              // four verdicts under it. Two domains fit a half-width board
              // without either one wrapping.
              <section key={m.domain} className="not-first:mt-4">
                {/* Not the board's own heading style: that one is uppercased,
                    and a domain name and its mail exchangers are literal
                    strings that are wrong in capitals. */}
                <h4 className={cn(MONO, 'm-0 text-[0.8rem] font-semibold text-foreground')}>
                  {m.domain}
                </h4>
                {/* The exchangers are the answer to "who receives this", so
                    they belong under the name — but they are three words of
                    context, not a heading. */}
                <p className={cn(MONO, 'mx-0 mt-[0.1rem] mb-[0.45rem] text-[0.7rem] text-(--dim)')}>
                  {m.mx.join(' · ') || 'no MX'}
                </p>
                <Measures
                  items={[
                    {
                      k: 'SPF',
                      v: m.spf === null ? 'missing' : (m.spf.include[0] ?? 'set'),
                      tone: m.spf === null ? 'bad' : 'ok',
                    },
                    {
                      k: 'DKIM',
                      v:
                        m.dkim === 0
                          ? 'missing'
                          : `${String(m.dkim)} selector${m.dkim === 1 ? '' : 's'}`,
                      tone: m.dkim === 0 ? 'bad' : 'ok',
                    },
                    {
                      k: 'DMARC',
                      v: m.dmarc === null ? 'missing' : (m.dmarc.policy ?? 'set'),
                      tone: m.dmarc === null ? 'bad' : m.dmarc.policy === 'reject' ? 'ok' : 'info',
                    },
                    {
                      k: 'Forgeries',
                      v:
                        m.spf === null
                          ? 'unchecked'
                          : m.spf.qualifier === '-'
                            ? 'rejected'
                            : 'accepted, marked',
                      tone: m.spf?.qualifier === '-' ? 'ok' : 'info',
                    },
                  ]}
                />
                <RecordList
                  records={m.records}
                  summary={`The ${String(m.records.length)} records`}
                  note="MX says who receives it, SPF which servers may send as this domain, the _domainkey selectors carry the signing keys, and _dmarc says what a receiver should do when neither of the first two holds."
                />
              </section>
            ))
          )}
          <p className={FOOT}>
            The {mailRecords} records behind this read as one policy: SPF says which servers may
            send as this domain, DKIM signs what they send, DMARC says what a receiver should do
            when neither holds. <b>quarantine</b> means spam folder rather than bounce, and{' '}
            <b>accepted, marked</b> is an SPF ending in <span className={MONO}>~all</span>, so a
            forgery is flagged rather than refused. Both are the cautious settings, and both are
            worth tightening once nothing legitimate is being caught by them. Open a domain to check
            the reading against the records it came from.
          </p>
        </Board>

        <Board
          title="The rest of the zone"
          icon="logs"
          span={6}
          aside={
            d.leftovers.length > 0 ? (
              <Chip tone="warn">{d.leftovers.length} leftover</Chip>
            ) : (
              <span className={NOTE}>{d.elsewhere.length} records</span>
            )
          }
        >
          <RecordList
            records={d.elsewhere}
            summary="Pointed somewhere else"
            note="Names in this zone served by someone other than this box: a static site host, a CDN, and the verification records those asked for."
            open
          />
          <RecordList
            records={d.leftovers}
            summary="Leftovers"
            tone="warn"
            note="An _acme-challenge TXT is written during a certificate issuance and deleted when it finishes, so every one still in the zone belongs to an issuance that did not clean up. It proves nothing and grants nothing. Two pairs of them are also the same value entered twice, once quoted and once not."
          />
          <RecordList
            records={d.unclassified}
            summary="Everything else"
            tone="bad"
            note="Records none of the groups on this page claimed. The groups are rules: has an MX, is an _acme-challenge, points at the tunnel. Anything a rule set does not cover belongs here rather than nowhere."
            open
          />

          <p className={FOOT}>
            {d.tally.total === null ? (
              'The zone could not be read.'
            ) : (
              <>
                All {d.tally.total} records in the zone are on this page: {d.tally.house} pointing
                back here, {d.tally.mail} for mail, {d.tally.elsewhere} pointed elsewhere and{' '}
                {/* The tail is ONE expression on ONE line: JSX turns a newline
                    before an interpolation into a space, so splitting this
                    left the sentence ending in " ." */}
                {`${String(d.tally.leftovers)} left over${d.tally.unclassified > 0 ? `, plus ${String(d.tally.unclassified)} unclassified` : ''}.`}{' '}
                The count is Cloudflare’s and the groups are computed from it, so a record that
                stopped matching its rule shows up above rather than going missing.
              </>
            )}
          </p>
        </Board>

        <Board
          title="Recently changed"
          icon="◴"
          span={12}
          aside={<span className={NOTE}>the zone keeps no log</span>}
        >
          {/* Two-up on a full-width board, since these rows are short. 34rem
              rather than 24: at 24 the target column had nothing left after the
              name and the age, so every name truncated to four characters and
              "3d ago" wrapped onto two lines. A column that cannot hold its
              content is not a column. */}
          <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(34rem,1fr))] gap-x-[0.6rem] gap-y-[0.22rem] p-0">
            {d.changed.map((r) => (
              // Fixed tracks, so the name always gets its width and the target
              // gives: the name is what identifies the row, the target is
              // context.
              <li
                key={`${r.fqdn}-${r.type}-${r.content}`}
                className={cn(
                  ROW,
                  'grid grid-cols-[minmax(6rem,9rem)_3.4rem_1fr_auto] gap-[0.4rem]',
                )}
              >
                <span className={cn(MAIN, MONO)}>{r.short}</span>
                <Chip tone="muted">{r.type}</Chip>
                <span className={cn(MONO, SIDE, 'max-w-none flex-auto text-left opacity-85')}>
                  {r.content}
                </span>
                <span className={cn(N, 'whitespace-nowrap')}>
                  {r.changedAgo === null ? DASH : since(r.changedAgo)}
                </span>
              </li>
            ))}
          </ul>
          <p className={FOOT}>
            The six most recently edited records. Cloudflare stamps every record with when it last
            changed but keeps no history of what it changed from, so this says when, never what and
            never who.
          </p>
        </Board>
      </BoardGrid>
    </>
  )
}

/**
 * A folded group of raw records.
 *
 * Collapsed by default and never rendered at all when empty: an open box
 * saying "0 leftovers" is a claim worth making once, in the board's aside,
 * rather than a section of the page.
 */
function RecordList({
  records,
  summary,
  note,
  tone = 'muted',
  open = false,
}: {
  records: Dns['zone']['elsewhere']
  summary: string
  note: string
  tone?: Tone
  open?: boolean
}) {
  if (records.length === 0) return null

  return (
    <details data-fold className={cn(GROUP, FOLD_STACK)} open={open}>
      <summary>
        {summary}
        <Chip tone={tone}>{records.length}</Chip>
      </summary>
      {/* Grid tracks, not flex — a per-row flex layout put each type chip at a
          different x, so a column of CNAMEs read as scattered rather than as a
          column. `min-w-0` on the giving track is what lets its ellipsis fire
          at all: a grid item's default `auto` minimum refuses to shrink below
          its content, so without it the row overflows instead of truncating. */}
      <ul className={ROWS}>
        {records.map((r) => (
          <li
            key={`${r.fqdn}-${r.type}-${r.content}`}
            className={cn(ROW, 'grid grid-cols-[minmax(6rem,16rem)_3.4rem_1fr] gap-[0.4rem]')}
          >
            <span className={cn(MAIN, MONO)}>{r.short}</span>
            <Chip tone="muted">{r.type}</Chip>
            {/* Content is the widest thing in the row and the least important —
                a DKIM key is 200 characters of base64 nobody reads on a
                dashboard. */}
            <span className={cn(MONO, SIDE, 'max-w-none flex-auto text-left opacity-85')}>
              {r.content}
            </span>
          </li>
        ))}
      </ul>
      <p className={FOOT}>{note}</p>
    </details>
  )
}
