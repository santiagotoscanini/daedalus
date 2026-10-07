import type { LogNeighbour } from '../../../components/logs'
import { LogBoard } from '../../../components/logs'
import { Button } from '../../../components/ui/button'
import { Board, Chip, Measures, Pulse, Trend } from '../../../components/viz'
import { cn } from '../../../lib/cn'
import { bytes, DASH, num } from '../../../lib/format'
import type { GeneralFacts } from './general'
import { FOOT, MONO, NOTE, Pairs } from './shared'

/** A chart's own head: what it draws on the left, its readings on the right. */
const CHART_HEAD = 'mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[0.75rem]'
/** The reading that leads a chart head: the rate right now. */
const CHART_NOW =
  'ml-auto text-[1.15rem] text-foreground tabular-nums tracking-[-0.015em] [font-weight:560]'
/** The quieter readings after it. */
const CHART_MORE = 'text-muted-foreground tabular-nums [&_b]:text-subdued [&_b]:[font-weight:520]'

/**
 * One direction of the cable: a label, the rate now as the lead reading, and
 * the day's peak and volume beside it — then the day as a line.
 */
function Direction({
  label,
  now,
  peak,
  day,
  values,
  tone,
}: {
  label: string
  now: number | null
  peak: number
  day: number | null
  values: number[]
  tone?: 'info'
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className={CHART_HEAD}>
        <span className="inline-flex items-center gap-1.5 text-subdued [font-weight:520]">
          <i
            className={cn('size-2 rounded-full', tone === 'info' ? 'bg-info' : 'bg-primary')}
            aria-hidden="true"
          />
          {label}
        </span>
        <span className={CHART_MORE}>
          peak <b>{num(peak, 1)}</b> · <b>{bytes(day)}</b> in 24h
        </span>
        <span className={CHART_NOW}>
          {num(now, 1)}
          <span className="ml-1 text-[0.75rem] text-muted-foreground [font-weight:450]">
            Mbps now
          </span>
        </span>
      </div>
      {/* A paired series: receive is the accent, send the info blue. */}
      <Trend values={values} tone={tone ?? 'accent'} height={76} />
    </div>
  )
}

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
      {/* The page's focal point: two lines of the same day, each headed by
          its own rate now, its peak and its volume — so the six figures read
          as the charts' captions rather than as a strip of their own. */}
      <Direction
        label="Receiving"
        now={wire.inMbps}
        peak={Math.max(...wire.inHistory, 0)}
        day={wire.inDay}
        values={wire.inHistory}
      />
      <Direction
        label="Sending"
        now={wire.outMbps}
        peak={Math.max(...wire.outHistory, 0)}
        day={wire.outDay}
        values={wire.outHistory}
        tone="info"
      />
      <p className={FOOT}>
        Every byte over this box’s one network interface, in Mbps, which is not the same thing as
        internet traffic and is usually much more of it. A film streamed to the TV crosses this
        cable in full and never leaves the house. The line’s own capacity is the board below; these
        two numbers are not comparable and are deliberately not on one chart.
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
        // Healthy is the norm, so it is a word; only a broken hop is a chip.
        internet?.up === false || gateway?.up === false ? (
          <Chip tone={internet?.up === false ? 'bad' : 'warn'}>
            {internet?.up === false ? 'no internet' : 'no router'}
          </Chip>
        ) : (
          <span className={NOTE}>reachable</span>
        )
      }
    >
      {/* The one number on this page that cannot be read anywhere else on
          the box, so it is the board's headline rather than a table row. */}
      <div className="flex flex-col gap-0.5">
        <span className="text-[0.75rem] text-muted-foreground">Public address</span>
        <strong className="font-mono text-[1.45rem] leading-[1.2] tracking-[-0.02em] tabular-nums [font-weight:560]">
          {router.wan ?? DASH}
        </strong>
        <span
          className={cn(
            'text-[0.75rem]',
            router.wanError === null ? 'text-muted-foreground' : 'text-warning',
          )}
        >
          {router.wanError ?? 'this house, as Cloudflare’s edge sees it arrive'}
        </span>
      </div>
      {/* One row per hop: a light, the name, the round trip, and six hours
          of it. The sparkline sits last and unlabelled on purpose — it is
          context for the number beside it, not a chart anyone reads on its
          own. */}
      <ul className="m-0 list-none border-hairline border-y p-0">
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
      <Pairs
        rows={[
          { k: 'Default route', v: <span className={MONO}>{router.gateway}</span> },
          { k: 'This box', v: <span className={MONO}>{router.lan}</span> },
        ]}
      />
      <p className="m-0 flex items-baseline justify-between gap-3 border-hairline border-t pt-2.5 text-[0.8rem]">
        <span className="text-muted-foreground">Link, negotiated</span>
        <span className="tabular-nums [font-weight:520]">
          {wire.linkMbps === null ? DASH : `${num(wire.linkMbps)} Mbps`}
        </span>
      </p>
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
        router.firmware === null ? (
          <Chip tone="warn">not answering</Chip>
        ) : (
          <span className={NOTE}>firmware {router.firmware}</span>
        )
      }
    >
      {/* The one panel whose subject is a physical object in the house, so
          it carries a picture — small, as identity, beside the type. */}
      <div className="flex items-center gap-4">
        <img
          className="h-16 w-[104px] flex-none object-cover"
          src="/router-axe75.png"
          alt=""
          width={150}
          height={150}
        />
        <div className="flex min-w-0 flex-col items-start gap-1">
          <strong className="flex items-baseline gap-1.5 [text-wrap:balance] text-[1rem] tracking-[-0.01em] text-foreground [font-weight:600]">
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
        </div>
      </div>
      <Pairs
        rows={[
          { k: 'Built', v: router.built ?? DASH },
          { k: 'Address', v: <span className={MONO}>{router.gateway}</span> },
          { k: 'Round trip', v: rtt(gateway?.rttMs ?? null) },
        ]}
      />
      <Button asChild size="sm" variant="outline" className="mt-auto self-start">
        <a href={router.adminUrl} target="_blank" rel="noreferrer">
          Open the admin ↗
        </a>
      </Button>
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

export function TheLineItselfBoard({ f }: { f: GeneralFacts }) {
  const { line } = f
  return (
    <Board
      title="The line itself"
      icon="◎"
      span={8}
      aside={<span className={NOTE}>7 days, hourly</span>}
    >
      <Measures
        items={[
          { k: 'Down', v: `${num(line.down)} Mbps` },
          { k: 'Up', v: `${num(line.up)} Mbps` },
          { k: 'Latency', v: `${num(line.ping, 1)} ms` },
        ]}
      />
      {/* Side by side at this width: the two directions of one test, read
          against each other rather than one after the other. */}
      <div className="grid grid-cols-2 gap-5 @max-[30rem]/board:grid-cols-1">
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className="text-[0.75rem] text-muted-foreground">Download, Mbps</span>
          <Trend values={line.downHistory} tone="accent" height={72} />
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className="text-[0.75rem] text-muted-foreground">Upload, Mbps</span>
          <Trend values={line.upHistory} tone="info" height={72} />
        </div>
      </div>
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

export { WhatThisHouseAsksForBoard, WhichServicesMoveTheBytesBoard } from './general-tables'
