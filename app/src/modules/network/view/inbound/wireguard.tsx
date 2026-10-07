import { LogBoard } from '../../../../components/logs'
import { Changelog } from '../../../../components/release-notes'
import { LinkRow, ServiceHead, verdictOf } from '../../../../components/service-head'
import {
  CELL_MONO,
  CELL_NAME,
  CELL_QUIET,
  TABLE,
  TABLE_EMPTY,
  TABLE_HEAD,
  TABLE_ROW,
} from '../../../../components/table'
import { TableSection } from '../../../../components/table-section'
import { Button } from '../../../../components/ui/button'
import { Board, BoardGrid, Chip, Columns, Measures, Pulse } from '../../../../components/viz'
import { cn } from '../../../../lib/cn'
import { bytes, DASH, num } from '../../../../lib/format'
import { AXIS, FOOT, LIVE, NOTE } from '../shared'
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
        <AnyoneHomeBoard f={f} />

        <PeersNowBoard f={f} />

        <PeersTable f={f} />

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
  return { data, gap, counts, peers, daily, live }
}

type WireguardFacts = NonNullable<ReturnType<typeof wireguardFacts>>

/** Peer · address · from it · to it · last handshake · total. Directions go first. */
const PEER_GRID =
  'grid items-center gap-x-6 px-5 grid-cols-[minmax(9rem,1.2fr)_minmax(6rem,0.8fr)_5rem_5rem_minmax(6rem,0.8fr)_5rem] @max-[44rem]/table:grid-cols-[minmax(8rem,1fr)_minmax(6rem,0.8fr)_minmax(5rem,0.7fr)_5rem] @max-[44rem]/table:[&>.dir]:hidden'

/** Configured, enabled, connected now: three counts and the live dot. */
function PeersNowBoard({ f }: { f: WireguardFacts }) {
  const { counts, live } = f
  return (
    <Board
      title="Peers"
      icon="key"
      span={4}
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
      <p className={FOOT}>
        {/* The distinction that trips people up: WireGuard is
            connectionless, so there is no session to be in or out of. */}
        WireGuard has no connections to count. A peer is &ldquo;connected&rdquo; only in the sense
        that it exchanged a handshake recently, so a phone that is asleep reads as absent and is
        not.
      </p>
    </Board>
  )
}

function PeersTable({ f }: { f: WireguardFacts }) {
  const { peers } = f
  return (
    <TableSection title="Every peer" aside="ranked by total traffic">
      <ul className={TABLE} aria-label="WireGuard peers">
        <li className={cn(PEER_GRID, TABLE_HEAD)}>
          <span>Peer</span>
          <span>Address</span>
          {/* Named rather than arrowed. An arrow on a VPN row is ambiguous by
              construction — the same byte is the peer's upload and the
              server's download — so these say which end they are counted at. */}
          <span className="dir text-right">From it</span>
          <span className="dir text-right">To it</span>
          <span>Last handshake</span>
          <span className="text-right">Total</span>
        </li>
        {peers.length === 0 && <li className={TABLE_EMPTY}>no peers configured</li>}
        {peers.map((p) => (
          <li key={p.name} className={cn(PEER_GRID, TABLE_ROW)}>
            <span className="flex min-w-0 items-center gap-2">
              <span className={CELL_NAME} title={p.name}>
                {p.name}
              </span>
              {/* Deliberately switched off is not a warning at all — it
                  explains the silence rather than reporting it. */}
              {!p.enabled && <Chip tone="muted">disabled</Chip>}
              {p.handshakeAgo === null && <Chip tone="warn">never used</Chip>}
            </span>
            <span className={CELL_MONO}>{p.ipv4 ?? DASH}</span>
            <span className={cn(CELL_QUIET, 'dir text-right')}>{bytes(p.rx)}</span>
            <span className={cn(CELL_QUIET, 'dir text-right')}>{bytes(p.tx)}</span>
            <span className={cn(CELL_QUIET, p.handshakeAgo === null && 'text-warning')}>
              {p.ago}
            </span>
            <span className="text-right text-foreground tabular-nums">{bytes(p.rx + p.tx)}</span>
          </li>
        ))}
      </ul>
      <p className={FOOT}>
        Ranked by total traffic. The byte counters are cumulative and reset when wg-easy restarts,
        which is why they are a ranking here rather than a rate. A peer that exists and has never
        handshaken is a credential somebody was issued and never used.
      </p>
    </TableSection>
  )
}

function AnyoneHomeBoard({ f }: { f: WireguardFacts }) {
  const { daily } = f
  return (
    <Board
      title="Anyone home"
      icon="clock"
      span={8}
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
