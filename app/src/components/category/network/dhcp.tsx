import { cn } from '../../../lib/cn'
import type { NetworkData } from '../../../lib/dashboard/categories/network'
import { DASH, num, since } from '../../../lib/format'
import { LogBoard } from '../../logs'
import { LinkRow, ServiceHead } from '../../service-head'
import { Board, BoardGrid, Chip, Facts } from '../../viz'
import { ACTION, EMPTY, FOOT, MONO, MORE, NOTE, SUB } from './shared'

/** A device that has asked for a name today is a device that is switched on. */
const ACTIVE = 24 * 3600

type Device = Dhcp['devices'][number]

/* Sixty-odd rows of four short fields. Wrapping columns rather than one tall
   list: a full-width board holding a single column of 9rem-wide content is a
   page of nothing on the right, and these rows are read by scanning down the
   addresses. */
const DEVICE_LIST =
  'm-0 grid list-none grid-cols-[repeat(auto-fill,minmax(26rem,1fr))] gap-x-[1.6rem] p-0'

/* On a phone the MAC goes before anything else does. Not at half width — below
   78rem every board is already full width, so the row has MORE room there, not
   less; the only place four columns genuinely do not fit is the narrowest
   breakpoint, where the name and address are what gets scanned and the MAC is
   what gets looked up once. */
const DEVICE_ROW =
  'grid grid-cols-[1fr_6.6rem_9.4rem_4.6rem] items-center gap-2 border-t border-(--border-soft) py-[0.26rem] text-[0.74rem] text-(--dim) max-[34rem]:grid-cols-[1fr_6.6rem_4.6rem]'

/**
 * The LAN, in two sections that are one list.
 *
 * Split by whether the address is ours to decide rather than by how recently
 * the thing was seen, because that is the distinction a reader is here for:
 * the fixed ones are a nix file and changing one is a rebuild, everything else
 * took whatever the pool had. Ranking them together and marking the difference
 * would bury the nine among sixty-three.
 *
 * Within each section, most recently seen first, and the quiet tail folds. A
 * reservation that has never been seen sorts last and says so — a declared
 * address for a device that has not existed in months is the one thing in here
 * worth acting on.
 */
function LanDevices({ devices }: { devices: Device[] }) {
  if (devices.length === 0) return <p className={EMPTY}>no devices recorded</p>

  const fixed = devices.filter((d) => d.reserved)
  const rest = devices.filter((d) => !d.reserved)
  const recent = rest.filter((d) => d.lastSeenAgo !== null && d.lastSeenAgo < ACTIVE)
  const quiet = rest.filter((d) => d.lastSeenAgo === null || d.lastSeenAgo >= ACTIVE)

  return (
    <>
      {fixed.length > 0 && (
        <>
          <h4 className={SUB}>Fixed here, {fixed.length} declared</h4>
          <ul className={DEVICE_LIST}>
            {fixed.map((d) => (
              <DeviceRow key={d.mac} d={d} />
            ))}
          </ul>
        </>
      )}

      <h4 className={SUB}>Given whatever was free, {rest.length} seen</h4>
      <ul className={DEVICE_LIST}>
        {recent.map((d) => (
          <DeviceRow key={d.mac} d={d} />
        ))}
      </ul>
      {quiet.length > 0 && (
        <details className={MORE}>
          <summary>{quiet.length} not seen today</summary>
          <ul className={DEVICE_LIST}>
            {quiet.map((d) => (
              <DeviceRow key={d.mac} d={d} />
            ))}
          </ul>
        </details>
      )}
    </>
  )
}

/* Dimmed unless the thing has asked for a name today, which is the whole
   difference between "on the network" and "was, once" — and the reason the
   inactive ones are still printed rather than filtered out. */
function DeviceRow({ d }: { d: Device }) {
  const active = d.lastSeenAgo !== null && d.lastSeenAgo < ACTIVE
  return (
    <li className={DEVICE_ROW}>
      <span className={cn('truncate', active ? 'text-foreground' : 'text-(--text-muted)')}>
        {d.name ?? <span className="text-(--text-muted)">unnamed</span>}
      </span>
      <span className={cn(MONO, 'tabular-nums', active && 'text-(--text-muted)')}>{d.ip}</span>
      <span
        className={cn(MONO, 'text-[0.66rem] max-[34rem]:hidden')}
        title={
          d.knownForDays === null ? 'never seen' : `first seen ${num(d.knownForDays)} days ago`
        }
      >
        {d.mac}
      </span>
      <span className="text-right text-[0.68rem]">
        {d.lastSeenAgo === null ? (
          <span
            className="text-warning"
            title="declared, but the resolver has never seen this address answer"
          >
            never
          </span>
        ) : (
          since(d.lastSeenAgo)
        )}
      </span>
    </li>
  )
}

type Dhcp = Extract<NetworkData, { tab: 'dhcp' }>

// ── DHCP ───────────────────────────────────────────────────────────────

/**
 * Who gets which address, which is a different question from what a name
 * resolves to and now has its own page for saying so.
 *
 * The two shared a tab because they share a process — FTL is both servers —
 * and that is a fact about the software rather than about the subject. DNS
 * answers "where does this name point"; DHCP answers "what is this device
 * called and what address does it hold". A reader chasing a lease was reading
 * past a zone to get to it.
 */
