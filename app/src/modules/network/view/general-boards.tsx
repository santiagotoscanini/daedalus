import type { LogNeighbour } from '../../../components/logs'
import { LogBoard } from '../../../components/logs'
import { Button } from '../../../components/ui/button'
import { BarList, Board, Chip, Facts, Measures, Pulse, Trend } from '../../../components/viz'
import { cn } from '../../../lib/cn'
import { bytes, compact, DASH, num, pct } from '../../../lib/format'
import type { General, GeneralFacts } from './general'
import { CAPTION, EMPTY, FOOT, MONO, MORE, NOTE, SUB } from './shared'

export function WhatCrossesTheCableBoard({ f }: { f: GeneralFacts }) {
  const { wire } = f
  return (
    <Board
      title="What crosses the cable"
      icon="⇅"
      span={8}
      aside={
        <span className={NOTE}>
          24 hours ·{' '}
          {wire.linkMbps === null ? 'one NIC' : `${num(wire.linkMbps / 1000, 1)} Gbps link`}
        </span>
      }
    >
      <h4 className={SUB}>Receiving, Mbps</h4>
      <Trend values={wire.inHistory} height={72} />
      <h4 className={SUB}>Sending, Mbps</h4>
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
      <p className={FOOT}>
        Every byte over this box’s one network interface, which is not the same thing as internet
        traffic and is usually much more of it. A film streamed to the TV crosses this cable in full
        and never leaves the house. The line’s own capacity is the board below; these two numbers
        are not comparable and are deliberately not on one chart.
      </p>
    </Board>
  )
}

export function TheWayOutBoard({ f }: { f: GeneralFacts }) {
  const { wire, hops, router, gateway, internet } = f
  return (
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
      {/* The one number on this page that cannot be read anywhere else on
          the box, so it gets the treatment of a headline rather than a
          table row. */}
      <div className="flex flex-col gap-0.5 rounded-xl border border-hairline bg-foreground/[0.03] px-4 py-3">
        <span className="text-[0.75rem] text-muted-foreground">Public address</span>
        <strong className="font-mono text-[1.4rem] leading-[1.2] tracking-[-0.02em] tabular-nums [font-weight:560]">
          {router.wan ?? DASH}
        </strong>
        <span className="text-[0.75rem] text-muted-foreground">
          {router.wanError ?? 'this house, as Cloudflare’s edge sees it arrive'}
        </span>
      </div>
      {/* One row per hop: a light, the name, the round trip, and six hours
          of it. The sparkline sits last and unlabelled on purpose — it is
          context for the number beside it, not a chart anyone reads on its
          own, and a heading would promote it above the reading that
          matters. */}
      <ul className="m-0 list-none p-0">
        {hops.map((h) => (
          <li
            key={h.id}
            className="grid grid-cols-[auto_1fr_auto_minmax(3rem,5rem)] items-center gap-2.5 py-2 not-first:border-t not-first:border-hairline"
          >
            <Pulse on={h.up === true} tone={h.up === true ? 'ok' : 'bad'} />
            <span className="text-[0.8rem] text-foreground">{h.label}</span>
            <span className={cn(MONO, 'text-[0.75rem] text-foreground tabular-nums')}>
              {rtt(h.rttMs)}
            </span>
            <Trend values={h.history} height={22} tone="muted" empty="" />
          </li>
        ))}
      </ul>
      <Facts
        rows={[
          { k: 'Default route', v: <span className={MONO}>{router.gateway}</span> },
          { k: 'This box', v: <span className={MONO}>{router.lan}</span> },
          {
            k: 'Link',
            v: wire.linkMbps === null ? DASH : `${num(wire.linkMbps)} Mbps negotiated`,
          },
        ]}
      />
      <p className={FOOT}>
        Two probes a minute rather than one: the router answering while the far side does not is the
        ISP, and neither answering is this box’s own link. The public address is the one fact that
        cannot be measured from inside. Behind NAT nothing here can see it, so it is read back from
        the edge the tunnel dials out to.
      </p>
    </Board>
  )
}

export function TheRouterBoard({ f }: { f: GeneralFacts }) {
  const { router, gateway } = f
  return (
    <Board
      title="The router"
      icon="hash"
      span={4}
      aside={
        <span className={NOTE}>
          {router.firmware === null ? 'not answering' : `firmware ${router.firmware}`}
        </span>
      }
    >
      {/* The picture earns its space by being the one panel on this page
          whose subject is a physical object in the house — everything else
          here is a counter. Sized to the type beside it rather than to the
          artwork, and it shrinks first when the column narrows. */}
      <div className="flex items-center gap-4 pb-1">
        <img
          className="h-auto w-[clamp(72px,34%,132px)] flex-none object-contain"
          src="/router-axe75.png"
          alt=""
          width={150}
          height={150}
        />
        <div className="flex min-w-0 flex-col items-start gap-1">
          <strong className="flex items-baseline gap-1.5 text-[1rem] tracking-[-0.01em] text-foreground [font-weight:600]">
            {router.model ?? 'Unknown'}
            {/* The hardware revision is part of the identity and never the
                thing you are looking for, so it rides the model at the size
                of a footnote. */}
            {router.hardware !== null && (
              <span className="text-[0.72rem] font-normal text-muted-foreground">
                {router.hardware}
              </span>
            )}
          </strong>
          <span className="text-[0.75rem] leading-[1.4] text-muted-foreground">
            {router.product}
          </span>
          <Button asChild size="sm" className="mt-1 self-start">
            <a href={router.adminUrl} target="_blank" rel="noreferrer">
              Open the admin ↗
            </a>
          </Button>
        </div>
      </div>
      <Facts
        rows={[
          { k: 'Firmware', v: <span className={MONO}>{router.firmware ?? DASH}</span> },
          { k: 'Built', v: router.built ?? DASH },
          { k: 'Address', v: <span className={MONO}>{router.gateway}</span> },
          { k: 'Round trip', v: rtt(gateway?.rttMs ?? null) },
        ]}
      />
      <p className={FOOT}>
        Read from the router, not typed here. It answers every configuration call with a login page
        — there is no API — but that page carries a build stamp in a meta tag, and the model,
        hardware revision, firmware and build date all come out of it. So a firmware update appears
        here on its own. The one thing the stamp does not carry is the name on the box, which is the
        only part of this panel that is declared.
      </p>
    </Board>
  )
}

