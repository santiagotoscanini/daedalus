import { LogBoard } from '../../../../components/logs'
import { Changelog } from '../../../../components/release-notes'
import { LinkRow, ServiceHead, verdictOf } from '../../../../components/service-head'
import { Button } from '../../../../components/ui/button'
import { Board, BoardGrid, Columns, Measures, Pulse } from '../../../../components/viz'
import { cn } from '../../../../lib/cn'
import { bytes, num } from '../../../../lib/format'
import { AXIS, EMPTY, FOOT, LIVE, MONO, NOTE } from '../shared'
import type { Inbound } from './index'

/**
 * The way back into the house.
 *
 * One question, really: can I get in, and is anything configured that should
 * not be. So the peer list is the page — every peer, whether or not it has
 * ever connected, with the handshake that is the only liveness WireGuard has.
 * A peer that exists and has never handshaken is a credential somebody was
 * issued and never used, which is worth seeing.
 */
export function WireguardView({ data }: { data: Inbound['wireguard'] }) {
  const f = wireguardFacts({ data })
  const { gap } = f

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
            from outside it. UDP 51820. A WireGuard socket does not answer an unauthenticated packet
            at all, which is why a forwarded port is acceptable here.
          </>
        }
        actions={
          data.url === null ? undefined : (
            <Button asChild size="sm">
              <a href={data.url} target="_blank" rel="noreferrer">
                Open wg-easy ↗
              </a>
            </Button>
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
        <PeersBoard f={f} />

        <AnyoneHomeBoard f={f} />

        <Changelog gap={gap} />

        {/* No neighbours: wg-easy runs the tunnel, the web UI and the exporter
            in one container, and nothing else on the box is part of it. */}
        <LogBoard source={{ container: 'wg-easy' }} title="wg-easy logs" />
      </BoardGrid>
    </>
  )
}

/** What the page's boards read. */
function wireguardFacts({ data }: { data: Inbound['wireguard'] }) {
  const { gap, counts, peers, daily } = data
  const live = counts.connected !== null && counts.connected > 0
  const max = Math.max(...peers.map((p) => p.rx + p.tx), 1)
  return { data, gap, counts, peers, daily, live, max }
}

type WireguardFacts = NonNullable<ReturnType<typeof wireguardFacts>>

function PeersBoard({ f }: { f: WireguardFacts }) {
  const { counts, peers, live, max } = f
  return (
    <Board
      title="Peers"
      icon="key"
      span={8}
      aside={
        <span className={LIVE}>
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
        <p className={EMPTY}>no peers configured</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
          {peers.map((p) => (
            // Fixed name and count tracks, not `auto`. Each row is its own
            // grid container, so a content-sized column is measured per
            // row — the bars would start at a different x on every line and
            // stop at a different one, which is the entire comparison this
            // list exists to make.
            <li
              className="grid min-w-0 grid-cols-[9.5rem_minmax(2rem,1fr)_2.6rem] items-center gap-x-2.5 gap-y-0.5 rounded-lg px-2 py-1.5 transition-colors hover:bg-foreground/[0.04]"
              key={p.name}
            >
              <span className="flex min-w-0 items-baseline gap-1.5 text-[0.8rem]">
                <span className="min-w-0 truncate" title={p.name}>
                  {p.name}
                </span>
                {/* Deliberately switched off is not a warning at all — it
                    explains the silence rather than reporting it. */}
                {!p.enabled && (
                  <em className="flex-none rounded-full px-1.5 text-[0.68rem] leading-4 text-muted-foreground not-italic ring-1 ring-hairline ring-inset [font-weight:550]">
                    disabled
                  </em>
                )}
                {p.handshakeAgo === null && (
                  <em className="flex-none rounded-full bg-warning/10 px-1.5 text-[0.68rem] leading-4 text-warning not-italic ring-1 ring-warning/25 ring-inset [font-weight:550]">
                    never used
                  </em>
                )}
              </span>
              <span className="block h-1 overflow-hidden rounded-full bg-foreground/[0.08]">
                <span
                  className="block h-full origin-left animate-[bar-grow_600ms_cubic-bezier(0.2,0.9,0.2,1)_both] rounded-full bg-info opacity-85 motion-reduce:animate-none"
                  style={{ width: `${String(Math.max(1.5, ((p.rx + p.tx) / max) * 100))}%` }}
                />
              </span>
              <span className="text-right text-[0.8rem] whitespace-nowrap tabular-nums">
                {bytes(p.rx + p.tx)}
              </span>
              {/* Interpuncts are generated between the items rather than
                  typed, so a peer with no address does not trail a
                  separator into empty space. */}
              <span className="col-span-full flex min-w-0 flex-wrap gap-x-1.5 gap-y-0 text-[0.72rem] text-muted-foreground tabular-nums [&>span+span]:before:mr-1.5 [&>span+span]:before:text-border [&>span+span]:before:content-['·']">
                {p.ipv4 !== null && <span className={cn(MONO, 'truncate')}>{p.ipv4}</span>}
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

      <p className={FOOT}>
        {/* The distinction that trips people up: WireGuard is
            connectionless, so there is no session to be in or out of. */}
        Ranked by total traffic. WireGuard has no connections to count. A peer is
        &ldquo;connected&rdquo; only in the sense that it exchanged a handshake recently, so a phone
        that is asleep reads as absent and is not. The byte counters are cumulative and reset when
        wg-easy restarts, which is why they are a ranking here rather than a rate.
      </p>
    </Board>
  )
}

function AnyoneHomeBoard({ f }: { f: WireguardFacts }) {
  const { daily } = f
  return (
    <Board
      title="Anyone home"
      icon="clock"
      span={4}
      aside={<span className={NOTE}>peak per day, 14d</span>}
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
        <p className={AXIS}>
          <span>{daily[0]?.date.slice(5)}</span>
          <span>peers at peak</span>
          <span>{daily[daily.length - 1]?.date.slice(5)}</span>
        </p>
      )}
      <p className={FOOT}>
        Peak rather than average, because the question is whether the tunnel got used at all and a
        twenty-minute session averages to nearly nothing over a day. An empty column is a day nobody
        was away from the house, not a fault.
      </p>
    </Board>
  )
}
