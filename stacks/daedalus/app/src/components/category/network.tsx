import { useEffect, useState } from 'react'
import { bytes, compact, DASH, flag, ms, num, pct, since, until } from '../../lib/dashboard/format'
import { BASE_DOMAIN, stripBaseDomain } from '../../lib/site'
import type { NetworkData } from '../../server/category'
import { LogBoard, type LogNeighbour } from '../logs'
import { Changelog } from '../release-notes'
import { LinkRow, ServiceHead, verdictOf } from '../service-head'
import { Segmented } from '../ui'
import type { Tone } from '../viz'
import {
  BarList,
  Board,
  BoardGrid,
  Chip,
  Columns,
  Facts,
  Measures,
  Progress,
  Pulse,
  Trend,
} from '../viz'

// The Network category, split by DIRECTION.
//
// General is the box's own plumbing — the WAN link, the proxy that terminates
// everything, the resolver every device depends on, and the certificates. The
// other two tabs are the two tunnels, and they are separate tabs because they
// are opposites that share a vocabulary: both are WireGuard, both are called
// "the VPN" in conversation, and one of them exists to let a phone reach this
// house while the other exists to stop this house being recognised. On one
// page the words "VPN", "WireGuard" and "tunnel" each meant two things a
// scroll apart.

export function NetworkView({ data }: { data: NetworkData }) {
  switch (data.tab) {
    case 'wireguard':
      return <InboundView data={data} />
    case 'proxy':
      return <TraefikView d={data} />
    case 'outbound':
      return <OutboundView data={data} />
    case 'dns':
      return <DnsView data={data} />
    case 'dhcp':
      return <DhcpView data={data} />
    default:
      return <GeneralView data={data} />
  }
}

type General = Extract<NetworkData, { tab: 'general' }>

/** Sub-millisecond on the LAN, single digits to the edge — decimals or nothing. */
const rtt = (v: number | null) => (v === null ? DASH : `${num(v, v < 10 ? 2 : 0)} ms`)

/** A device that has asked for a name today is a device that is switched on. */
const ACTIVE = 24 * 3600

/**
 * The two things that measure this tab's subject.
 *
 * Neither is a service anybody opens and neither will ever have a page, which
 * is exactly the case `LogNeighbour` exists for: a reading here that has
 * quietly stopped moving is indistinguishable from a quiet network, and one of
 * these two logs is the only place that difference is visible.
 */
const UPLINK_READERS: readonly LogNeighbour[] = [
  {
    source: { unit: 'host-liveness-exporter.service' },
    label: 'host-liveness-exporter',
    role: 'the round trips, and the dot on this tab',
    note: 'Pings the gateway and the internet every 60s and publishes network_hop_up / network_hop_rtt_seconds — the two hops charted above, and the pair this tab’s status dot is computed from, since there is no one service here for gatus to probe. It also walks the rootless cgroup tree for the per-container byte counters in the traffic panel.',
  },
  {
    source: { container: 'node-exporter' },
    label: 'node-exporter',
    role: 'the NIC counters themselves',
    note: 'Everything the cable chart is drawn from. It runs on --network=host precisely so it sees enp3s0 rather than a container’s virtual interface — which is also why the bytes it reports are all LAN traffic included, and are not comparable to the line capacity measured next door.',
  },
]

/**
 * The house network: the cable, the line behind it, and who is using both.
 *
 * The organising distinction is one that gets collapsed constantly and is two
 * different measurements. The NIC counters are USAGE — every byte that crossed
 * the cable, most of which never leaves the house. The hourly speed test is
 * CAPACITY — what the ISP line can carry. A film streamed to the TV moves a
 * gigabyte of the first and none of the second, so the wire routinely carries
 * more than the line could, and neither number bounds the other. They are two
 * boards for that reason, never one chart with two lines on it.
 */
function GeneralView({ data }: { data: General }) {
  const { wire, line, hops, router, services, dns } = data

  const gateway = hops.find((h) => h.id === 'gateway')
  const internet = hops.find((h) => h.id === 'internet')
  const moved = services.reduce((n, s) => n + s.in + s.out, 0)

  return (
    <>
      {/* No headline band. Every figure one would have carried is the lead
          reading of a board below it — the two rates head the chart they are
          drawn from, the round trip sits with the probe that measured it, the
          device count is the panel's own aside. Four cards restating them
          would be the same numbers twice, one scroll apart. */}
      <BoardGrid>
        <Board
          title="What crosses the cable"
          icon="⇅"
          span={8}
          aside={
            <span className="board-note">
              24 hours ·{' '}
              {wire.linkMbps === null ? 'one NIC' : `${num(wire.linkMbps / 1000, 1)} Gbps link`}
            </span>
          }
        >
          <h4 className="board-sub">Receiving, Mbps</h4>
          <Trend values={wire.inHistory} height={72} />
          <h4 className="board-sub">Sending, Mbps</h4>
          <Trend values={wire.outHistory} tone="info" height={56} />
          <Measures
            items={[
              { k: 'In now', v: `${num(wire.inMbps, 1)} Mbps` },
              { k: 'Out now', v: `${num(wire.outMbps, 1)} Mbps` },
              { k: 'In, 24h', v: bytes(wire.inDay) },
              { k: 'Out, 24h', v: bytes(wire.outDay) },
              { k: 'Peak in', v: `${num(Math.max(...wire.inHistory, 0), 1)} Mbps` },
              { k: 'Peak out', v: `${num(Math.max(...wire.outHistory, 0), 1)} Mbps` },
            ]}
          />
          <p className="board-foot">
            Every byte over this box’s one network interface, which is not the same thing as
            internet traffic and is usually much more of it — a film streamed to the TV crosses this
            cable in full and never leaves the house. The line’s own capacity is the board below;
            these two numbers are not comparable and are deliberately not on one chart.
          </p>
        </Board>

        <Board
          title="The way out"
          icon="⌗"
          span={4}
          aside={
            <Chip tone={internet?.up === false ? 'bad' : gateway?.up === false ? 'warn' : 'ok'}>
              {internet?.up === false
                ? 'no internet'
                : gateway?.up === false
                  ? 'no router'
                  : 'reachable'}
            </Chip>
          }
        >
          <div className="origin">
            <span className="origin-label">public address</span>
            <strong className="origin-ip">{router.wan ?? DASH}</strong>
            <span className="origin-note">this house, as Cloudflare’s edge sees it arrive</span>
          </div>
          <ul className="hops">
            {hops.map((h) => (
              <li key={h.id} className="hop">
                <Pulse on={h.up === true} tone={h.up === true ? 'ok' : 'bad'} />
                <span className="hop-label">{h.label}</span>
                <span className="hop-rtt mono">{rtt(h.rttMs)}</span>
                <Trend values={h.history} height={22} tone="muted" empty="" />
              </li>
            ))}
          </ul>
          <Facts
            rows={[
              { k: 'Default route', v: <span className="mono">{router.gateway}</span> },
              { k: 'This box', v: <span className="mono">{router.lan}</span> },
              {
                k: 'Link',
                v: wire.linkMbps === null ? DASH : `${num(wire.linkMbps)} Mbps negotiated`,
              },
            ]}
          />
          <p className="board-foot">
            Two probes a minute rather than one: the router answering while the far side does not is
            the ISP, and neither answering is this box’s own link. The public address is the one
            fact that cannot be measured from inside — behind NAT nothing here can see it, so it is
            read back from the edge the tunnel dials out to.
          </p>
        </Board>

        <Board
          title="The router"
          icon="⌗"
          span={4}
          aside={
            <span className="board-note">
              {router.firmware === null ? 'not answering' : `firmware ${router.firmware}`}
            </span>
          }
        >
          <div className="router">
            <img className="router-photo" src="/router-axe75.png" alt="" width={150} height={150} />
            <div className="router-id">
              <strong className="router-model">
                {router.model ?? 'Unknown'}
                {router.hardware !== null && <span className="router-rev">{router.hardware}</span>}
              </strong>
              <span className="router-product">{router.product}</span>
              <a
                className="btn btn-primary router-open"
                href={router.adminUrl}
                target="_blank"
                rel="noreferrer"
              >
                Open the admin ↗
              </a>
            </div>
          </div>
          <Facts
            rows={[
              { k: 'Firmware', v: <span className="mono">{router.firmware ?? DASH}</span> },
              { k: 'Built', v: router.built ?? DASH },
              { k: 'Address', v: <span className="mono">{router.gateway}</span> },
              { k: 'Round trip', v: rtt(gateway?.rttMs ?? null) },
            ]}
          />
          <p className="board-foot">
            Read from the router, not typed here. It answers every configuration call with a login
            page — there is no API — but that page carries a build stamp in a meta tag, and the
            model, hardware revision, firmware and build date all come out of it. So a firmware
            update appears here on its own. The one thing the stamp does not carry is the name on
            the box, which is the only part of this panel that is declared.
          </p>
        </Board>

        <Board
          title="Which services move the bytes"
          icon="▦"
          span={8}
          aside={<span className="board-note">{bytes(moved)} over 24 hours</span>}
        >
          <TrafficList rows={services} />
          <p className="board-foot">
            Counted inside each container’s own network namespace, so this is traffic the app itself
            moved rather than a share of the total guessed from anything. Two kinds are absent by
            construction and not by omission: a container on the host’s network has no figures
            separable from the box, and the ten sharing <b>gluetun</b>’s namespace have none
            separable from each other — gluetun’s row is the download stack entire, counted as it
            crossed the wire encrypted.
          </p>
        </Board>

        <Board
          title="The line itself"
          icon="◎"
          span={4}
          aside={<span className="board-note">7 days, hourly</span>}
        >
          <Measures
            items={[
              { k: 'Down', v: `${num(line.down)} Mbps` },
              { k: 'Up', v: `${num(line.up)} Mbps` },
              { k: 'Latency', v: `${num(line.ping, 1)} ms` },
            ]}
          />
          <h4 className="board-sub">Download, Mbps</h4>
          <Trend values={line.downHistory} height={64} />
          <h4 className="board-sub">Upload, Mbps</h4>
          <Trend values={line.upHistory} tone="info" height={48} />
          {/* The hourly test saturates the WAN for a couple of minutes and has
              historically taken LAN DNS down with it — worth knowing when a
              gap in another chart lines up with the top of an hour. */}
          <p className="board-foot">
            What the connection can do rather than what it is doing, measured hourly by{' '}
            {line.url === null ? (
              'MySpeed'
            ) : (
              <a href={line.url} target="_blank" rel="noreferrer">
                MySpeed
              </a>
            )}
            . It briefly saturates the link while it measures, so a gap at the top of an hour in any
            other chart on this page is this test rather than an outage.
          </p>
        </Board>

        <Board
          title="What this house asks for"
          icon="◈"
          span={8}
          aside={<span className="board-note">{compact(dns.queries)} lookups today</span>}
        >
          <BarList items={dns.topDomains} tone="accent" empty="no queries recorded" />
          <p className="board-foot">
            The names most looked up, which is the closest thing to a list of what this house
            depends on outside itself.{' '}
            {dns.fromBox === null || dns.queries === null
              ? 'Most of it is this box rather than the devices on the LAN.'
              : `${pct((dns.fromBox / dns.queries) * 100)} of it came from 127.0.0.1 — every container on this box resolves through the host’s stub, so pi-hole sees them as one client and no split by service is available from here.`}
          </p>
        </Board>

        {/* The device list was here. It is on DHCP now, merged with the
            reservations that name those devices — what is on the LAN is a
            lease fact, not a throughput one. */}

        {/* This tab had no log at all, which made it the only page here whose
            numbers could not be checked against the thing that produced them.
            Its subject is the wire and the wire keeps no log — but the three
            processes that MEASURE it do, and every reading above comes from
            one of them. MySpeed leads because it is the only one of the three
            that is a service rather than plumbing, and the only one whose
            failure is visible as a wrong number rather than a missing one. */}
        <LogBoard
          source={{ container: 'myspeed' }}
          title="MySpeed logs"
          neighbours={UPLINK_READERS}
          foot={
            <p className="board-foot">
              The hourly speed test behind the capacity chart. It saturates the link while it runs,
              which is why nothing network-heavy is ever scheduled on the hour on this box — a test
              at :00 once took DNS down for two minutes for the whole house.
            </p>
          }
        />
      </BoardGrid>
    </>
  )
}