export function WhichServicesMoveTheBytesBoard({ f }: { f: GeneralFacts }) {
  const { services, moved } = f
  return (
    <Board
      title="Which services move the bytes"
      icon="grid"
      span={8}
      aside={<span className={NOTE}>{bytes(moved)} over 24 hours</span>}
    >
      <TrafficList rows={services} />
      <p className={FOOT}>
        Counted inside each container’s own network namespace, so this is traffic the app itself
        moved rather than a share of the total guessed from anything. Two kinds are absent by
        construction and not by omission: a container on the host’s network has no figures separable
        from the box, and the ten sharing <b>gluetun</b>’s namespace have none separable from each
        other; gluetun’s row is the whole download stack, counted as it crossed the wire encrypted.
      </p>
    </Board>
  )
}

export function TheLineItselfBoard({ f }: { f: GeneralFacts }) {
  const { line } = f
  return (
    <Board
      title="The line itself"
      icon="◎"
      span={4}
      aside={<span className={NOTE}>7 days, hourly</span>}
    >
      <Measures
        items={[
          { k: 'Down', v: `${num(line.down)} Mbps` },
          { k: 'Up', v: `${num(line.up)} Mbps` },
          { k: 'Latency', v: `${num(line.ping, 1)} ms` },
        ]}
      />
      <h4 className={SUB}>Download, Mbps</h4>
      <Trend values={line.downHistory} height={64} />
      <h4 className={SUB}>Upload, Mbps</h4>
      <Trend values={line.upHistory} tone="info" height={48} />
      {/* The DNS side effect of the same test is told on the MySpeed log
          board below, not here. */}
      <p className={FOOT}>
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
  )
}

export function WhatThisHouseAsksForBoard({ f }: { f: GeneralFacts }) {
  const { dns } = f
  return (
    <Board
      title="What this house asks for"
      icon="◈"
      span={8}
      aside={<span className={NOTE}>{compact(dns.queries)} lookups today</span>}
    >
      <BarList items={dns.topDomains} tone="accent" empty="no queries recorded" />
      <p className={FOOT}>
        The names most looked up, which is the closest thing to a list of what this house depends on
        outside itself.
      </p>
      <p className={CAPTION}>
        {dns.fromBox === null || dns.queries === null
          ? 'Most of it is this box rather than the devices on the LAN.'
          : `${pct((dns.fromBox / dns.queries) * 100)} of it came from 127.0.0.1. Every container on this box resolves through the host’s stub, so pi-hole sees them as one client and no split by service is available from here.`}
      </p>
    </Board>
  )
}

export function MySpeedLogsBoard() {
  return (
    <LogBoard
      source={{ container: 'myspeed' }}
      title="MySpeed logs"
      neighbours={UPLINK_READERS}
      foot={
        <p className={FOOT}>
          The hourly speed test behind the capacity chart. It saturates the link while it runs,
          which is why nothing network-heavy is ever scheduled on the hour on this box. A test at
          :00 once took DNS down for two minutes for the whole house.
        </p>
      }
    />
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
  if (rows.length === 0) return <p className={EMPTY}>no per-container counters yet</p>

  const top = rows.slice(0, 12)
  const rest = rows.slice(12)
  const ceiling = Math.max(...rows.map((r) => r.in + r.out), 1)

  return (
    <>
      <ul className="m-0 list-none p-0">
        {top.map((r) => (
          <TrafficRow key={r.name} row={r} ceiling={ceiling} />
        ))}
      </ul>
      {rest.length > 0 && (
        <details className={MORE}>
          <summary>
            {rest.length} quieter container{rest.length === 1 ? '' : 's'}
          </summary>
          <ul className="m-0 list-none p-0">
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
    <li className="grid grid-cols-[minmax(4rem,10rem)_1fr_auto] items-center gap-2.5 py-1 text-[0.78rem]">
      <span className="truncate text-foreground" title={row.name}>
        {row.name}
      </span>
      <span className="flex h-1.5 min-w-0 overflow-hidden rounded-full bg-foreground/[0.08]">
        <span
          className="bg-primary"
          style={{ width: width(row.in) }}
          title={`${bytes(row.in)} in`}
        />
        <span
          className="bg-info"
          style={{ width: width(row.out) }}
          title={`${bytes(row.out)} out`}
        />
      </span>
      <span className={cn(MONO, 'text-[0.72rem] text-muted-foreground tabular-nums')}>
        {bytes(total)}
      </span>
    </li>
  )
}

/** Sub-millisecond on the LAN, single digits to the edge — decimals or nothing. */
export const rtt = (v: number | null) => (v === null ? DASH : `${num(v, v < 10 ? 2 : 0)} ms`)

/**
 * The two things that measure this tab's subject.
 *
 * Neither is a service anybody opens and neither will ever have a page, which
 * is exactly the case `LogNeighbour` exists for: a reading here that has
 * quietly stopped moving is indistinguishable from a quiet network, and one of
 * these two logs is the only place that difference is visible.
 */
export const UPLINK_READERS: readonly LogNeighbour[] = [
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