export function DhcpView({ data }: { data: Dhcp }) {
  const { dhcp, devices, admin } = data
  const active = devices.filter((v) => v.lastSeenAgo !== null && v.lastSeenAgo < ACTIVE)
  const unbound = devices.filter((v) => v.reserved && v.lastSeenAgo === null)

  return (
    <>
      <ServiceHead
        logo="/icon-pihole.svg"
        name="Pi-hole"
        version={data.version}
        versionNote="from the package the service runs"
        // No verdict here. It is the same process the DNS tab reports on, and
        // the release notes that justify the word live over there — a second
        // copy of "3 behind" with nothing behind it to open is a claim this
        // page cannot support.
        lede={
          <>
            The same process that answers names hands out the addresses. Every device in the house
            asks this box for one and gets it from a pool this box decides.{' '}
            {dhcp.reservationsKnown ? (
              <>
                {dhcp.reservations.length} of them are pinned by hardware address, so the rest of
                the machine can name them.
              </>
            ) : (
              <>
                Some are pinned by hardware address in a hostsfile this page could not read just
                now.
              </>
            )}
          </>
        }
        actions={
          admin !== null && (
            <a className={ACTION} href={`${admin}/settings-dhcp`} target="_blank" rel="noreferrer">
              DHCP settings ↗
            </a>
          )
        }
      />
      <LinkRow
        links={[
          { label: 'Docs', href: 'https://docs.pi-hole.net/docker/DHCP/' },
          ...(admin === null
            ? []
            : [{ label: 'Leases in the admin', href: `${admin}/settings-dhcp` }]),
        ]}
      />

      <BoardGrid>
        <Board
          title="The pool"
          icon="⊞"
          span={6}
          aside={<Chip tone={dhcp.active ? 'ok' : 'muted'}>{dhcp.active ? 'serving' : 'off'}</Chip>}
        >
          <Facts
            rows={[
              {
                k: 'Range',
                v: (
                  <span className={MONO}>
                    {dhcp.start} – {dhcp.end}
                  </span>
                ),
              },
              { k: 'Lease', v: dhcp.leaseTime },
              { k: 'Gateway offered', v: <span className={MONO}>{dhcp.router}</span> },
              {
                k: 'Fixed addresses',
                v: dhcp.reservationsKnown ? (
                  num(dhcp.reservations.length)
                ) : (
                  <span
                    className="text-warning"
                    title="the reservations hostsfile could not be read"
                  >
                    unknown
                  </span>
                ),
              },
            ]}
          />
          <p className={FOOT}>
            The resolver is the DHCP server too, so addresses on this LAN are decided by this box
            rather than by the router, which is also why the device list below can exist. Everything
            without a reservation gets whatever is free in that range, for {dhcp.leaseTime} at a
            time. A reservation is what lets something else on this box name a device by address,
            which is why the fixed ones are declared in the repo's encrypted hostsfile and not
            clicked into an admin.
          </p>
        </Board>

        <Board
          title="Leases"
          icon="⇌"
          span={6}
          aside={<span className={NOTE}>since FTL started</span>}
        >
          <Facts
            rows={[
              { k: 'Offers made', v: num(dhcp.counters.offers) },
              { k: 'Accepted', v: num(dhcp.counters.acks) },
              {
                k: 'Declined',
                v:
                  dhcp.counters.declines === null ? (
                    DASH
                  ) : dhcp.counters.declines === 0 ? (
                    <span className="text-success">0</span>
                  ) : (
                    <span className="text-warning">{num(dhcp.counters.declines)}</span>
                  ),
              },
              {
                k: 'Refused',
                v:
                  dhcp.counters.nak === null ? (
                    DASH
                  ) : dhcp.counters.nak === 0 ? (
                    <span className="text-success">0</span>
                  ) : (
                    <span className="text-warning">{num(dhcp.counters.nak)}</span>
                  ),
              },
            ]}
          />
          <p className={FOOT}>
            Offers vastly outnumber acceptances and that is normal. A device wakes, is offered an
            address, and often already has one it is happy with. The two to watch are the bottom
            pair: a <b>decline</b> means a client found the address already in use, a <b>refusal</b>{' '}
            means it asked for one this server would not give it. Both are zero on a LAN with one
            DHCP server, and non-zero is usually a second one.
          </p>
        </Board>

        <Board
          title="Everything on the LAN"
          icon="rows"
          span={12}
          aside={
            <span className={NOTE}>
              {active.length} active · {devices.length} known · {dhcp.reservations.length} fixed
            </span>
          }
        >
          <LanDevices devices={devices} />
          <p className={FOOT}>
            Two lists joined on the hardware address. Everything in the house resolves through this
            box, so anything that ever asked for a name has a row here whether or not it took a
            lease. That is what makes this more than the leases above. The <b>fixed</b> ones are the
            reservations, and one of those with no matching device is kept and marked <b>never</b>:
            a declared address for something that has not appeared is the only thing on this page
            worth acting on.
            {unbound.length > 0 &&
              ` ${String(unbound.length)} of ${String(dhcp.reservations.length)} are in that state. A device presenting a private, rotating Wi-Fi address never matches the MAC its reservation was written for.`}{' '}
            <b>active</b> means it looked something up in the last day.
          </p>
        </Board>

        {/* The same file the DNS tab reads, and worth repeating rather than
          leaving this tab as the one page with a header and no log: one
          process serves both, so the lease that was never handed out and the
          name that never resolved are the same log line, and a reader chasing
          a device should not have to know they share a binary to find it.
          There is deliberately no changelog here — see the note on the header
          above, and the panel that carries it one tab over. */}
        <LogBoard
          source={{ unit: 'pihole-ftl.service' }}
          title="pihole-FTL logs"
          foot={
            <p className={FOOT}>
              Shipped out of <span className={MONO}>/var/log/pihole/FTL.log</span> rather than the
              journal. FTL keeps its own file, and the unit&rsquo;s journal lines are
              systemd&rsquo;s rather than its own. Every lease offered, acknowledged and declined is
              in here by hardware address, which is the only place the counters above can be turned
              back into &ldquo;which device&rdquo;.
            </p>
          }
        />
      </BoardGrid>
    </>
  )
}
