import { LinkRow, ServiceHead } from '../../../components/service-head'
import type { Tone } from '../../../components/viz'
import { Board, BoardGrid, Chip, Facts, Measures } from '../../../components/viz'
import { cn } from '../../../lib/cn'
import { DASH, num, since, until } from '../../../lib/format'
import type { NetworkData } from '../data'
import { RecordList } from './dns-records'
import { ACTION, EMPTY, FOOT, GROUP, MAIN, MONO, N, NOTE, ROW, ROWS, SIDE, SUB } from './shared'

// Network › DNS, the zone side: the base domain as the internet is told it —
// the names pointing home, the registration, mail, the rest of the zone and
// what changed last. One component per board.

type Dns = Extract<NetworkData, { tab: 'dns' }>
type Zone = Dns['zone']

/** Under a month is the point at which an expiry stops being a date. */
const EXPIRY_WARN_DAYS = 45

function expiryVerdict(r: Dns['zone']['registration']): { label: string; tone: Tone } {
  if (r.expiresIn === null) return { label: 'unknown', tone: 'muted' }
  const days = Math.floor(r.expiresIn / 86400)
  if (days < 0) return { label: 'expired', tone: 'bad' }
  if (days < EXPIRY_WARN_DAYS) return { label: `${String(days)} days left`, tone: 'warn' }
  return { label: `${String(days)} days left`, tone: 'ok' }
}

export function ZoneView({ d }: { d: Zone }) {
  const { registration: reg } = d

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
        <HomeNames d={d} />
        <Registration d={d} />
        <MailRecords d={d} />
        <RestOfZone d={d} />
        <RecentlyChanged d={d} />
      </BoardGrid>
    </>
  )
}

/** The names the zone points back at this house, and where the three sources disagree. */
function HomeNames({ d }: { d: Zone }) {
  const drift =
    d.drift.publishedWithoutLan.length +
    d.drift.lanWithoutRoute.length +
    d.drift.tunnelWithoutApp.length
  return (
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
        The names the zone points back here. Everything else — {d.lanOnly} of them — exists only in
        pi-hole, so the internet is told nothing about them and a request from outside the house
        never gets as far as the tunnel. A name <b>answered on the LAN</b> is short-circuited by
        pi-hole, which is what keeps traffic from the sofa from going out to Cloudflare and back in;{' '}
        <b>proxied</b> means Cloudflare answers with its own address, so this one is never
        published. The <b>tunnel</b> ones carry HTTP and only HTTP. The{' '}
        <span className={MONO}>this address</span> record is the WAN address itself, which is how
        anything speaking another protocol is reached and why it is deliberately not
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
              <span className={MONO}>{d.drift.publishedWithoutLan.join(', ')}</span>. Reachable at
              home only by going out to Cloudflare and back in.
            </p>
          )}
          {d.drift.lanWithoutRoute.length > 0 && (
            <p className={cn(FOOT, '[p+&]:mt-[0.45rem]')}>
              <b>pi-hole points these here and traefik has no router for them:</b>{' '}
              <span className={MONO}>{d.drift.lanWithoutRoute.join(', ')}</span>. They resolve, then
              land on the default certificate and 404.
            </p>
          )}
          {d.drift.tunnelWithoutApp.length > 0 && (
            <p className={cn(FOOT, '[p+&]:mt-[0.45rem]')}>
              <b>Tunnel records with nothing behind them:</b>{' '}
              <span className={MONO}>{d.drift.tunnelWithoutApp.join(', ')}</span>. The reconciler
              only sweeps records carrying its own comment, so these were made by hand and it will
              not remove them.
            </p>
          )}
        </div>
      )}
    </Board>
  )
}

/** The registry's record of the domain, beside Cloudflare's of the zone. */
function Registration({ d }: { d: Zone }) {
  const { registration: reg } = d
  const locked = reg.status.some((s) => s.includes('transfer prohibited'))
  return (
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
  )
}

/** Each mail domain's posture, with the records it was read from. */
function MailRecords({ d }: { d: Zone }) {
  // What the mail board is a reading OF. Derived rather than typed out: every
  // record in the zone is in exactly one of the four groups, so whatever is
  // not in the other three is mail.
  const mailRecords =
    d.cf.records === null
      ? 0
      : d.cf.records - d.names.length - d.elsewhere.length - d.leftovers.length

  return (
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
        The {mailRecords} records behind this read as one policy: SPF says which servers may send as
        this domain, DKIM signs what they send, DMARC says what a receiver should do when neither
        holds. <b>quarantine</b> means spam folder rather than bounce, and <b>accepted, marked</b>{' '}
        is an SPF ending in <span className={MONO}>~all</span>, so a forgery is flagged rather than
        refused. Both are the cautious settings, and both are worth tightening once nothing
        legitimate is being caught by them. Open a domain to check the reading against the records
        it came from.
      </p>
    </Board>
  )
}

/** Every record the other boards did not claim, in folded groups, with the tally. */
function RestOfZone({ d }: { d: Zone }) {
  return (
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
            All {d.tally.total} records in the zone are on this page: {d.tally.house} pointing back
            here, {d.tally.mail} for mail, {d.tally.elsewhere} pointed elsewhere and{' '}
            {/* The tail is ONE expression on ONE line: JSX turns a newline
                    before an interpolation into a space, so splitting this
                    left the sentence ending in " ." */}
            {`${String(d.tally.leftovers)} left over${d.tally.unclassified > 0 ? `, plus ${String(d.tally.unclassified)} unclassified` : ''}.`}{' '}
            The count is Cloudflare’s and the groups are computed from it, so a record that stopped
            matching its rule shows up above rather than going missing.
          </>
        )}
      </p>
    </Board>
  )
}

/** The zone keeps no log, so this is when — never what or who. */
function RecentlyChanged({ d }: { d: Zone }) {
  return (
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
            className={cn(ROW, 'grid grid-cols-[minmax(6rem,9rem)_3.4rem_1fr_auto] gap-[0.4rem]')}
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
  )
}