/**
 * Per-container traffic, in and out on one row.
 *
 * Ranked by the two directions added together and drawn as one split bar,
 * because the question this answers is "who is using the network" and a
 * service that only ever uploads should not sort below one that does half as
 * much in both directions. The direction still shows: it is the split.
 */
function TrafficList({ rows }: { rows: General['services'] }) {
  if (rows.length === 0) return <p className="viz-empty">no per-container counters yet</p>

  const top = rows.slice(0, 12)
  const rest = rows.slice(12)
  const ceiling = Math.max(...rows.map((r) => r.in + r.out), 1)

  return (
    <>
      <ul className="traffic">
        {top.map((r) => (
          <TrafficRow key={r.name} row={r} ceiling={ceiling} />
        ))}
      </ul>
      {rest.length > 0 && (
        <details className="more">
          <summary>
            {rest.length} quieter container{rest.length === 1 ? '' : 's'}
          </summary>
          <ul className="traffic">
            {rest.map((r) => (
              <TrafficRow key={r.name} row={r} ceiling={ceiling} />
            ))}
          </ul>
        </details>
      )}
    </>
  )
}

function TrafficRow({ row, ceiling }: { row: General['services'][number]; ceiling: number }) {
  const total = row.in + row.out
  const width = (n: number) => `${String((n / ceiling) * 100)}%`

  return (
    <li className="traffic-row">
      <span className="traffic-name" title={row.name}>
        {row.name}
      </span>
      <span className="traffic-track">
        <span
          className="traffic-in"
          style={{ width: width(row.in) }}
          title={`${bytes(row.in)} in`}
        />
        <span
          className="traffic-out"
          style={{ width: width(row.out) }}
          title={`${bytes(row.out)} out`}
        />
      </span>
      <span className="traffic-total mono">{bytes(total)}</span>
    </li>
  )
}

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

function codeTone(code: string): 'ok' | 'info' | 'warn' | 'bad' {
  if (code.startsWith('2')) return 'ok'
  if (code.startsWith('3')) return 'info'
  if (code.startsWith('4')) return 'warn'
  return 'bad'
}

// ── Coming in ──────────────────────────────────────────────────────────────

type Inbound = Extract<NetworkData, { tab: 'wireguard' }>

/**
 * Three ways in, and they have almost nothing in common.
 *
 * The tunnel is an outbound connection cloudflared holds open, so the edge
 * reaches this box without the router ever accepting one. WireGuard is the
 * exception: one forwarded UDP port, acceptable only because the protocol
 * ignores unauthenticated packets. And the third is no proxy at all — the
 * address itself, for the things that speak neither HTTP nor WireGuard.
 *
 * Three different pieces of software, three different failure modes, so each
 * gets its own header and its own boards rather than a shared row that would
 * fit none of them. What IS shared is the strip above the switch: which of the
 * three is working, all at once, so a broken one is visible without visiting
 * it. That is the whole reason they live on one tab instead of three.
 */
function InboundView({ data }: { data: Inbound }) {
  // Direct first and selected by default: it is the plainest of the three —
  // a name resolving to this house's address, no proxy and no tunnel — and
  // the other two are each a layer added on top of it. Reading them in that
  // order is reading them in the order they were built.
  const [route, setRoute] = useState<'direct' | 'tunnel' | 'wireguard'>('direct')
  const { wireguard, tunnel, ddns } = data

  const wgOk = (wireguard.counts.configured ?? 0) > 0
  const tunnelOk = tunnel.status === 'healthy'
  // The address is right when the name resolves to where the tunnel says
  // traffic is actually arriving from. Unknown on either side is not a fault.
  const dnsOk =
    ddns.resolved === null || ddns.actual === null ? null : ddns.resolved === ddns.actual

  return (
    <>
      {/* Each route's health rides the button that selects it. There was a
          second row of the same three names carrying the same three dots, and
          a name printed twice is a name the reader has to reconcile — this
          says it once, in the only place it can be read without selecting the
          route it belongs to. */}
      <div className="tunnel-bar">
        <Segmented
          value={route}
          onChange={setRoute}
          options={[
            { value: 'direct', label: 'Direct', dot: tone(dnsOk) },
            { value: 'tunnel', label: 'Cloudflare tunnel', dot: tone(tunnelOk) },
            { value: 'wireguard', label: 'WireGuard', dot: tone(wgOk) },
          ]}
        />
      </div>

      {route === 'tunnel' ? (
        <CfTunnelView t={tunnel} />
      ) : route === 'direct' ? (
        <DdnsView d={ddns} />
      ) : (
        <WireguardView data={wireguard} />
      )}
    </>
  )
}

/**
 * A tri-state health as a dot tone.
 *
 * `null` is "could not be read", which is grey — deliberately not the same
 * claim as down, and the state a route lands in when the thing that would
 * answer for it is itself unreachable.
 */
function tone(ok: boolean | null): Tone | null {
  return ok === null ? null : ok ? 'ok' : 'bad'
}

/**
 * The way back into the house.
 *
 * One question, really: can I get in, and is anything configured that should
 * not be. So the peer list is the page — every peer, whether or not it has
 * ever connected, with the handshake that is the only liveness WireGuard has.
 * A peer that exists and has never handshaken is a credential somebody was
 * issued and never used, which is worth seeing on a list of two.
 */
