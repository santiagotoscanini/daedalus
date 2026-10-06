import { LinkRow, ServiceHead } from '../../../components/service-head'
import { Button } from '../../../components/ui/button'
import type { Tone } from '../../../components/viz'
import { Board, BoardGrid, Chip, Facts } from '../../../components/viz'
import { cn } from '../../../lib/cn'
import { DASH, num, since, until } from '../../../lib/format'
import type { NetworkData } from '../data'
import { MailRecords, RecentlyChanged, RestOfZone } from './dns-zone-records'
import { CAPTION, EMPTY, FOOT, GROUP, MAIN, MONO, N, NOTE, ROW, ROWS, SIDE, SUB } from './shared'

// Network › DNS, the zone side: the base domain as the internet is told it —
// the names pointing home, the registration, mail, the rest of the zone and
// what changed last. One component per board.

type Dns = Extract<NetworkData, { tab: 'dns' }>
export type Zone = Dns['zone']

/** Under 45 days is the point at which an expiry stops being a date. */
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
          <Button asChild size="sm">
            <a
              href={`https://dash.cloudflare.com/?to=/:account/${d.domain}/dns`}
              target="_blank"
              rel="noreferrer"
            >
              Open the zone ↗
            </a>
          </Button>
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
          <li key={n.fqdn} className={cn(ROW, 'gap-2')}>
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
        <div className="mt-1 border-hairline border-t pt-3">
          <h4 className={cn(SUB, 'flex items-center gap-2')}>
            Not in step
            <Chip tone="warn">{drift}</Chip>
          </h4>
          {/* Each drift line is a sentence with a list in it, not a table
                  row — so it keeps the foot's type size and gets air between
                  the lines instead. */}
          {d.drift.publishedWithoutLan.length > 0 && (
            <p className={cn(CAPTION, '[p+&]:mt-2')}>
              <b>Published, but pi-hole does not answer for it:</b>{' '}
              <span className={MONO}>{d.drift.publishedWithoutLan.join(', ')}</span>. Reachable at
              home only by going out to Cloudflare and back in.
            </p>
          )}
          {d.drift.lanWithoutRoute.length > 0 && (
            <p className={cn(CAPTION, '[p+&]:mt-2')}>
              <b>pi-hole points these here and traefik has no router for them:</b>{' '}
              <span className={MONO}>{d.drift.lanWithoutRoute.join(', ')}</span>. They resolve, then
              land on the default certificate and 404.
            </p>
          )}
          {d.drift.tunnelWithoutApp.length > 0 && (
            <p className={cn(CAPTION, '[p+&]:mt-2')}>
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
                <span className="text-muted-foreground">not signed</span>
              ),
          },
          { k: 'Zone', v: d.cf.status ?? DASH },
          { k: 'Plan', v: d.cf.plan ?? DASH },
          { k: 'Records', v: d.cf.records === null ? DASH : num(d.cf.records) },
        ]}
      />
      <details className={cn(GROUP, 'mt-1')}>
        <summary>Nameservers</summary>
        <ul className={ROWS}>
          {reg.nameservers.map((n) => (
            <li key={n} className={ROW}>
              <span className={cn(MAIN, MONO)}>{n}</span>
            </li>
          ))}
        </ul>
      </details>
      <p className={reg.note === null ? FOOT : CAPTION}>
        {reg.note ??
          'The top half is the registry’s answer, not Cloudflare’s. The lock and the expiry live with the registrar, and nothing on this box can see them. DNSSEC is read the same way: what matters is whether the parent zone holds a DS record, because until it does, nothing validates the signatures.'}
      </p>
    </Board>
  )
}
