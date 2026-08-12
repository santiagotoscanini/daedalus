import type { NetworkData } from '../../../lib/dashboard/categories/network'
import { DASH, num, since } from '../../../lib/format'
import { LogBoard } from '../../logs'
import { LinkRow, ServiceHead } from '../../service-head'
import { Board, BoardGrid, Chip, Facts } from '../../viz'

/** A device that has asked for a name today is a device that is switched on. */
const ACTIVE = 24 * 3600

type Device = Dhcp['devices'][number]

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
  if (devices.length === 0) return <p className="viz-empty">no devices recorded</p>

  const fixed = devices.filter((d) => d.reserved)
  const rest = devices.filter((d) => !d.reserved)
  const recent = rest.filter((d) => d.lastSeenAgo !== null && d.lastSeenAgo < ACTIVE)
  const quiet = rest.filter((d) => d.lastSeenAgo === null || d.lastSeenAgo >= ACTIVE)

  return (
    <>
      {fixed.length > 0 && (
        <>
          <h4 className="board-sub">Fixed here — {fixed.length} declared in nix</h4>
          <ul className="devices">
            {fixed.map((d) => (
              <DeviceRow key={d.mac} d={d} />
            ))}
          </ul>
        </>
      )}

      <h4 className="board-sub">Given whatever was free — {rest.length} seen</h4>
      <ul className="devices">
        {recent.map((d) => (
          <DeviceRow key={d.mac} d={d} />
        ))}
      </ul>
      {quiet.length > 0 && (
        <details className="more">
          <summary>{quiet.length} not seen today</summary>
          <ul className="devices">
            {quiet.map((d) => (
              <DeviceRow key={d.mac} d={d} />
            ))}
          </ul>
        </details>
      )}
    </>
  )
}

function DeviceRow({ d }: { d: Device }) {
  const active = d.lastSeenAgo !== null && d.lastSeenAgo < ACTIVE
  return (
    <li className={active ? 'device is-active' : 'device'}>
      <span className="device-name">{d.name ?? <span className="muted">unnamed</span>}</span>
      <span className="device-ip mono">{d.ip}</span>
      <span
        className="device-mac mono"
        title={
          d.knownForDays === null ? 'never seen' : `first seen ${num(d.knownForDays)} days ago`
        }
      >
        {d.mac}
      </span>
      <span className="device-seen">
        {d.lastSeenAgo === null ? (
          <span
            className="warn-text"
            title="declared in nix, but the resolver has never seen this address answer"
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
            asks this box for one and gets it from a pool this box decides —{' '}
            {dhcp.reservations.length} of them pinned by hardware address, so the rest of the
            machine can name them.
          </>
        }
        actions={
          admin !== null && (
            <a
              className="btn btn-primary"
              href={`${admin}/settings-dhcp`}
              target="_blank"
              rel="noreferrer"
            >
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
                  <span className="mono">
                    {dhcp.start} – {dhcp.end}
                  </span>
                ),
              },
              { k: 'Lease', v: dhcp.leaseTime },
              { k: 'Gateway offered', v: <span className="mono">{dhcp.router}</span> },
              { k: 'Fixed addresses', v: num(dhcp.reservations.length) },
            ]}
          />
          <p className="board-foot">
            The resolver is the DHCP server too, so addresses on this LAN are decided by this box
            rather than by the router — which is also why the device list below can exist at all.
            Everything without a reservation gets whatever is free in that range, for{' '}
            {dhcp.leaseTime} at a time. A reservation is what lets something else on this box name a
            device by address, which is why the fixed ones are declared in nix and not clicked into
            an admin.
          </p>
        </Board>

        <Board
          title="Leases"
          icon="⇌"
          span={6}
          aside={<span className="board-note">since FTL started</span>}
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
                    <span className="ok-text">0</span>
                  ) : (
                    <span className="warn-text">{num(dhcp.counters.declines)}</span>
                  ),
              },
              {
                k: 'Refused',
                v:
                  dhcp.counters.nak === null ? (
                    DASH
                  ) : dhcp.counters.nak === 0 ? (
                    <span className="ok-text">0</span>
                  ) : (
                    <span className="warn-text">{num(dhcp.counters.nak)}</span>
                  ),
              },
            ]}
          />
          <p className="board-foot">
            Offers vastly outnumber acceptances and that is normal — a device wakes, is offered an
            address, and often already has one it is happy with. The two to watch are the bottom
            pair: a <b>decline</b> means a client found the address already in use, a <b>refusal</b>{' '}
            means it asked for one this server would not give it. Both are zero on a LAN with one
            DHCP server, and non-zero is usually a second one.
          </p>
        </Board>

        <Board
          title="Everything on the LAN"
          icon="▤"
          span={12}
          aside={
            <span className="board-note">
              {active.length} active · {devices.length} known · {dhcp.reservations.length} fixed
            </span>
          }
        >
          <LanDevices devices={devices} />
          <p className="board-foot">
            Two lists joined on the hardware address. Everything in the house resolves through this
            box, so anything that ever asked for a name has a row here whether or not it took a
            lease — which is what makes this more than the leases above. The <b>fixed</b> ones are
            the reservations, and one of those with no matching device is kept and marked{' '}
            <b>never</b>: a declared address for something that has not appeared is the only thing
            on this page worth acting on.
            {unbound.length > 0 &&
              ` ${String(unbound.length)} of ${String(dhcp.reservations.length)} are in that state — a device presenting a private, rotating Wi-Fi address never matches the MAC its reservation was written for.`}{' '}
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
            <p className="board-foot">
              Shipped out of <span className="mono">/var/log/pihole/FTL.log</span> rather than the
              journal — FTL keeps its own file, and the unit&rsquo;s journal lines are
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