function WireguardView({ data }: { data: Inbound['wireguard'] }) {
  const { gap, counts, peers, daily } = data
  const live = counts.connected !== null && counts.connected > 0
  const max = Math.max(...peers.map((p) => p.rx + p.tx), 1)

  return (
    <>
      <ServiceHead
        logo="/icon-wireguard.svg"
        name="WireGuard"
        version={data.version}
        versionNote="wg-easy, pinned in the flake"
        verdict={verdictOf(gap)}
        compare={[
          {
            k: 'Latest',
            v: gap.latest,
            note:
              gap.latest === null
                ? 'GitHub did not answer'
                : gap.behind.length === 0
                  ? 'this is what is running'
                  : `${String(gap.behind.length)} release${gap.behind.length === 1 ? '' : 's'} between them`,
          },
          { k: 'Pinned by', v: null, note: 'an exact tag in stacks/wg-easy' },
        ]}
        lede={
          <>
            The one service the router forwards a port for, and the only way back into this house
            from outside it. UDP 51820, and a WireGuard socket does not answer an unauthenticated
            packet at all — which is the entire reason a forwarded port is acceptable here.
          </>
        }
        actions={
          data.url === null ? undefined : (
            <a className="btn btn-primary" href={data.url} target="_blank" rel="noreferrer">
              Open wg-easy ↗
            </a>
          )
        }
      />
      <LinkRow
        links={[
          { label: 'WireGuard', href: 'https://www.wireguard.com/' },
          { label: 'wg-easy', href: 'https://github.com/wg-easy/wg-easy' },
        ]}
      />

      <BoardGrid>
        <Board
          title="Peers"
          icon="⚿"
          span={8}
          aside={
            <span className="board-live">
              <Pulse on={live} tone="ok" />
              {live ? `${num(counts.connected)} connected` : 'nobody dialled in'}
            </span>
          }
        >
          <Measures
            items={[
              { k: 'configured', v: num(counts.configured) },
              { k: 'enabled', v: num(counts.enabled) },
              { k: 'connected now', v: num(counts.connected) },
            ]}
          />

          {peers.length === 0 ? (
            <p className="viz-empty">no peers configured</p>
          ) : (
            <ul className="ranks">
              {peers.map((p) => (
                <li className="rank" key={p.name}>
                  <span className="rank-name">
                    <span title={p.name}>{p.name}</span>
                    {!p.enabled && <em className="is-muted">disabled</em>}
                    {p.handshakeAgo === null && <em>never used</em>}
                  </span>
                  <span className="rank-track">
                    <span
                      className="rank-fill"
                      style={{ width: `${String(Math.max(1.5, ((p.rx + p.tx) / max) * 100))}%` }}
                    />
                  </span>
                  <span className="rank-n">{bytes(p.rx + p.tx)}</span>
                  <span className="rank-meta">
                    {p.ipv4 !== null && <span className="mono">{p.ipv4}</span>}
                    {/* Named rather than arrowed. An arrow on a VPN row is
                        ambiguous by construction — the same byte is the
                        peer's upload and the server's download — so these say
                        which end they are counted at. */}
                    <span>{bytes(p.rx)} from it</span>
                    <span>{bytes(p.tx)} to it</span>
                    <span>{p.ago}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}

          <p className="board-foot">
            {/* The distinction that trips people up: WireGuard is
                connectionless, so there is no session to be in or out of. */}
            Ranked by total traffic. WireGuard has no connections to count — a peer is
            &ldquo;connected&rdquo; exactly in the sense that it exchanged a handshake recently, so
            a phone that is asleep reads as absent and is not. The byte counters are cumulative and
            reset when wg-easy restarts, which is why they are a ranking here rather than a rate.
          </p>
        </Board>

        <Board
          title="Anyone home"
          icon="◷"
          span={4}
          aside={<span className="board-note">peak per day, 14d</span>}
        >
          <Columns
            points={daily.map((d) => ({
              label: d.date.slice(5),
              value: d.peers,
              display: `${num(d.peers)} peer${d.peers === 1 ? '' : 's'} at peak`,
            }))}
            tone="ok"
            height={112}
            empty="no history yet"
          />
          {daily.length > 0 && (
            <p className="colaxis">
              <span>{daily[0]?.date.slice(5)}</span>
              <span>peers at peak</span>
              <span>{daily[daily.length - 1]?.date.slice(5)}</span>
            </p>
          )}
          <p className="board-foot">
            Peak rather than average, because the question is whether the tunnel got used at all and
            a twenty-minute session averages to nearly nothing over a day. An empty column is a day
            nobody was away from the house — not a fault.
          </p>
        </Board>

        <Changelog gap={gap} />

        {/* No neighbours: wg-easy runs the tunnel, the web UI and the exporter
            in one container, and nothing else on the box is part of it. */}
        <LogBoard source={{ container: 'wg-easy' }} title="wg-easy logs" />
      </BoardGrid>
    </>
  )
}

// ── Going out: the egress tunnels ──────────────────────────────────────────

/**
 * Every VPN this box exits through, one at a time.
 *
 * A selector rather than a board per tunnel, and that is the whole design
 * decision here: there are two today and the shape of the page must not
 * depend on that. Each is the same set of questions — where does it come out,
 * has it stayed up, when does its key die, what loses the network with it —
 * so they get one page and a switch, and a third tunnel appears in the switch
 * by being declared. The list comes from `fleet.vpnEgress`, which
 * `mkGluetunInstance` writes itself.
 */
function OutboundView({ data }: { data: Extract<NetworkData, { tab: 'outbound' }> }) {
  const [selected, setSelected] = useState(data.tunnels[0]?.key ?? '')
  const t = data.tunnels.find((x) => x.key === selected) ?? data.tunnels[0]

  if (t === undefined) {
    return (
      <BoardGrid>
        <Board title="Going out" icon="⇤" span={12}>
          <p className="viz-empty">{data.note ?? 'no VPN egress declared'}</p>
        </Board>
      </BoardGrid>
    )
  }

  const expiryTone: Tone | undefined =
    t.expiryDays < 0 ? 'bad' : t.expiryDays < 30 ? 'warn' : undefined

  return (
    <>
      <ServiceHead
        logo="/icon-gluetun.svg"
        // The SOFTWARE, not the selected tunnel: everything in the header —
        // the build, the verdict, the sentence — is identical whichever tunnel
        // is chosen, and the tunnel's own identity is a row of its own below,
        // next to the switch that picks it.
        name="VPN egress"
        version={data.gluetun.running}
        versionNote={
          data.gluetun.builtOn === null
            ? 'the gluetun build every tunnel runs'
            : `built ${data.gluetun.builtOn} · every tunnel runs it`
        }
        verdict={
          data.gluetun.running === null
            ? { label: 'unknown', tone: 'muted' }
            : data.gluetun.behind.length === 0
              ? { label: 'current', tone: 'ok' }
              : { label: `${String(data.gluetun.behind.length)} behind`, tone: 'warn' }
        }
        compare={[
          {
            k: 'Tunnels',
            v: String(data.tunnels.length),
            note: 'each its own key and its own exit — declared in fleet.vpnEgress',
          },
          { k: 'Pinned by', v: null, note: 'one image digest in platform/gluetun-lib.nix' },
        ]}
        lede={
          <>
            gluetun holds a WireGuard tunnel and owns a network namespace; the containers behind one
            borrow it outright rather than having interfaces of their own. It is fail-closed, so a
            tunnel that drops takes their internet with it — which is the point, and the reason this
            page exists.
          </>
        }
      />
      <LinkRow
        links={[
          { label: 'gluetun', href: 'https://github.com/qdm12/gluetun' },
          { label: 'ProtonVPN account', href: 'https://account.protonvpn.com/downloads' },
        ]}
      />

      {/* The SOFTWARE first, because it is shared: however many tunnels this
          page grows, `mkGluetunInstance` pins one gluetun digest and one
          exporter digest, so both builds are the same on every one of them.
          Repeating them per tunnel would print the same answer twice and
          invite the reader to check whether they differ. */}
      <BoardGrid>
        <Changelog
          build={data.gluetun}
          span={6}
          title={
            data.gluetun.behind.length === 0
              ? 'gluetun — current'
              : `gluetun — ${String(data.gluetun.behind.length)} commits behind`
          }
          aside={
            <span className="board-note">
              {data.gluetun.running === null ? (
                'build unknown'
              ) : (
                <span className="mono">{data.gluetun.running}</span>
              )}
              {data.gluetun.builtOn !== null && ` · built ${data.gluetun.builtOn}`}
            </span>
          }
          foot={
            <p className="board-foot">
              {/* Why this is not the release-notes panel every other service
                  gets — a correctness point, not a shortcut. */}
              Commits, not releases, and deliberately: this image is a digest-pinned{' '}
              <code>:latest</code>, which is master, and master has <b>diverged</b> from the v3.41.x
              release line — v3.41.2 ships an acknowledged port-forwarding deadlock this box would
              trip, because it sets <code>VPN_PORT_FORWARDING_UP_COMMAND</code>. A release list here
              would advise a downgrade into a known bug. The build is read out of gluetun’s own
              startup banner in Loki, since <code>/v1/version</code> is not in the control-server
              allow list and widening it would restart the tunnel.
            </p>
          }
        />

        <Changelog
          gap={data.exporter}
          span={6}
          title="gluetun-exporter"
          aside={<span className="board-note">version unknowable</span>}
          foot={
            <p className="board-foot">
              What has been <b>published</b>. Which of it is running cannot be said: the image is a
              digest-pinned <code>:latest</code> and the exporter prints no version in its log,
              serves none on <code>/metrics</code>, and has no endpoint that would answer. So this
              is the honest half — a release exists, and comparing it to what is here is a manual
              job. It polls each tunnel’s control API every 30 seconds and is what the VPN-down
              alert reads.
            </p>
          }
        />
      </BoardGrid>

      {/* Everything below is per TUNNEL — including the logs, which are the
          one thing here that genuinely differs between them. The switch sits
          on the boundary rather than in the header, so it is visibly the thing
          that governs what follows it and not what precedes it. */}
      <div className="tunnel-bar">
        {/* What the switch cannot say, and only that: where the selected
            tunnel comes out. Its name and its health are on the button. */}
        <span className="tunnel-id">
          <span className="mono">{t.exit.ip ?? DASH}</span>
          <span>{flag(t.exit.country)}</span>
          {t.portForwarding && t.port !== null && <span>port {t.port}</span>}
        </span>
        {data.tunnels.length > 1 && (
          <Segmented
            value={t.key}
            onChange={setSelected}
            options={data.tunnels.map((x) => ({
              value: x.key,
              // `gluetun` is the downloads one, historically unprefixed.
              label: x.container.replace(/^gluetun-?/, '') || 'downloads',
              dot: tone(x.up),
            }))}
          />
        )}
      </div>

      <BoardGrid>
        <Board
          title="Staying up"
          icon="⛨"
          span={8}
          aside={
            <span className="board-live">
              <Pulse on={t.up === true} tone={t.up === true ? 'ok' : 'bad'} />
              {t.up === null ? 'unknown' : t.up ? 'tunnel up' : 'tunnel down'}
            </span>
          }
        >
          <Measures
            items={[
              { k: '7 days', v: t.uptime7d === null ? DASH : pct(t.uptime7d * 100, 2) },
              {
                k: 'key expires',
                v: t.expiryDays < 0 ? `${String(-t.expiryDays)}d ago` : until(t.expiryDays * 86400),
                tone: expiryTone,
              },
              ...(t.portForwarding
                ? [{ k: 'forwarded port', v: t.port === null ? 'none yet' : String(t.port) }]
                : []),
            ]}
          />

          <Columns
            points={t.daily.map((d) => ({
              label: d.date.slice(5),
              value: d.uptime,
              display: `${pct(d.uptime * 100, 2)} up`,
              flag: d.uptime < 0.999,
            }))}
            tone="ok"
            height={112}
            empty="no history yet"
          />
          {t.daily.length > 0 && (
            <p className="colaxis">
              <span>{t.daily[0]?.date.slice(5)}</span>
              <span>share of the day connected</span>
              <span>{t.daily[t.daily.length - 1]?.date.slice(5)}</span>
            </p>
          )}

          <p className="board-foot">
            {/* A near-full column is the normal state, so the axis starting at
                zero is the honest choice AND the useless one — the flag is what
                carries a bad day. */}
            gluetun reports its own tunnel state every 30 seconds; this is the share of each day it
            said it was connected. Columns are near-full by design — a day that dropped at all is
            underlined in red rather than left to a difference of a pixel. The WireGuard key expires{' '}
            <b>{t.keyExpiry}</b>, reminder mail goes out 30 and 7 days ahead, and the renewal
            runbook is the header of <code>{t.runbook}</code>.
          </p>
        </Board>

        <Board
          title="What rides it"
          icon="◫"
          span={4}
          aside={<span className="board-note">{t.tenants.length} containers</span>}
        >
          <ul className="itemlist">
            {t.tenants.map((c) => (
              <li key={c.name}>
                <Chip tone={c.up === null ? 'muted' : c.up ? 'ok' : 'bad'}>
                  {c.up === null ? '?' : c.up ? 'up' : 'down'}
                </Chip>
                <span className="item-main mono">{c.name}</span>
              </li>
            ))}
          </ul>
          <p className="board-foot">
            Read from each container’s own <code>--network=container:{t.container}</code>, so this
            is the set that actually shares the namespace rather than a list kept beside it. They
            publish no ports of their own — only a namespace’s owner can — which is why every one of
            their UIs is published on the gluetun container instead.
          </p>
        </Board>

        <Board
          title="Where it comes out"
          icon="◍"
          span={12}
          aside={
            <span className="board-brand">
              <img src="/icon-protonvpn.svg" alt="" width={16} height={16} />
              {t.provider}
            </span>
          }
        >
          <Facts
            rows={[
              // `flag` already emits the country name beside the emoji.
              { k: 'Country', v: flag(t.exit.country) },
              { k: 'City', v: place(t.exit.city, t.exit.region) },
              { k: 'Address', v: <span className="mono">{t.exit.ip ?? DASH}</span> },
              { k: 'Carrier', v: t.exit.org ?? DASH },
              { k: 'Timezone', v: t.exit.timezone ?? DASH },
            ]}
          />
          <p className="board-foot">
            Asked of gluetun’s control API, which asks the provider — nothing on this box can answer
            it, because the container only ever sees a private tunnel address and the exit is only
            knowable from outside. The carrier is what an observer on the far side actually
            attributes this traffic to.
          </p>
        </Board>

        {/* The exporter is the one container genuinely tied to this tunnel and
            nothing else: it exists solely to poll this gluetun's control API,
            it shares its namespace, and it is where "the VPN alerts went
            quiet" is answered. */}
        <LogBoard
          source={{ container: t.container }}
          title={`${t.container} logs`}
          neighbours={[
            {
              source: { container: t.exporter },
              label: 'Exporter',
              role: 'the process the VPN alerts read',
              note: 'Polls this tunnel’s control API every 30 seconds and serves the gluetun_vpn_status and forwarded-port metrics behind the chart above and the VPN-down alert. If those go stale while the tunnel is fine, the answer is here — a wedged gluetun reads as "Up 4 days" with its ports listed while nothing is listening.',
            },
          ]}
        />
      </BoardGrid>
    </>
  )
}

// ── The proxy ──────────────────────────────────────────────────────────────

// One page, one subject. Pocket ID shared this tab and has a category of its
// own now: they were paired because the routing table joins them, and that
// join is still here — the protection column below is drawn from the IdP's
// client list — but a join is a reason for a column, not for a second header
// and a switch above it.
type Proxy = Extract<NetworkData, { tab: 'proxy' }>

/** How each protection class reads, and in what order the table groups them. */
const PROTECTION: Record<
  Proxy['routes'][number]['protection'],
  { title: string; note: string; tone: Tone }
> = {
  app: {
    title: 'The app decides',
    note: 'traefik routes these straight through. Whatever login they have is their own, and this page cannot see it — several of them do have one.',
    tone: 'muted',
  },
  gate: {
    title: 'Behind the gate',
    note: 'A forward-auth middleware. The request goes to Pocket ID first and only reaches the app once it has come back authenticated, so the app never sees an anonymous request at all.',
    tone: 'ok',
  },
  client: {
    title: 'Signs in against Pocket ID itself',
    note: 'No middleware — the app is a registered OIDC client and runs the login itself, which means it also decides what an unauthenticated request gets.',
    tone: 'info',
  },
}

/**
 * traefik: what is published, and what it did with it.
 *
 * The routing table leads because it is the one thing here that exists
 * nowhere else — nix declares the intent, and this is what traefik actually
 * built out of it, including the routers it refused.
 */
function TraefikView({ d }: { d: Proxy }) {
  const { traffic, counts } = d
  const busy = traffic.rpm !== null && traffic.rpm > 0
  const groups = (['app', 'gate', 'client'] as const)
    .map((p) => ({ p, rows: d.routes.filter((r) => r.protection === p) }))
    .filter((g) => g.rows.length > 0)
  const remote = d.routes.filter((r) => r.remote).length

  return (
    <>
      <ServiceHead
        logo="/icon-traefik.svg"
        name="Traefik"
        version={d.version}
        versionNote={
          d.codename === null ? 'from its own API' : `“${d.codename}” · from its own API`
        }
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
            // Worth stating: every other version on this dashboard is the tag
            // the flake pinned, which is what was ASKED for.
            note: 'the running process, not the tag in the flake',
          },
        ]}
        lede={
          <>
            Every hostname on this box resolves to one process, and this is it. It terminates the
            TLS, picks a container by the name in the request, and — for about half of them — asks
            Pocket ID whether the request should go any further.
          </>
        }
        actions={
          <a
            className="btn btn-primary"
            href="https://traefik.toscanini.me/dashboard/"
            target="_blank"
            rel="noreferrer"
          >
            Open the dashboard ↗
          </a>
        }
      />
      <LinkRow
        links={[
          { label: 'Docs', href: 'https://doc.traefik.io/traefik/' },
          { label: 'GitHub', href: 'https://github.com/traefik/traefik' },
        ]}
      />

      <BoardGrid>
        <Board
          title="What is published, and what protects it"
          icon="⇄"
          span={12}
          aside={
            <span className="board-note">
              {d.routes.length} hostnames · {remote} also off-LAN
            </span>
          }
        >
          {groups.map((g) => (
            <section key={g.p} className="routes-group">
              <h4 className="board-sub">
                {PROTECTION[g.p].title}
                <Chip tone={PROTECTION[g.p].tone}>{g.rows.length}</Chip>
              </h4>
              <ul className="itemlist routes">
                {g.rows.map((r) => (
                  <li key={r.host} title={r.via ?? undefined}>
                    <span className="item-main mono">{stripBaseDomain(r.host)}</span>
                    {/* The chip is the whole point of the row: off-LAN means
                        the internet can ask, and the protection column beside
                        it says what answers. */}
                    {r.remote && <Chip tone="warn">off-LAN</Chip>}
                    {r.disabled && <Chip tone="bad">disabled</Chip>}
                    {/* An em dash is not zero: traefik labels no request
                        counters for its own dashboard's router, and a 0 there
                        would read as "nobody has opened it". */}
                    <span className="item-n">
                      {r.requests === null ? DASH : compact(r.requests)}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="board-foot">{PROTECTION[g.p].note}</p>
            </section>
          ))}

          <p className="board-foot">
            One row per hostname rather than per router, because a name published both on the LAN
            and through the tunnel is two routers for one thing. Read from the configuration traefik
            actually built — not from what the flake asked for, which is the point of looking. The
            count on the right is requests over {d.windowDays} days.
            {counts.errors > 0 && (
              <>
                {' '}
                <b>
                  {num(counts.errors)} piece{counts.errors === 1 ? '' : 's'} of configuration failed
                  to build
                </b>{' '}
                — a router that does not exist answers nothing, quietly.
              </>
            )}
          </p>
        </Board>

        <Board
          title="Traffic"
          icon="◇"
          span={9}
          aside={
            <span className="board-live">
              <Pulse on={busy} tone="accent" />
              {busy ? `${num(traffic.rpm)}/min` : 'idle'}
            </span>
          }
        >
          <Measures
            items={[
              { k: 'open connections', v: num(traffic.open) },
              // p95 of the SERVICE duration, which is the app answering. Named
              // for what it measures so nobody reads it as proxy overhead.
              { k: 'backends, p95', v: ms(traffic.p95Ms) },
              { k: 'routers', v: num(counts.routers) },
              { k: 'config read', v: since(d.config.reloadedAgo) },
            ]}
          />

          <Columns
            points={traffic.daily.map((p) => ({
              label: p.date.slice(5),
              value: p.requests,
              display: `${num(p.requests)} requests`,
            }))}
            height={112}
            empty="nothing scraped yet"
          />
          {traffic.daily.length > 0 && (
            <p className="colaxis">
              <span>{traffic.daily[0]?.date.slice(5)}</span>
              <span>requests per day</span>
              <span>{traffic.daily[traffic.daily.length - 1]?.date.slice(5)}</span>
            </p>
          )}

          {traffic.byEntrypoint.length > 0 && (
            <p className="board-foot">
              <span className="endpoints">
                {traffic.byEntrypoint.map((e) => (
                  <span key={e.label}>
                    {e.label === 'websecure' ? 'LAN' : e.label === 'cfweb' ? 'tunnel' : e.label}{' '}
                    <b>{compact(e.value)}</b>
                  </span>
                ))}
              </span>
              Split by entrypoint over {d.windowDays} days. The gap is the shape of this box: almost
              everything is asked from inside the house, and what the tunnel carries is the handful
              of services deliberately published to the internet.
            </p>
          )}
        </Board>

        <Board
          title="Certificates"
          icon="⌸"
          span={3}
          aside={<span className="board-note">the store</span>}
        >
          <ul className="certs">
            {d.certs.map((c) => (
              <li key={c.cn} className="certs-row" title={c.sans.join(', ')}>
                <span className="certs-name mono">{c.cn}</span>
                {/* 90 days is Let's Encrypt's full lifetime, so the bar reads
                    as how much of this certificate is left. */}
                <Progress
                  pct={Math.min(100, (c.days / 90) * 100)}
                  tone={c.days < 14 ? 'bad' : c.days < 30 ? 'warn' : 'ok'}
                />
                <span className="certs-days">{c.days.toFixed(0)}d</span>
              </li>
            ))}
          </ul>
          {d.certs.length === 0 && <p className="viz-empty">no certificate in the store</p>}

          {/* The join worth making on a page that has both: a certificate is
              only worth renewing if something published matches it, and traefik
              renews whatever is in the store regardless. */}
          <p className="board-foot">
            {d.certs.map((c) => (
              <span key={c.cn} className="endpoints">
                <span>
                  <b>{c.cn}</b>{' '}
                  {c.covers === 0
                    ? 'answers for nothing published here'
                    : `covers ${String(c.covers)} of the ${String(d.routes.length)} published names`}
                </span>
              </span>
            ))}
          </p>

          {d.tls.length > 0 && (
            <Facts
              rows={d.tls.map((t) => ({
                k: `TLS ${t.version}`,
                v: `${t.share.toFixed(t.share > 99 ? 0 : 1)}% of requests`,
              }))}
            />
          )}

          {/* A quarter of the width now, so this keeps the two facts that
              change how the list is read and drops the tour. */}
          <p className="board-foot">
            The store, not a probe — <b>every</b> certificate this box serves HTTPS with is here,
            and one wildcard is why that is a short list. Issued over DNS-01 against Cloudflare, so
            a renewal needs nothing reachable from the internet.{' '}
            {d.certs.some((c) => c.covers === 0) && (
              <>
                One covering nothing is a leftover: traefik renews what it holds rather than what is
                declared, so an old certificate stays in <code>acme.json</code> until it is taken
                out.
              </>
            )}
          </p>
        </Board>

        <Board
          title="Where it goes"
          icon="⌗"
          span={3}
          aside={<span className="board-note">req/min, 1h</span>}
        >
          <BarList
            items={traffic.byService.map((s) => ({
              label: s.label,
              value: s.value,
              display: s.value.toFixed(1),
            }))}
            empty="no traffic"
          />
          <CodeBreakdown codes={traffic.byCode} />
        </Board>

        <Changelog gap={d.gap} span={9} />

        {/* No neighbours. cloudflared dials the cfweb entrypoint and is the
            obvious candidate, but it has its own page one tab over — and a
            second copy of a log stream is not a second source. */}
        <LogBoard
          source={{ container: 'traefik' }}
          title="Traefik logs"
          foot={
            <p className="board-foot">
              The service log, not the access log: startup, certificate renewals, configuration
              reloads and the errors behind a router that refused to build. Per-request lines go to
              the access log, which is not shipped here — the metrics above are what that answers.
            </p>
          }
        />
      </BoardGrid>
    </>
  )
}

/**
 * Response codes: one line by default, seventeen bars on request.
 *
 * Seventeen distinct codes in a day is normal for a proxy in front of forty
 * services, and as a bar list it was three times the height of the panel
 * beside it, which is where the hole under the traffic chart came from.
 *
 * The summary is not a teaser for the list, it is the answer: the question
 * anybody brings to a status-code panel is "is anything broken", and that is
 * the class totals. The individual codes matter once the answer is yes, and
 * that is what opening it is for.
 */
function CodeBreakdown({ codes }: { codes: { label: string; value: number }[] }) {
  if (codes.length === 0) return <p className="viz-empty">no traffic</p>

  const classes = (['2', '3', '4', '5'] as const).map((c) => ({
    c,
    total: codes.filter((x) => x.label.startsWith(c)).reduce((n, x) => n + x.value, 0),
  }))
  // Code 0 is traefik's "the client hung up before an answer was written",
  // which is neither a success nor a server fault and belongs in neither bucket.
  const dropped = codes.filter((x) => x.label === '0').reduce((n, x) => n + x.value, 0)

  return (
    <details className="codes">
      <summary>
        <span className="board-sub">Response codes, 24h</span>
        <span className="codes-digest">
          {classes
            .filter((x) => x.total > 0)
            .map((x) => (
              <span key={x.c} className={`code-${x.c}xx`}>
                {x.c}xx <b>{compact(x.total)}</b>
              </span>
            ))}
          {dropped > 0 && (
            <span className="code-0" title="Client hung up before an answer was written">
              no reply <b>{compact(dropped)}</b>
            </span>
          )}
        </span>
      </summary>
      <BarList
        items={codes.map((c) => ({
          label: c.label === '0' ? 'no reply' : c.label,
          value: c.value,
          display: compact(c.value),
          tone: codeTone(c.label),
        }))}
        empty="no traffic"
      />
      <p className="board-foot">
        {/* 401 is the gate working, not a fault, and on a box where half the
            routers forward-auth it is one of the commonest codes. */}
        A 401 is usually the gate doing its job — a request arriving without a session, on its way
        to the login.
      </p>
    </details>
  )
}

/* The audit log's event names were translated here — "signed in", "opened",
   "first time" — for a raw stream that no longer exists. Nothing renders a
   verb now: the aggregates say which verb they counted, and the only events
   still shown are one kind, inside the row they belong to. */

/**
 * "Miami, Florida" — but not "Zürich, Zurich".
 *
 * A city-state's region is its city under a different spelling, and the
 * provider reports both. Compared with diacritics stripped, because that IS
 * the difference in the case that matters.
 */
function place(city: string | null, region: string | null): string {
  const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  if (city === null || city === '') return region ?? DASH
  if (region === null || region === '' || fold(region) === fold(city)) return city
  return `${city}, ${region}`
}

/**
 * The Cloudflare tunnel, from both ends.
 *
 * Cloudflare knows what the edge sees; cloudflared knows what this box sent.
 * The panel that matters is the second one: `published` is every hostname the
 * tunnel will answer for, which is the literal answer to "what of this house
 * is reachable from the internet" — a question no other page here asks, and
 * one whose wrong answer is a service exposed by accident.
 */
function CfTunnelView({ t }: { t: Inbound['tunnel'] }) {
  const healthy = t.status === 'healthy'

  return (
    <>
      <ServiceHead
        logo="/icon-cloudflare.svg"
        name="Cloudflare tunnel"
        version={t.version}
        versionNote="cloudflared, as the edge reports it"
        verdict={verdictOf(t.gap)}
        compare={[
          {
            k: 'Latest',
            v: t.gap.latest,
            note:
              t.gap.latest === null
                ? 'GitHub did not answer'
                : t.gap.behind.length === 0
                  ? 'this is what is running'
                  : `${String(t.gap.behind.length)} release${t.gap.behind.length === 1 ? '' : 's'} between them`,
          },
          { k: 'Pinned by', v: null, note: 'a digest in stacks/cloudflared' },
        ]}
        lede={
          <>
            An <b>outbound</b> connection cloudflared holds open to Cloudflare, which the edge then
            reaches this box through. So the router never accepts an inbound connection for it — no
            forwarded port, nothing to scan — and everything it carries is HTTP, terminated at
            traefik’s <code>cfweb</code> entrypoint on plain HTTP because the edge already did TLS.
          </>
        }
        actions={
          <a
            className="btn btn-primary"
            href="https://one.dash.cloudflare.com/"
            target="_blank"
            rel="noreferrer"
          >
            Cloudflare dashboard ↗
          </a>
        }
      />
      <LinkRow
        links={[
          { label: 'cloudflared', href: 'https://github.com/cloudflare/cloudflared' },
          {
            label: 'Docs',
            href: 'https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/',
          },
        ]}
      />

      <BoardGrid>
        <Board
          title="Holding the tunnel"
          icon="⇥"
          span={8}
          aside={
            <span className="board-live">
              <Pulse on={healthy} tone={healthy ? 'ok' : 'bad'} />
              {t.status ?? 'unknown'}
            </span>
          }
        >
          <Measures
            items={[
              { k: 'connections', v: num(t.connections) },
              { k: 'edge round trip', v: ms(t.rttMs) },
              { k: 'held for', v: since(t.heldForSeconds).replace(' ago', '') },
              {
                k: 'errors',
                v: num(t.errors),
                tone: t.errors !== null && t.errors > 0 ? 'bad' : undefined,
              },
            ]}
          />

          <Columns
            points={t.daily.map((d) => ({
              label: d.date.slice(5),
              value: d.requests,
              display: `${num(d.requests)} request${d.requests === 1 ? '' : 's'}`,
            }))}
            height={112}
            empty="no history yet"
          />
          {t.daily.length > 0 && (
            <p className="colaxis">
              <span>{t.daily[0]?.date.slice(5)}</span>
              <span>requests from outside, per day</span>
              <span>{t.daily[t.daily.length - 1]?.date.slice(5)}</span>
            </p>
          )}

          <p className="board-foot">
            Four connections into{' '}
            {t.edges.length === 0
              ? 'the edge'
              : t.edges.map((e) => `${e.colo}×${String(e.count)}`).join(' · ')}{' '}
            — two datacentres, so losing one is a reconnect rather than an outage. The counts are
            small on purpose: almost everything here is reached over the LAN, and the tunnel only
            carries what is genuinely away from home. <b>Held for</b> is the oldest connection, not
            the newest, since the newest may have rotated seconds ago and says nothing.
          </p>
        </Board>

        <Board
          title="Published to the world"
          icon="◍"
          span={4}
          aside={<span className="board-note">{t.published.length} hostnames</span>}
        >
          {t.published.length === 0 ? (
            <p className="viz-empty">could not read the tunnel’s ingress rules</p>
          ) : (
            <ul className="itemlist">
              {t.published.map((p) => (
                <li key={p.hostname}>
                  <span className="item-main">{stripBaseDomain(p.hostname)}</span>
                  <span className="item-side mono">{p.service.replace(/^https?:\/\//, '')}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="board-foot">
            Read back from the tunnel’s own ingress rules, which is the only list that decides
            anything — a hostname here is reachable from the internet, and one that is not here is
            not, whatever DNS says. Every entry is generated by a{' '}
            <code>webApps.exposeRemotely</code>, so this is that decision as Cloudflare received it.
            They all point at the same place: traefik’s plain-HTTP <code>cfweb</code> entrypoint.
          </p>
        </Board>

        <Changelog gap={t.gap} />

        <LogBoard
          source={{ container: 'cloudflared' }}
          title="cloudflared logs"
          neighbours={[
            {
              source: { unit: 'cloudflared-route-sync.service' },
              label: 'Route sync',
              role: 'what puts the public names in the zone',
              note: 'A oneshot that upserts one CNAME per fleet.cloudflareRoutes entry into the Cloudflare zone. The tunnel coming up proves nothing about whether a hostname resolves to it — a route declared in nix whose CNAME was never written is this unit having failed, and it is invisible from the tunnel’s own log.',
            },
          ]}
        />
      </BoardGrid>
    </>
  )
}

/**
 * The address, and whether anything still points at it.
 *
 * This page exists because the failure is silent in both directions: a home
 * connection's address changes with no notice, and ddclient failing to notice
 * exits 0. Nothing alerts, nothing logs an error a human would see, and the
 * first symptom is somebody unable to join a Factorio game.
 */
function DdnsView({ d }: { d: Inbound['ddns'] }) {
  const known = d.resolved !== null && d.actual !== null
  const match = known && d.resolved === d.actual

  return (
    <>
      <ServiceHead
        logo="/icon-cloudflare.svg"
        name="Direct"
        version={d.resolved}
        versionNote={`${d.host} — what the world resolves it to`}
        verdict={
          !known
            ? { label: 'unknown', tone: 'muted' }
            : match
              ? { label: 'pointing here', tone: 'ok' }
              : { label: 'stale', tone: 'bad' }
        }
        compare={[
          { k: 'Actually here', v: d.actual, note: 'the address the tunnel reports arriving from' },
          {
            k: 'Kept current by',
            v: `ddclient ${d.version ?? ''}`.trim(),
            note: 'platform/ddclient, every 5 minutes',
          },
        ]}
        lede={
          <>
            No proxy at all — the house’s own address. The tunnel carries HTTP and nothing else, so
            anything speaking another protocol has to be dialled directly, and a home connection’s
            address moves. ddclient is what keeps <code>{d.host}</code> pointed at it.
          </>
        }
      />
      <LinkRow
        links={[
          { label: 'ddclient', href: 'https://github.com/ddclient/ddclient' },
          { label: 'The record', href: `https://dash.cloudflare.com/` },
        ]}
      />

      <BoardGrid>
        <Board
          title="Is the name right"
          icon="◎"
          span={8}
          aside={
            <span className="board-live">
              <Pulse on={match} tone={known && !match ? 'bad' : 'ok'} />
              {!known ? 'cannot tell' : match ? 'matches' : 'does not match'}
            </span>
          }
        >
          <Measures
            items={[
              { k: 'resolves to', v: d.resolved ?? DASH },
              {
                k: 'actually here',
                v: d.actual ?? DASH,
                tone: known && !match ? 'bad' : undefined,
              },
              { k: 'record ttl', v: d.ttl === null ? DASH : until(d.ttl) },
              {
                k: 'rechecked every',
                v: d.intervalSeconds === null ? DASH : until(d.intervalSeconds),
              },
            ]}
          />

          <p className="board-foot">
            {match ? (
              <>
                The name resolves to the address the tunnel reports traffic arriving from, so
                everything below can be reached.{' '}
              </>
            ) : known ? (
              <>
                <b>They disagree.</b> The name is pointing somewhere this box is not, so everything
                below is unreachable from outside until ddclient catches up — its next run is within{' '}
                {d.intervalSeconds === null ? 'five minutes' : until(d.intervalSeconds)}.{' '}
              </>
            ) : (
              <>One of the two could not be read, so this check is not currently making a claim. </>
            )}
            Asked of <code>1.1.1.1</code> over HTTPS rather than this box’s resolver, deliberately:
            pi-hole short-circuits <code>*.{BASE_DOMAIN}</code> to the LAN address, which is right
            and would make this check answer itself.
          </p>

          {/* The failure that has no other symptom. Counted from the log
              because the unit exits 0 either way. */}
          {(d.lookupFailures.month ?? 0) > 0 && (
            <p className="rejected">
              ddclient could not work out this house’s address <b>{num(d.lookupFailures.day)}</b>{' '}
              times in the last day, <b>{num(d.lookupFailures.week)}</b> in the week and{' '}
              <b>{num(d.lookupFailures.month)}</b> in the month — its lookup against{' '}
              <code>cloudflare.com/cdn-cgi/trace</code> got no answer. Each run that fails publishes
              nothing, so a real address change during one would not be noticed until the next
              success.{' '}
              {d.monitored
                ? 'It is in fleet.monitoredJobs, so a failure mails you.'
                : 'The unit still exits 0, so nothing alerts on it — including the OnFailure hook it does not have.'}
            </p>
          )}
        </Board>

        <Board
          title="What needs it"
          icon="⇥"
          span={4}
          aside={<span className="board-note">router-forwarded</span>}
        >
          {d.needs.length === 0 ? (
            <p className="viz-empty">nothing declares a direct port</p>
          ) : (
            <ul className="itemlist">
              {d.needs.map((n) => (
                <li key={n.name} title={n.note}>
                  <Chip tone="info">{n.proto}</Chip>
                  <span className="item-main">{n.name}</span>
                  <span className="item-side mono">{n.port}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="board-foot">
            From <code>fleet.directIngress</code>, which each service declares beside its own
            firewall rule. This is the one registry on the box recording something nix does not own
            — the router’s port-forward table lives in the router — and it is written next to the
            service so that removing the service takes the note with it. Everything else reaches
            this house through the tunnel and needs no address at all.
          </p>
        </Board>

        <Board
          title="The address, over time"
          icon="◷"
          span={6}
          aside={<Countdown at={d.nextRunAt} />}
        >
          {d.history.length === 0 ? (
            <p className="viz-empty">no change recorded in the log window</p>
          ) : (
            <ul className="itemlist">
              {d.history.map((h) => (
                <li key={h.at}>
                  <span className="item-main mono">{h.ip}</span>
                  <span className="item-side">
                    {h.heldDays === null ? 'current' : `held ${String(h.heldDays)}d`} ·{' '}
                    {new Date(h.at).toLocaleDateString('en-CA')}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="board-foot">
            {/* The pattern is the useful part: the changes and the failures
                are the same event seen twice, which is worth saying because
                otherwise the failures above look random. */}
            ddclient writes a line only when it actually <b>changes</b> the record, so this is the
            change history exactly — nothing for the thousands of runs that found nothing to do.
            Every one of them lands around 04:00, which is the ISP renewing the lease; the failed
            lookups above cluster at the same hour, because the connection is down for the seconds
            it takes. Thirty days is the whole window — that is how long Loki keeps a line, not a
            choice made here.
          </p>
        </Board>

        <Changelog gap={d.gap} span={6} />

        <LogBoard
          source={{ unit: 'ddclient.service' }}
          title="ddclient logs"
          foot={
            <p className="board-foot">
              A systemd unit rather than a container — ddclient is host plumbing, so these are
              journal lines. It runs every{' '}
              {d.intervalSeconds === null ? 'five minutes' : until(d.intervalSeconds)} and says
              nothing at all on a successful run that changed nothing, which is most of them.
            </p>
          }
        />
      </BoardGrid>
    </>
  )
}

/**
 * A live countdown to the next run of a timer.
 *
 * The timer lives in systemd and this container cannot see it, so the moment
 * is derived on the server (last run + interval) and handed over as an
 * absolute instant. The ticking is client-side and starts only after mount:
 * `now` is null through the server render AND the first client render, so both
 * produce the same markup and hydration has nothing to disagree about. A
 * countdown computed from `Date.now()` during render is the classic way to
 * break that.
 *
 * mm:ss rather than one unit — a five-minute countdown reading "5 min" for
 * two and a half minutes is not a countdown.
 */
function Countdown({ at }: { at: number | null }) {
  const [now, setNow] = useState<number | null>(null)

  useEffect(() => {
    setNow(Date.now())
    const t = setInterval(() => {
      setNow(Date.now())
    }, 1000)
    return () => {
      clearInterval(t)
    }
  }, [])

  if (at === null) return <span className="board-note">next run unknown</span>

  const left = now === null ? null : Math.max(0, Math.round((at - now) / 1000))
  return (
    <span className="board-note">
      next check{' '}
      {left === null ? (
        'soon'
      ) : // Overdue is a real state worth showing rather than clamping away: the
      // timer fires a little late, and a run that is genuinely stuck reads
      // as a countdown that sat at zero.
      left === 0 ? (
        'due now'
      ) : (
        <span className="mono">
          {String(Math.floor(left / 60)).padStart(2, '0')}:{String(left % 60).padStart(2, '0')}
        </span>
      )}
    </span>
  )
}

// ── DNS ────────────────────────────────────────────────────────────────

type Dns = Extract<NetworkData, { tab: 'dns' }>
type Dhcp = Extract<NetworkData, { tab: 'dhcp' }>

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
function DnsView({ data }: { data: Dns }) {
  const [side, setSide] = useState<'resolver' | 'zone'>('resolver')
  const { resolver, zone } = data

  return (
    <>
      <div className="tunnel-bar">
        <Segmented
          value={side}
          onChange={setSide}
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
function DhcpView({ data }: { data: Dhcp }) {
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
            <a className="btn btn-primary" href={`${admin}/`} target="_blank" rel="noreferrer">
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
            <span className="board-note">
              {lan.length} entries · {lan.filter((n) => n.public).length} also public
            </span>
          }
        >
          <ul className="lan-names">
            {lan.map((n) => (
              <li key={n.fqdn} className={n.served === false ? 'lan-name is-broken' : 'lan-name'}>
                <span className="lan-host mono">{n.short}</span>
                {n.elsewhere && <span className="lan-ip mono">{n.ip}</span>}
                {n.public && <Chip tone="info">public</Chip>}
                {n.served === false && <Chip tone="bad">no route</Chip>}
              </li>
            ))}
          </ul>
          <p className="board-foot">
            The names this house answers for itself instead of asking anyone. Each one is an entry
            in pi-hole’s hosts file generated from the stack that owns it, so a name gets here by
            being declared and never by being typed into the admin — and nothing in this list can
            outlive the thing it points at. An address is printed only when the entry points
            somewhere other than this box. <b>public</b> marks the ones the zone publishes as well,
            which is the same set the other side of this tab lists, seen from outside.
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
            <span className="board-note">
              {queries.perSecond === null ? DASH : num(queries.perSecond, 1)}/s
            </span>
          }
        >
          <ul className="itemlist sources">
            {SOURCES.map((s) => (
              <li key={s.k}>
                <span className="item-main">{s.label}</span>
                <Progress pct={share(answered[s.k])} tone={s.tone} height={6} />
                <span className="item-n">{pct(share(answered[s.k]), 1)}</span>
              </li>
            ))}
          </ul>
          <p className="board-foot">
            {num(sum)} queries in the window FTL keeps in memory. Cache and the hosts file never
            left the box, which is the whole job — the forwarded slice is the only part any upstream
            sees.
          </p>

          <h4 className="board-sub">Upstreams</h4>
          <ul className="itemlist upstreams">
            {d.upstreams.map((u) => (
              <li key={u.ip}>
                <span className="item-main mono">{u.ip}</span>
                {!u.declared && <Chip tone="warn">not configured</Chip>}
                <span className="item-n">{u.replyMs === null ? DASH : ms(u.replyMs)}</span>
                <span className="item-side mono">{compact(u.count)}</span>
              </li>
            ))}
          </ul>
          <p className="board-foot">
            Mean round trip, as FTL measured it — what a page load waits for on a name nobody has
            asked for recently.
          </p>
        </Board>

        <Board
          title="Traffic"
          icon="⌁"
          span={8}
          aside={<span className="board-note">an hour per column</span>}
        >
          <Columns
            points={d.history.map((h) => ({
              label: h.label,
              value: h.total,
              display: `${num(h.total)} queries · ${num(h.forwarded)} forwarded`,
            }))}
            empty="pi-hole returned no history"
          />
          <p className="board-foot">
            The last day, busiest hour {num(busiest)}. A house at rest still asks thousands of
            questions an hour — most of it is background chatter from devices nobody is touching,
            which is why the cache share above is what it is.
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
          <p className="board-foot">
            The four that can go wrong quietly. Blocking is left off by a “disable for 5 minutes”
            nobody came back to; a cache with <i>evictions</i> is too small for the traffic, which
            expiries do not mean.
          </p>

          <details className="zone-group">
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
            <p className="board-foot">
              A and AAAA are one question asked twice — every modern client wants both addresses at
              once. PTR is reverse lookups, mostly this box naming its own LAN.
            </p>
          </details>

          <details className="zone-group">
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
            <p className="board-foot">
              Every query, with the client that asked and the domain it asked for. It is the most
              revealing file on the machine — the argument for the admin being behind the gate
              rather than behind a password.
            </p>
          </details>
        </Board>

        <Changelog gap={d.gap} span={12} />

        <LogBoard
          source={{ unit: 'pihole-ftl.service' }}
          title="pihole-FTL logs"
          foot={
            <p className="board-foot">
              Not the journal. FTL is the one service on this box that keeps its own log file, and
              the only journal lines about the unit come from systemd — so these are shipped out of{' '}
              <span className="mono">/var/log/pihole/FTL.log</span> by alloy. Startup, gravity runs,
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
        versionNote="registrar · from the registry’s RDAP"
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
            One domain name, and every hostname on this box is a label under it — which means one
            wildcard certificate, one tunnel, one set of OIDC redirect URIs and one expiry date. The
            zone lives at Cloudflare; the registration does not.
          </>
        }
        actions={
          <a
            className="btn btn-primary"
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

      {d.note !== null && <p className="viz-empty">{d.note}</p>}

      <BoardGrid>
        <Board
          title="This house, on the internet"
          icon="⌂"
          span={8}
          aside={
            <span className="board-note">
              {d.names.length} of {d.lanOnly + d.names.length} names that point here
            </span>
          }
        >
          <ul className="itemlist zone-names">
            {d.names.map((n) => (
              <li key={n.fqdn}>
                <span className="item-main mono">{n.short}</span>
                <Chip tone={n.away === 'tunnel' ? 'info' : 'warn'}>
                  {n.away === 'tunnel' ? 'tunnel' : 'this address'}
                </Chip>
                {n.proxied && <Chip tone="ok">proxied</Chip>}
                {!n.managed && <Chip tone="muted">by hand</Chip>}
                <span className="item-side">
                  {n.atHome ? 'answered on the LAN' : 'not short-circuited at home'}
                </span>
                <span className="item-n">{n.changedAgo === null ? DASH : since(n.changedAgo)}</span>
              </li>
            ))}
          </ul>
          <p className="board-foot">
            The names the zone points back here. Everything else — {d.lanOnly} of them — exists only
            in pi-hole, so the internet is told nothing about them at all and a request from outside
            the house never gets as far as the tunnel. A name <b>answered on the LAN</b> is
            short-circuited by pi-hole, which is what keeps traffic from the sofa from going out to
            Cloudflare and back in; <b>proxied</b> means Cloudflare answers with its own address, so
            this one is never published. The <b>tunnel</b> ones carry HTTP and only HTTP — the{' '}
            <span className="mono">this address</span> record is the WAN address itself, which is
            how anything speaking another protocol is reached and why it is deliberately not
            short-circuited.
          </p>

          {drift > 0 && (
            <div className="zone-drift">
              <h4 className="board-sub">
                Not in step
                <Chip tone="warn">{drift}</Chip>
              </h4>
              {d.drift.publishedWithoutLan.length > 0 && (
                <p className="board-foot">
                  <b>Published, but pi-hole does not answer for it:</b>{' '}
                  <span className="mono">{d.drift.publishedWithoutLan.join(', ')}</span> — reachable
                  at home only by going out to Cloudflare and back in.
                </p>
              )}
              {d.drift.lanWithoutRoute.length > 0 && (
                <p className="board-foot">
                  <b>pi-hole points these here and traefik has no router for them:</b>{' '}
                  <span className="mono">{d.drift.lanWithoutRoute.join(', ')}</span> — they resolve,
                  then land on the default certificate and 404.
                </p>
              )}
              {d.drift.tunnelWithoutApp.length > 0 && (
                <p className="board-foot">
                  <b>Tunnel records with nothing behind them:</b>{' '}
                  <span className="mono">{d.drift.tunnelWithoutApp.join(', ')}</span> — the
                  reconciler only sweeps records carrying its own comment, so these were made by
                  hand and it will not remove them.
                </p>
              )}
            </div>
          )}
        </Board>

        <Board
          title="The registration"
          icon="◷"
          span={4}
          aside={<span className="board-note">rdap</span>}
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
                    <span className={expiryVerdict(reg).tone === 'ok' ? 'ok-text' : 'warn-text'}>
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
                    <span className="ok-text">on</span>
                  ) : (
                    <span className="warn-text">off</span>
                  ),
              },
              {
                k: 'DNSSEC',
                v:
                  reg.signed === null ? (
                    DASH
                  ) : reg.signed ? (
                    <span className="ok-text">signed</span>
                  ) : (
                    <span className="muted-text">not signed</span>
                  ),
              },
              { k: 'Zone', v: d.cf.status ?? DASH },
              { k: 'Plan', v: d.cf.plan ?? DASH },
              { k: 'Records', v: d.cf.records === null ? DASH : num(d.cf.records) },
            ]}
          />
          <details className="zone-ns">
            <summary>Nameservers</summary>
            <ul className="itemlist">
              {reg.nameservers.map((n) => (
                <li key={n}>
                  <span className="item-main mono">{n}</span>
                </li>
              ))}
            </ul>
          </details>
          <p className="board-foot">
            {reg.note ??
              'The top half is the registry’s answer, not Cloudflare’s — the lock and the expiry live with the registrar and nothing on this box can see them. DNSSEC is read the same way: what matters is whether the parent zone holds a DS record, because until it does, nothing validates the signatures.'}
          </p>
        </Board>

        <Board
          title="Mail"
          icon="✉"
          span={6}
          aside={<span className="board-note">{d.mail.length} domains</span>}
        >
          {d.mail.length === 0 ? (
            <p className="viz-empty">no MX records in this zone</p>
          ) : (
            d.mail.map((m) => (
              <section key={m.domain} className="mail-domain">
                {/* Not `board-sub`: that heading is uppercased, and a domain
                    name and its mail exchangers are literal strings that are
                    wrong in capitals. */}
                <h4 className="mail-name mono">{m.domain}</h4>
                <p className="mail-mx mono">{m.mx.join(' · ') || 'no MX'}</p>
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
          <p className="board-foot">
            The {mailRecords} records behind this read as one policy: SPF says which servers may
            send as this domain, DKIM signs what they send, DMARC says what a receiver should do
            when neither holds. <b>quarantine</b> means spam folder rather than bounce, and{' '}
            <b>accepted, marked</b> is an SPF ending in <span className="mono">~all</span> — a
            forgery is flagged rather than refused. Both are the cautious settings, and both are
            worth tightening once nothing legitimate is being caught by them. Open a domain to check
            the reading against the records it came from.
          </p>
        </Board>

        <Board
          title="The rest of the zone"
          icon="≡"
          span={6}
          aside={
            d.leftovers.length > 0 ? (
              <Chip tone="warn">{d.leftovers.length} leftover</Chip>
            ) : (
              <span className="board-note">{d.elsewhere.length} records</span>
            )
          }
        >
          <RecordList
            records={d.elsewhere}
            summary="Pointed somewhere else"
            note="Names in this zone served by someone other than this box — a static site host, a CDN, and the verification records those asked for."
            open
          />
          <RecordList
            records={d.leftovers}
            summary="Leftovers"
            tone="warn"
            note="An _acme-challenge TXT is written during a certificate issuance and deleted when it finishes, so every one still in the zone belongs to an issuance that did not clean up — it proves nothing and grants nothing. Two pairs of them are also the same value entered twice, once quoted and once not."
          />
          <RecordList
            records={d.unclassified}
            summary="Everything else"
            tone="bad"
            note="Records none of the groups on this page claimed. The groups are rules — has an MX, is an _acme-challenge, points at the tunnel — and anything a rule set does not cover belongs here rather than nowhere."
            open
          />

          <p className="board-foot">
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
          aside={<span className="board-note">the zone keeps no log</span>}
        >
          <ul className="itemlist zone-changed">
            {d.changed.map((r) => (
              <li key={`${r.fqdn}-${r.type}-${r.content}`}>
                <span className="item-main mono">{r.short}</span>
                <Chip tone="muted">{r.type}</Chip>
                <span className="item-side mono">{r.content}</span>
                <span className="item-n">{r.changedAgo === null ? DASH : since(r.changedAgo)}</span>
              </li>
            ))}
          </ul>
          <p className="board-foot">
            The six most recently edited records. Cloudflare stamps every record with when it last
            changed but keeps no history of what it changed from, so this says when — never what,
            and never who.
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
    <details className="zone-group" open={open}>
      <summary>
        {summary}
        <Chip tone={tone}>{records.length}</Chip>
      </summary>
      <ul className="itemlist zone-records">
        {records.map((r) => (
          <li key={`${r.fqdn}-${r.type}-${r.content}`}>
            <span className="item-main mono">{r.short}</span>
            <Chip tone="muted">{r.type}</Chip>
            <span className="item-side mono">{r.content}</span>
          </li>
        ))}
      </ul>
      <p className="board-foot">{note}</p>
    </details>
  )
}
