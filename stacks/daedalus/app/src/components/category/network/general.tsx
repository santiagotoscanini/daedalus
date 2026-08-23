import type { NetworkData } from '../../../lib/dashboard/categories/network'
import { bytes, compact, DASH, num, pct } from '../../../lib/format'
import { LogBoard, type LogNeighbour } from '../../logs'
import { BarList, Board, BoardGrid, Chip, Facts, Measures, Pulse, Trend } from '../../viz'

type General = Extract<NetworkData, { tab: 'general' }>

/** Sub-millisecond on the LAN, single digits to the edge — decimals or nothing. */
const rtt = (v: number | null) => (v === null ? DASH : `${num(v, v < 10 ? 2 : 0)} ms`)

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
    note: 'Pings the gateway and the internet every 60s and publishes network_hop_up / network_hop_rtt_seconds, the two hops charted above. This tab’s status dot is computed from that pair, since there is no one service here for gatus to probe. It also walks the rootless cgroup tree for the per-container byte counters in the traffic panel.',
  },
  {
    source: { container: 'node-exporter' },
    label: 'node-exporter',
    role: 'the NIC counters themselves',
    note: 'Everything the cable chart is drawn from. It runs on --network=host so it sees enp3s0 rather than a container’s virtual interface, which is also why the bytes it reports include all LAN traffic and are not comparable to the line capacity measured next door.',
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
export function GeneralView({ data }: { data: General }) {
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
            internet traffic and is usually much more of it. A film streamed to the TV crosses this
            cable in full and never leaves the house. The line’s own capacity is the board below;
            these two numbers are not comparable and are deliberately not on one chart.
          </p>
        </Board>

        <Board
          title="The way out"
          icon="hash"
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
            fact that cannot be measured from inside. Behind NAT nothing here can see it, so it is
            read back from the edge the tunnel dials out to.
          </p>
        </Board>

        <Board
          title="The router"
          icon="hash"
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
          icon="grid"
          span={8}
          aside={<span className="board-note">{bytes(moved)} over 24 hours</span>}
        >
          <TrafficList rows={services} />
          <p className="board-foot">
            Counted inside each container’s own network namespace, so this is traffic the app itself
            moved rather than a share of the total guessed from anything. Two kinds are absent by
            construction and not by omission: a container on the host’s network has no figures
            separable from the box, and the ten sharing <b>gluetun</b>’s namespace have none
            separable from each other; gluetun’s row is the whole download stack, counted as it
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
              : `${pct((dns.fromBox / dns.queries) * 100)} of it came from 127.0.0.1. Every container on this box resolves through the host’s stub, so pi-hole sees them as one client and no split by service is available from here.`}
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
              which is why nothing network-heavy is ever scheduled on the hour on this box. A test
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
