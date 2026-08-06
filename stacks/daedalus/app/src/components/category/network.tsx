import { useEffect, useState } from 'react'

import {
  BarList,
  Board,
  BoardGrid,
  BigStat,
  Chip,
  Columns,
  Facts,
  Measures,
  Progress,
  Pulse,
  Ring,
  StatBand,
  Trend,
} from '../viz'
import { GrafanaLogs, LogDetails } from '../logs'
import { Changelog } from '../release-notes'
import { LinkRow, ServiceHead } from '../service-head'
import { Segmented } from '../ui'
import { Topology, type TopoEdge, type TopoStage } from '../topology'
import { DASH, bytes, compact, flag, ms, num, pct, since, until } from '../../lib/dashboard/format'
import type { VersionGap } from '../../lib/dashboard/github'
import type { NetworkData } from '../../server/category'
import type { Tone } from '../viz'

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
    case 'gateway':
      return <GatewayView data={data} />
    case 'outbound':
      return <OutboundView data={data} />
    case 'domains':
      return <DomainsView data={data} />
    default:
      return <GeneralView data={data} />
  }
}

function GeneralView({ data }: { data: Extract<NetworkData, { tab: 'general' }> }) {
  const { wan, proxy, dns, tunnel } = data

  return (
    <>
      <StatBand>
        <BigStat
          label="Download"
          value={num(wan.down)}
          unit="Mbps"
          spark={wan.downHistory}
          sub={`${num(wan.up)} Mbps up`}
        />
        <BigStat
          label="Latency"
          value={num(wan.ping, 1)}
          unit="ms"
          tone="info"
          spark={wan.pingHistory}
          sub="last hourly test"
        />
        <BigStat
          label="Requests"
          value={num(proxy.rpm)}
          unit="/min"
          tone="accent"
          spark={proxy.spark}
          sub={`${num(proxy.routers)} routers`}
        />
        <BigStat
          label="Ads blocked"
          value={dns.blockedPct === null ? DASH : `${dns.blockedPct.toFixed(1)}%`}
          tone="ok"
          sub={`${num(dns.blocked)} of ${num(dns.queries)} queries`}
        />
      </StatBand>

      <BoardGrid>
        <Board
          title="Getting in"
          icon="⇥"
          span={12}
          aside={<span className="board-note">inbound · nothing here needs a forwarded TCP port</span>}
        >
          <Topology
            stages={inboundStages(data)}
            edges={inboundEdges(data)}
            foot={
              <>
                Two ways in and they cross the router differently. The tunnel is an OUTBOUND
                connection cloudflared holds open, so the edge reaches this box without the
                router ever accepting an inbound connection — no port forward, nothing to scan.
                WireGuard is the exception that proves it: it is the one service the router
                forwards a port for, UDP 51820, and the only reason that is acceptable is that
                a WireGuard socket does not answer an unauthenticated packet at all.
              </>
            }
          />
        </Board>

        <Board
          title="Getting out"
          icon="⇤"
          span={12}
          aside={<span className="board-note">egress · which traffic leaves through what</span>}
        >
          <Topology
            stages={egressStages(data)}
            edges={egressEdges(data)}
            foot={
              <>
                Two exits, and which one a container gets is decided by its network namespace,
                not by routing. Everything on a bridge leaves through the house connection with
                this address. The download stack has no interfaces of its own — it borrows
                gluetun's namespace outright, so if that tunnel drops those containers lose the
                network rather than falling back to the house line.
              </>
            }
          />
        </Board>

        <Board
          title="Internet link"
          icon="⇅"
          span={8}
          aside={<span className="board-note">7 days, hourly test</span>}
        >
          <h4 className="board-sub">Download, Mbps</h4>
          <Trend values={wan.downHistory} height={72} />
          <h4 className="board-sub">Upload, Mbps</h4>
          <Trend values={wan.upHistory} tone="info" height={56} />
          {/* The hourly test saturates the WAN for a couple of minutes and has
              historically taken LAN DNS down with it — worth knowing when a
              gap in another chart lines up with the top of an hour. */}
          <p className="board-foot">
            MySpeed runs on the hour and briefly saturates the link while it does.
          </p>
        </Board>

        <Board
          title="Cloudflare tunnel"
          icon="⇥"
          span={4}
          aside={
            <Chip tone={tunnel.status === 'healthy' ? 'ok' : 'bad'}>{tunnel.status ?? 'unknown'}</Chip>
          }
        >
          <div className="origin">
            <span className="origin-label">origin IP</span>
            <strong className="origin-ip">{tunnel.originIp ?? DASH}</strong>
            {/* The address the edge sees traffic arriving from — which is this
                house's WAN IP, and the only place on the box it can be read.
                Everything here is behind NAT and sees 192.168.0.2. */}
            <span className="origin-note">this house, as Cloudflare sees it</span>
          </div>
          <div className="vpn-state">
            <Pulse
              on={tunnel.status === 'healthy'}
              tone={tunnel.status === 'healthy' ? 'ok' : 'bad'}
            />
            <strong>
              {num(tunnel.connections)} connections{' '}
              {tunnel.edges.length > 0 && (
                <span className="muted">
                  via {tunnel.edges.map((e) => `${e.colo}×${String(e.count)}`).join(' · ')}
                </span>
              )}
            </strong>
          </div>
          <Facts
            rows={[
              { k: 'Requests', v: tunnel.requestsPerHour === null ? DASH : `${num(tunnel.requestsPerHour, 1)}/hour` },
              { k: 'Held for', v: since(tunnel.heldForSeconds).replace(' ago', '') },
              { k: 'cloudflared', v: <span className="mono">{tunnel.clientVersion ?? DASH}</span> },
              // The WireGuard peer count used to be here, and the certificate
              // expiry after it, both in a board about Cloudflare because
              // there was nowhere better. There is now, for both.
            ]}
          />
          <p className="board-foot">
            An outbound connection this box holds open, so the edge can reach it without the router
            accepting anything. The detail is on <b>Coming in</b>.
          </p>
        </Board>

        {/* The proxy had a board here — top services, response codes, router
            counts — and the Gateway tab now says all of it beside the routing
            table those numbers are about, which is where they answer something.
            Repeating them here would be the same figures a click apart. */}

        <Board title="DNS" icon="◎" span={6}>
          <div className="library-split">
            <Ring
              pct={dns.blockedPct}
              value={dns.blockedPct === null ? DASH : `${dns.blockedPct.toFixed(1)}%`}
              label="blocked"
              tone="ok"
            />
            <Facts
              rows={[
                { k: 'Queries today', v: num(dns.queries) },
                { k: 'Blocked', v: num(dns.blocked) },
                { k: 'On the blocklist', v: num(dns.gravity) },
              ]}
            />
          </div>
          <h4 className="board-sub">Most blocked domains</h4>
          <BarList items={dns.topBlocked} tone="bad" empty="nothing blocked yet" />
          <h4 className="board-sub">Busiest clients</h4>
          <BarList items={dns.topClients} tone="info" empty="no clients recorded" />
        </Board>

        {/* The two tunnels used to be boards here. They are tabs now — the
            same words meant two different things a scroll apart, and neither
            of them fitted in a half-row. What stays on this page is the map
            above, which is where both belong: a diagram of how traffic moves,
            not the detail of either end. */}

        {/* Certificates moved to the Gateway tab, and got better in the move:
            gatus reported one expiry per PROBE, which was forty copies of the
            same wildcard. traefik reports its store — two certificates, which
            is how many there are. */}
      </BoardGrid>
    </>
  )
}

function codeTone(code: string): 'ok' | 'info' | 'warn' | 'bad' {
  if (code.startsWith('2')) return 'ok'
  if (code.startsWith('3')) return 'info'
  if (code.startsWith('4')) return 'warn'
  return 'bad'
}

/**
 * Inbound: how a request reaches a service here, from wherever it started.
 *
 * Three ways in, not two, and the third is the one that is easy to forget:
 * most requests are from a device sitting on the LAN, which never touches the
 * router's WAN side at all. It gets here because Pi-hole answers every
 * *.toscanini.me with 192.168.0.2 — so the resolver is genuinely upstream of
 * traefik for the majority of traffic, and it hangs off the house zone.
 *
 * Authentication is drawn as ONE dependency rather than a branch of the
 * service tree, because that is what it is. traefik's forward-auth middleware
 * and an app's own OIDC login are two different mechanisms that both end at
 * Pocket ID — the difference is only who performs the redirect.
 */
function inboundStages(data: General): TopoStage[] {
  const { tunnel, wireguard, proxy, dns } = data
  const live = tunnel.status === 'healthy'
  const peersUp = wireguard.connected !== null && wireguard.connected > 0
  const busy = proxy.rpm !== null && proxy.rpm > 0

  return [
    {
      id: 'outside',
      title: 'Where it starts',
      zone: 'the internet',
      nodes: [
        {
          id: 'cf',
          label: 'Cloudflare edge',
          sub: tunnel.edges.map((e) => e.colo).join(' · ') || 'no edge reported',
          icon: '☁',
          tone: live ? 'ok' : 'bad',
          live,
          facts: [
            { k: 'status', v: tunnel.status ?? DASH },
            { k: 'conns', v: num(tunnel.connections) },
            { k: 'req/h', v: num(tunnel.requestsPerHour, 1) },
          ],
        },
        {
          id: 'wgpeer',
          label: 'WireGuard peers',
          sub: 'phones and laptops off-LAN',
          icon: '⚿',
          tone: peersUp ? 'ok' : 'muted',
          idle: !peersUp,
          live: peersUp,
          facts: [{ k: 'connected', v: `${num(wireguard.connected)} of ${num(wireguard.total)}` }],
        },
      ],
    },
    {
      id: 'house',
      title: 'This house',
      zone: 'this house',
      nodes: [
        {
          id: 'router',
          label: 'Router',
          sub: '192.168.0.1 — forwards two UDP ports and nothing else',
          icon: '⌗',
          tone: 'info',
          href: 'http://192.168.0.1',
          facts: [
            // The tunnel's origin address IS this house's WAN address: the CF
            // edge records where the connection came from, and nothing on this
            // side of the NAT can see it.
            { k: 'WAN', v: tunnel.originIp ?? DASH },
            { k: 'forwarded', v: 'wg + factorio' },
          ],
        },
        {
          id: 'lan',
          label: 'LAN devices',
          sub: 'laptops, phones, the TV — most of the traffic',
          icon: '▤',
          tone: 'accent',
          live: busy,
        },
      ],
      aside: [
        {
          label: 'how a LAN device finds this box at all',
          tone: 'ok',
          node: {
            id: 'pihole',
            label: 'Pi-hole',
            sub: 'answers every *.toscanini.me with 192.168.0.2',
            icon: '◎',
            tone: 'ok',
            href: 'https://pihole.toscanini.me',
            live: dns.queries !== null && dns.queries > 0,
            facts: [
              { k: 'queries', v: num(dns.queries) },
              { k: 'blocked', v: dns.blockedPct === null ? DASH : `${dns.blockedPct.toFixed(1)}%` },
            ],
          },
        },
      ],
    },
    {
      id: 'ingress',
      title: 'Ingress',
      zone: 'this box',
      nodes: [
        {
          id: 'cloudflared',
          label: 'cloudflared',
          sub: `holds the tunnel open · ${tunnel.clientVersion ?? 'client'}`,
          icon: '⇥',
          tone: live ? 'ok' : 'bad',
          live,
          facts: [{ k: 'held', v: since(tunnel.heldForSeconds).replace(' ago', '') }],
        },
        {
          id: 'wgeasy',
          label: 'wg-easy',
          sub: 'UDP 51820 — the one forwarded TCP-less way in',
          icon: '⚿',
          tone: peersUp ? 'ok' : 'muted',
          href: 'https://wg-easy.toscanini.me',
          idle: !peersUp,
        },
      ],
    },
    {
      id: 'proxy',
      title: 'Proxy',
      zone: 'this box',
      nodes: [
        {
          id: 'traefik',
          label: 'traefik',
          sub: 'TLS terminates here · one wildcard cert',
          icon: '⇄',
          tone: 'accent',
          href: 'https://traefik.toscanini.me',
          live: busy,
          facts: [
            { k: 'req/min', v: num(proxy.rpm) },
            { k: 'routers', v: num(proxy.routers) },
            // Certificate expiry was a third fact here. It is a number about
            // the proxy, not about the shape of the path, and it has a panel
            // of its own on the Gateway tab now.
          ],
        },
      ],
      aside: [
        {
          // Both auth paths end here. The middleware redirects for a gated
          // app; a native-OIDC app redirects itself. Same IdP either way.
          label: 'every login, both ways',
          tone: 'warn',
          node: {
            id: 'pocketid',
            label: 'Pocket ID',
            sub: 'passkeys · 32 clients',
            icon: '⛨',
            tone: 'warn',
            href: 'https://id.toscanini.me',
          },
        },
      ],
    },
    {
      id: 'services',
      title: 'Services',
      zone: 'this box',
      nodes: [
        {
          id: 'gated',
          label: 'Forward-auth apps',
          sub: 'traefik redirects before the app is dialled',
          icon: '⛨',
          tone: 'warn',
        },
        {
          id: 'native',
          label: 'Native-OIDC apps',
          sub: 'the app does its own redirect to Pocket ID',
          icon: '◈',
          tone: 'info',
        },
        {
          id: 'open',
          label: 'Open upstreams',
          sub: 'health paths, APIs with their own keys',
          icon: '▦',
          tone: 'muted',
          // No count: the one that was here was traefik's total service
          // count, which is every upstream on the box rather than the open
          // ones. The Gateway tab counts them properly, by protection.
        },
      ],
    },
  ]
}

function inboundEdges(data: General): TopoEdge[] {
  const { tunnel, wireguard, proxy } = data
  const live = tunnel.status === 'healthy'
  const peersUp = wireguard.connected !== null && wireguard.connected > 0
  const busy = proxy.rpm !== null && proxy.rpm > 0

  return [
    { from: 'cf', to: 'router', label: 'rides the open tunnel', tone: 'ok', active: live },
    {
      from: 'wgpeer',
      to: 'router',
      label: 'UDP 51820',
      tone: 'info',
      active: peersUp,
      dashed: !peersUp,
    },
    { from: 'router', to: 'cloudflared', label: 'no port forward', tone: 'ok', active: live },
    {
      from: 'router',
      to: 'wgeasy',
      label: 'forwarded',
      tone: 'info',
      active: peersUp,
      dashed: !peersUp,
    },
    // A LAN device never leaves the house: it resolves to 192.168.0.2 and
    // dials traefik straight on 443.
    { from: 'lan', to: 'cloudflared', label: '', tone: 'muted', dashed: true },
    { from: 'cloudflared', to: 'traefik', label: 'cfweb :8888', tone: 'ok', active: live },
    { from: 'wgeasy', to: 'traefik', label: 'then as a LAN client', tone: 'info', dashed: !peersUp },
    { from: 'traefik', to: 'gated', label: 'redirected first', tone: 'warn', active: busy },
    { from: 'traefik', to: 'native', label: 'proxied straight', tone: 'info', active: busy },
    { from: 'traefik', to: 'open', label: `${num(proxy.rpm)}/min`, tone: 'accent', active: busy },
  ]
}

/**
 * Egress: which exit a container's traffic leaves by.
 *
 * Two lanes that never touch, which is the point — the split is a network
 * NAMESPACE fact, not a routing rule. A bridged container has its own
 * interfaces and leaves by the house line; the download stack has none at all
 * and borrows gluetun's, so "it goes through the VPN" is structural rather
 * than something that could be misconfigured into leaking.
 */
function egressStages(data: General): TopoStage[] {
  const { vpn, tunnel, dns } = data
  const vpnUp = vpn.up === true

  return [
    {
      id: 'origin',
      title: 'Traffic',
      zone: 'this box',
      nodes: [
        {
          id: 'bridged',
          label: 'Bridged containers',
          sub: 'traefik-net, monitoring, app-db …',
          icon: '▦',
          tone: 'info',
        },
        {
          id: 'netns',
          label: 'Download stack',
          sub: 'qBittorrent, NZBGet, the *arrs, FlareSolverr',
          icon: '⛨',
          tone: vpnUp ? 'ok' : 'bad',
        },
      ],
      aside: [
        {
          label: 'resolves for the whole house first',
          tone: 'ok',
          node: {
            id: 'pihole-out',
            label: 'Pi-hole',
            sub: 'upstream to Google DNS over TLS',
            icon: '◎',
            tone: 'ok',
            facts: [{ k: 'blocklist', v: num(dns.gravity) }],
          },
        },
      ],
    },
    {
      id: 'stack',
      title: 'Network namespace',
      zone: 'this box',
      nodes: [
        {
          id: 'hostns',
          label: 'Own interfaces',
          sub: 'one veth pair per bridge',
          icon: '⌗',
          tone: 'info',
        },
        {
          id: 'gluetun',
          label: 'gluetun',
          sub: 'owns the namespace they all share',
          icon: '◈',
          tone: vpnUp ? 'ok' : 'bad',
          live: vpnUp,
          facts: [{ k: 'kill switch', v: vpnUp ? 'armed' : 'TUNNEL DOWN' }],
        },
      ],
    },
    {
      id: 'out',
      title: 'Seen from outside as',
      zone: 'the internet',
      nodes: [
        {
          id: 'house',
          label: 'House connection',
          sub: 'this address is the household',
          icon: '⌂',
          tone: 'info',
          facts: [{ k: 'IP', v: tunnel.originIp ?? DASH }],
        },
        {
          id: 'proton',
          label: 'ProtonVPN',
          sub: vpn.city === null ? 'exit node' : `${flag(vpn.country)} · ${vpn.city}`,
          icon: '◆',
          tone: vpnUp ? 'ok' : 'bad',
          live: vpnUp,
          facts: [
            { k: 'IP', v: vpn.ip ?? DASH },
            // A tunnel that is up but lost its forwarded port looks healthy
            // and cannot seed — worth its own slot rather than a footnote.
            { k: 'fwd port', v: vpn.port === null ? 'none' : String(vpn.port) },
          ],
        },
      ],
    },
  ]
}

function egressEdges(data: General): TopoEdge[] {
  const vpnUp = data.vpn.up === true
  return [
    { from: 'bridged', to: 'hostns', label: 'pasta / bridge', tone: 'info', active: true },
    {
      from: 'netns',
      to: 'gluetun',
      label: '--network=container:',
      tone: vpnUp ? 'ok' : 'bad',
      active: vpnUp,
    },
    { from: 'hostns', to: 'house', label: 'NAT', tone: 'info', active: true },
    {
      from: 'gluetun',
      to: 'proton',
      label: 'WireGuard',
      tone: vpnUp ? 'ok' : 'bad',
      active: vpnUp,
      dashed: !vpnUp,
    },
  ]
}

type General = Extract<NetworkData, { tab: 'general' }>

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
  const [route, setRoute] = useState<'wireguard' | 'tunnel' | 'direct'>('wireguard')
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
            { value: 'tunnel', label: 'Cloudflare tunnel', dot: tone(tunnelOk) },
            { value: 'wireguard', label: 'WireGuard', dot: tone(wgOk) },
            { value: 'direct', label: 'Direct', dot: tone(dnsOk) },
          ]}
        />
      </div>

      {route === 'tunnel' ?
        <CfTunnelView t={tunnel} />
      : route === 'direct' ?
        <DdnsView d={ddns} />
      : <WireguardView data={wireguard} />}
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
              gap.latest === null ? 'GitHub did not answer'
              : gap.behind.length === 0 ? 'this is what is running'
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

          {peers.length === 0 ?
            <p className="viz-empty">no peers configured</p>
          : <ul className="ranks">
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
          }

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
            Peak rather than average, because the question is whether the tunnel got used at all
            and a twenty-minute session averages to nearly nothing over a day. An empty column is a
            day nobody was away from the house — not a fault.
          </p>
        </Board>

        <Changelog gap={gap} />

        {/* No neighbours: wg-easy runs the tunnel, the web UI and the exporter
            in one container, and nothing else on the box is part of it. */}
        <Board title="Logs" icon="≡" span={12}>
          <GrafanaLogs source={{ container: 'wg-easy' }} title="wg-easy logs" />
        </Board>
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
    t.expiryDays < 0 ? 'bad'
    : t.expiryDays < 30 ? 'warn'
    : undefined

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
          data.gluetun.builtOn === null ?
            'the gluetun build every tunnel runs'
          : `built ${data.gluetun.builtOn} · every tunnel runs it`
        }
        verdict={
          data.gluetun.running === null ? { label: 'unknown', tone: 'muted' }
          : data.gluetun.behind.length === 0 ? { label: 'current', tone: 'ok' }
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
            data.gluetun.behind.length === 0 ?
              'gluetun — current'
            : `gluetun — ${String(data.gluetun.behind.length)} commits behind`
          }
          aside={
            <span className="board-note">
              {data.gluetun.running === null ?
                'build unknown'
              : <span className="mono">{data.gluetun.running}</span>}
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
              {t.up === null ? 'unknown'
              : t.up ? 'tunnel up'
              : 'tunnel down'}
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
              ...(t.portForwarding ?
                [{ k: 'forwarded port', v: t.port === null ? 'none yet' : String(t.port) }]
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
            underlined in red rather than left to a difference of a pixel. The WireGuard key
            expires <b>{t.keyExpiry}</b>, reminder mail goes out 30 and 7 days ahead, and the
            renewal runbook is the header of <code>{t.runbook}</code>.
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
            publish no ports of their own — only a namespace’s owner can — which is why every one
            of their UIs is published on the gluetun container instead.
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
            Asked of gluetun’s control API, which asks the provider — nothing on this box can
            answer it, because the container only ever sees a private tunnel address and the exit
            is only knowable from outside. The carrier is what an observer on the far side actually
            attributes this traffic to.
          </p>
        </Board>

        <Board title="Logs" icon="≡" span={12}>
          <GrafanaLogs source={{ container: t.container }} title={`${t.container} logs`} />
          {/* The one container genuinely tied to this tunnel and nothing else:
              it exists solely to poll this gluetun's control API, it shares
              its namespace, and it is where "the VPN alerts went quiet"
              is answered. */}
          <LogDetails
            summary="Exporter — the process the VPN alerts read"
            source={{ container: t.exporter }}
            title={`${t.exporter} logs`}
            foot={
              <p className="board-foot">
                Polls this tunnel’s control API every 30 seconds and serves the{' '}
                <code>gluetun_vpn_status</code> and forwarded-port metrics behind the chart above
                and the VPN-down alert. If those go stale while the tunnel is fine, the answer is
                here.
              </p>
            }
          />
        </Board>
      </BoardGrid>
    </>
  )
}

// ── Gateway ────────────────────────────────────────────────────────────────

type Gateway = Extract<NetworkData, { tab: 'gateway' }>

/**
 * The proxy and the gate, on one tab.
 *
 * They are separate programs with separate release cycles, so each gets its
 * own header and its own boards — but they are one subject, because neither
 * answers the question people actually bring to this page. "What can be
 * reached, and by whom" is half a routing table and half an identity
 * provider: traefik knows every published name and nothing about who is
 * behind a request, the IdP knows every account and nothing about the forty
 * names that never ask it anything. The routing table below is the join.
 */
function GatewayView({ data }: { data: Gateway }) {
  const [side, setSide] = useState<'traefik' | 'idp'>('traefik')
  const { traefik, idp } = data

  return (
    <>
      <div className="tunnel-bar">
        <Segmented
          value={side}
          onChange={setSide}
          options={[
            // Each dot is "did it answer us", which is the only claim this
            // page can make first-hand — gatus makes the fuller one, and it
            // is already on the tab these buttons sit under.
            { value: 'traefik', label: 'Traefik', dot: tone(traefik.version !== null) },
            { value: 'idp', label: 'Pocket ID', dot: tone(idp.users.length > 0) },
          ]}
        />
      </div>

      {side === 'idp' ?
        <IdpView d={idp} />
      : <TraefikView d={traefik} />}
    </>
  )
}

/** How each protection class reads, and in what order the table groups them. */
const PROTECTION: Record<
  Gateway['traefik']['routes'][number]['protection'],
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
function TraefikView({ d }: { d: Gateway['traefik'] }) {
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
              d.gap.latest === null ? 'GitHub did not answer'
              : d.gap.behind.length === 0 ? 'this is what is running'
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
                    <span className="item-main mono">{r.host.replace(/\.toscanini\.me$/, '')}</span>
                    {/* The chip is the whole point of the row: off-LAN means
                        the internet can ask, and the protection column beside
                        it says what answers. */}
                    {r.remote && <Chip tone="warn">off-LAN</Chip>}
                    {r.disabled && <Chip tone="bad">disabled</Chip>}
                    {/* An em dash is not zero: traefik labels no request
                        counters for its own dashboard's router, and a 0 there
                        would read as "nobody has opened it". */}
                    <span className="item-n">{r.requests === null ? DASH : compact(r.requests)}</span>
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
                    {e.label === 'websecure' ? 'LAN'
                    : e.label === 'cfweb' ? 'tunnel'
                    : e.label}{' '}
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
                  {c.covers === 0 ?
                    'answers for nothing published here'
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
        <Board title="Logs" icon="≡" span={12}>
          <GrafanaLogs
            source={{ container: 'traefik' }}
            title="Traefik logs"
            foot={
              <p className="board-foot">
                The service log, not the access log: startup, certificate renewals, configuration
                reloads and the errors behind a router that refused to build. Per-request lines go
                to the access log, which is not shipped here — the metrics above are what that
                answers.
              </p>
            }
          />
        </Board>
      </BoardGrid>
    </>
  )
}

/**
 * Pocket ID: who can get in, and who did.
 *
 * The audit log is the panel. It is the only record on this box of a person
 * signing in — traefik sees a 302 to the IdP and a 200 afterwards and cannot
 * tell you which human that was — and it is also the only way to find out
 * which of the registered applications anybody actually uses.
 */
function IdpView({ d }: { d: Gateway['idp'] }) {
  const { window: w } = d
  const shared = d.clients.filter((c) => c.sharesHost)
  const idle = d.clients.filter((c) => c.used === 0).length
  // The bar's scale. Not the list's order — see the note on the loader.
  const max = Math.max(...d.clients.map((c) => c.used), 1)

  return (
    <>
      <ServiceHead
        logo="/icon-pocket-id.svg"
        name="Pocket ID"
        version={d.version}
        versionNote="pinned in the flake"
        verdict={verdictOf(d.gap)}
        compare={[
          {
            k: 'Latest',
            v: d.gap.latest,
            note:
              d.gap.latest === null ? 'GitHub did not answer'
              : d.gap.behind.length === 0 ? 'this is what is running'
              : `${String(d.gap.behind.length)} release${d.gap.behind.length === 1 ? '' : 's'} between them`,
          },
          { k: 'Pinned by', v: null, note: 'an exact tag in stacks/pocket-id — it serves no version' },
        ]}
        lede={
          <>
            Passkeys only — there is no password on this box to guess, phish or reuse. Every admin
            UI either sits behind it at the proxy or signs in against it directly, so a single
            authentication here is what opens all of them for the day.
          </>
        }
        actions={
          <a
            className="btn btn-primary"
            href="https://id.toscanini.me"
            target="_blank"
            rel="noreferrer"
          >
            Open Pocket ID ↗
          </a>
        }
      />
      <LinkRow
        links={[
          { label: 'Docs', href: 'https://pocket-id.org/docs/introduction' },
          { label: 'GitHub', href: 'https://github.com/pocket-id/pocket-id' },
        ]}
      />

      <BoardGrid>
        {/* One board, not two. "Signing in" and "Applications" were the same
            audit log read twice — the chronological copy and the aggregate —
            and on a box where the control plane re-authorises on a timer, the
            chronological one spent ten of its twelve rows saying "opened
            Daedalus". What survives the merge is the half no aggregate covers:
            a credential actually being presented, and from what. */}
        <Board
          title="Signing in"
          icon="⚿"
          span={6}
          aside={
            <span className="board-note">
              {w.days} days · {d.clients.length} applications registered
            </span>
          }
        >
          <Measures
            items={[
              { k: 'passkey sign-ins', v: num(w.signIns) },
              { k: 'apps opened', v: num(w.authorizations) },
              { k: 're-consents', v: num(w.consents) },
              { k: 'people', v: num(w.people) },
            ]}
          />

          <Columns
            points={d.daily.map((p) => ({
              label: p.date.slice(5),
              value: p.authorizations,
              display: `${num(p.authorizations)} app${p.authorizations === 1 ? '' : 's'} opened`,
            }))}
            tone="ok"
            height={100}
            empty="nothing in the window"
          />
          {d.daily.length > 0 && (
            <p className="colaxis">
              <span>{d.daily[0]?.date.slice(5)}</span>
              <span>applications opened per day</span>
              <span>{d.daily[d.daily.length - 1]?.date.slice(5)}</span>
            </p>
          )}

          <AppList clients={d.clients} max={max} />

          {shared.length > 0 && (
            <p className="board-foot">
              {/* This said "duplicate" and blamed a rename. Both were wrong:
                  the pair is declared, and the module that declares it says
                  why. Reading a coincidence as a defect is worse than not
                  noticing it. */}
              <b>{num(shared.length)}</b> registrations answer for one hostname —{' '}
              {[...new Set(shared.map((c) => c.host ?? c.name))].join(', ')} — and that is a design
              rather than a leftover: the proxy gate and the app&rsquo;s own login are different
              consumers with different callbacks, and one client cannot hold both, because the
              generated one would overwrite the hand-written callbacks on every rebuild. Each of the
              pair says which it is. What is genuinely lost is attribution — both carry the same
              display name and the audit log records only the name, so one count covers the pair and
              cannot be split.
            </p>
          )}

          <p className="board-foot">
            The measures are the value of single sign-on stated as a subtraction:{' '}
            <b>{num(w.signIns)} passkey sign-ins</b> against{' '}
            <b>{num(w.authorizations)} applications opened</b> is{' '}
            {num(w.authorizations - w.signIns)} logins that did not have to happen. The list is
            ordered by when each was last used rather than by volume, so the five above are the
            recent activity and the {num(idle)} nobody opened at all sit at the end of the full one
            — which for a proxy-gated app means nobody visited it, not that the registration is
            dead. Open a row for who went in and from what; the full log is in Pocket ID. A{' '}
            <b>re-consent</b> is not a first use:
            rewriting a client drops its stored consent, and the convergence job rewrites every one
            of them on every rebuild, so these mark where a rebuild made everybody agree again.
            {d.truncated && ' The window is longer than the pages read, so these are a lower bound.'}
          </p>
        </Board>

        <Changelog gap={d.gap} span={6} />

        <Board title="Who" icon="◑" span={3}>
          <ul className="itemlist">
            {d.users.map((u) => (
              <li key={u.username} title={u.groups.join(', ')}>
                <span className="item-main">
                  {u.displayName}
                  {u.admin && <span className="muted"> · admin</span>}
                </span>
                {u.disabled && <Chip tone="bad">disabled</Chip>}
                {/* An admin account that is not a person, and the only place
                    on this dashboard it is visible at all. */}
                {u.service && (
                  <Chip tone="muted">
                    <span title="The principal behind STATIC_API_KEY — how daedalus reads this page">
                      api key
                    </span>
                  </Chip>
                )}
                <span className="item-side">
                  {u.service ? 'never signs in' : (u.lastSignInAgo ?? 'not in the window')}
                </span>
              </li>
            ))}
          </ul>

          <h4 className="board-sub">Groups</h4>
          <ul className="itemlist">
            {d.groups.map((g) => (
              <li key={g.name}>
                <span className="item-main">{g.name}</span>
                <span className="item-side">
                  {g.members === 0 ? 'nobody in it' : `${String(g.members)} member${g.members === 1 ? '' : 's'}`}
                </span>
              </li>
            ))}
          </ul>

          {/* Grouped, not listed: a passkey belongs to a device, so this is
              the inventory of things that can authenticate as somebody. The
              raw stream of when each one did is a log, and Pocket ID's own
              audit page is the place for that. */}
          <h4 className="board-sub">Devices that signed in</h4>
          {d.devices.length === 0 ?
            <p className="viz-empty">nobody signed in during the window</p>
          : <ul className="itemlist">
              {d.devices.map((v) => (
                <li key={v.name}>
                  <span className="item-main" title={v.name}>
                    {v.name}
                  </span>
                  <span className="item-side">{v.lastAgo}</span>
                  <span className="item-n">{num(v.signIns)}</span>
                </li>
              ))}
            </ul>
          }

          {/* A quarter of the width, so this says the things that change what
              the three lists above mean, and stops. */}
          <p className="board-foot">
            A group is what an application restricts itself to, so an empty one is an application
            nobody can reach through it. A passkey belongs to a device, so the devices are the
            credentials — one appearing that you do not recognise is the thing to notice here.
            Sign-ups are <b>{d.signups ?? 'unknown'}</b>, read back from the IdP rather than
            restated here.
          </p>
        </Board>

        <Board title="Logs" icon="≡" span={9}>
          <GrafanaLogs source={{ container: 'pocket-id' }} title="Pocket ID logs" />
          {/* The two units that WRITE the client list above. Neither is a
              container and neither has anywhere else on this dashboard to be
              read, which is the bar — and when a redirect URI is wrong after a
              rebuild, this is the log that says why. */}
          <LogDetails
            summary={
              <>
                <code>pocket-id-clients.service</code> — what put the applications there
              </>
            }
            source={{ unit: 'pocket-id-clients.service' }}
            title="pocket-id-clients"
            foot={
              <p className="board-foot">
                A systemd oneshot on the host, not a container — journal lines rather than container
                logs. Defined in <code>stacks/pocket-id/clients.nix</code>, ordered after the IdP,
                and run on every rebuild: it upserts one OIDC client per{' '}
                <code>fleet.ssoClients</code> entry — name, redirect URIs, allowed groups — with a
                full PUT of the body whether or not anything changed, which is what drops everyone’s
                stored consent. It creates and updates; it never deletes.
              </p>
            }
          />
          <LogDetails
            summary={
              <>
                <code>sso-client-secrets.service</code> — where each app’s credential comes from
              </>
            }
            source={{ unit: 'sso-client-secrets.service' }}
            title="sso-client-secrets"
            foot={
              <p className="board-foot">
                The other host oneshot from the same file, and the one that runs first. It generates
                a client secret per <code>fleet.ssoClients</code> entry into a gitignored file on
                disk, so the credential never enters the nix store — which is also why it cannot be
                a container: it writes host state the IdP is then told about. An app that suddenly
                cannot complete a login, having been fine, is usually this having handed it a secret
                the IdP no longer holds.
              </p>
            }
          />
        </Board>
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

/** How many registrations the list shows before it is asked for the rest. */
const APPS_SHOWN = 5

/**
 * The registration list, five deep until asked.
 *
 * Thirty-three rows is the whole answer to "which of these is still in use"
 * and about a screen and a half of it, most of which is the tail nobody
 * looks at. Five is the part that changes — the list is ordered by recency,
 * so the top of it IS the recent activity — and the rest is one click away
 * for the times the question is about the tail.
 */
function AppList({ clients, max }: { clients: Gateway['idp']['clients']; max: number }) {
  const [all, setAll] = useState(false)
  const shown = all ? clients : clients.slice(0, APPS_SHOWN)
  const rest = clients.length - APPS_SHOWN

  return (
    <>
      <h4 className="board-sub">
        {all ? 'Every registration' : `Last ${String(APPS_SHOWN)} used`}
      </h4>
      <ul className="idp-apps">
        {shown.map((c) => (
          <AppRow key={c.id} c={c} max={max} />
        ))}
      </ul>
      {rest > 0 && (
        <button
          type="button"
          className="btn btn-ghost idp-more"
          onClick={() => {
            setAll(!all)
          }}
        >
          {all ? 'Show fewer' : `Show all ${String(clients.length)}`}
        </button>
      )}
    </>
  )
}

/**
 * One registered application, with its accesses folded behind it.
 *
 * A `<details>` rather than two panels, because the two questions are nested
 * rather than parallel: "which of these is still in use" is asked of the whole
 * list at a glance, and "who went into THAT one, from what" is asked of one
 * row you are already looking at. Side by side, the second one was a column of
 * near-identical lines that read as a log — and this page is not trying to be
 * one. Pocket ID's own audit page is.
 *
 * A never-opened registration still gets a row, and still opens: it says so,
 * which is the answer.
 */
function AppRow({ c, max }: { c: Gateway['idp']['clients'][number]; max: number }) {
  const idle = c.used === 0

  return (
    <li>
      <details className="idp-app">
        <summary>
          <span className="idp-app-name">
            <span title={c.host ?? c.name}>{c.name}</span>
            {!c.restricted && <em title="Open to every account, not a named group">any account</em>}
            {/* Which of a hostname's registrations this one is. Not a fault
                badge — see the note on `role`. */}
            {c.role !== null && (
              <em
                className="is-muted"
                title={
                  c.role === 'gate' ?
                    'The credential traefik’s forward-auth middleware signs in with, before the request reaches the app at all'
                  : 'The credential the app itself runs its own login with'
                }
              >
                {c.role === 'gate' ? 'proxy gate' : 'app login'}
              </em>
            )}
          </span>
          {/* The bar carries the magnitude the ORDER no longer does. Muted
              for a row with nothing in it, so the tail of the list reads as
              a tail rather than as forty empty tracks. */}
          <span className={idle ? 'rank-track is-idle' : 'rank-track'}>
            {!idle && (
              <span
                className="rank-fill"
                style={{ width: `${String(Math.max(1.5, (c.used / max) * 100))}%` }}
              />
            )}
          </span>
          <span className="rank-n">{idle ? DASH : num(c.used)}</span>
          <span className="idp-app-when">{c.lastAgo ?? 'not in the window'}</span>
        </summary>

        <div className="idp-app-body">
          {c.opens.length === 0 ?
            <p className="viz-empty">
              Nobody opened this in the window. For an app behind the proxy gate that means nobody
              visited it — the registration is what the middleware itself signs in with.
            </p>
          : <ul className="itemlist">
              {c.opens.map((o) => (
                <li key={o.id}>
                  {/* Not "first time": the event recurs, and an access older
                      than it sitting below it is what gave that away. */}
                  {o.consent && (
                    <Chip tone="info">
                      <span title="A consent record was created here rather than reused — Pocket ID drops the stored one whenever the client is rewritten, which every rebuild does">
                        re-consented
                      </span>
                    </Chip>
                  )}
                  <span className="item-main">{o.username}</span>
                  <span className="item-side">{o.device}</span>
                  <span className="item-side">{o.ago}</span>
                </li>
              ))}
            </ul>
          }
          {c.used > c.opens.length && (
            <p className="board-foot">
              The {num(c.opens.length)} most recent of {num(c.used)}. The rest are in Pocket ID.
            </p>
          )}
        </div>
      </details>
    </li>
  )
}

/* The audit log's event names were translated here — "signed in", "opened",
   "first time" — for a raw stream that no longer exists. Nothing renders a
   verb now: the aggregates say which verb they counted, and the only events
   still shown are one kind, inside the row they belong to. */

/** Same three answers the AI tabs give, for the same reason — see ai.tsx. */
function verdictOf(gap: VersionGap): { label: string; tone: Tone } {
  if (gap.installed === null || gap.latest === null) return { label: 'unknown', tone: 'muted' }
  if (gap.behind.length === 0) return { label: 'current', tone: 'ok' }
  return { label: `${String(gap.behind.length)} behind`, tone: 'warn' }
}

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
              t.gap.latest === null ? 'GitHub did not answer'
              : t.gap.behind.length === 0 ? 'this is what is running'
              : `${String(t.gap.behind.length)} release${t.gap.behind.length === 1 ? '' : 's'} between them`,
          },
          { k: 'Pinned by', v: null, note: 'a digest in stacks/cloudflared' },
        ]}
        lede={
          <>
            An <b>outbound</b> connection cloudflared holds open to Cloudflare, which the edge then
            reaches this box through. So the router never accepts an inbound connection for it —
            no forwarded port, nothing to scan — and everything it carries is HTTP, terminated at
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
          { label: 'Docs', href: 'https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/' },
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
            {t.edges.length === 0 ?
              'the edge'
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
          {t.published.length === 0 ?
            <p className="viz-empty">could not read the tunnel’s ingress rules</p>
          : <ul className="itemlist">
              {t.published.map((p) => (
                <li key={p.hostname}>
                  <span className="item-main">{p.hostname.replace(/\.toscanini\.me$/, '')}</span>
                  <span className="item-side mono">{p.service.replace(/^https?:\/\//, '')}</span>
                </li>
              ))}
            </ul>
          }
          <p className="board-foot">
            Read back from the tunnel’s own ingress rules, which is the only list that decides
            anything — a hostname here is reachable from the internet, and one that is not here is
            not, whatever DNS says. Every entry is generated by a{' '}
            <code>webApps.exposeRemotely</code>, so this is that decision as Cloudflare received it.
            They all point at the same place: traefik’s plain-HTTP <code>cfweb</code> entrypoint.
          </p>
        </Board>

        <Changelog gap={t.gap} />

        <Board title="Logs" icon="≡" span={12}>
          <GrafanaLogs source={{ container: 'cloudflared' }} title="cloudflared logs" />
        </Board>
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
          !known ? { label: 'unknown', tone: 'muted' }
          : match ? { label: 'pointing here', tone: 'ok' }
          : { label: 'stale', tone: 'bad' }
        }
        compare={[
          { k: 'Actually here', v: d.actual, note: 'the address the tunnel reports arriving from' },
          { k: 'Kept current by', v: `ddclient ${d.version ?? ''}`.trim(), note: 'platform/ddclient, every 5 minutes' },
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
              {!known ? 'cannot tell'
              : match ? 'matches'
              : 'does not match'}
            </span>
          }
        >
          <Measures
            items={[
              { k: 'resolves to', v: d.resolved ?? DASH },
              { k: 'actually here', v: d.actual ?? DASH, tone: known && !match ? 'bad' : undefined },
              { k: 'record ttl', v: d.ttl === null ? DASH : until(d.ttl) },
              {
                k: 'rechecked every',
                v: d.intervalSeconds === null ? DASH : until(d.intervalSeconds),
              },
            ]}
          />

          <p className="board-foot">
            {match ?
              <>
                The name resolves to the address the tunnel reports traffic arriving from, so
                everything below can be reached.{' '}
              </>
            : known ?
              <>
                <b>They disagree.</b> The name is pointing somewhere this box is not, so everything
                below is unreachable from outside until ddclient catches up — its next run is within{' '}
                {d.intervalSeconds === null ? 'five minutes' : until(d.intervalSeconds)}.{' '}
              </>
            : <>One of the two could not be read, so this check is not currently making a claim. </>
            }
            Asked of <code>1.1.1.1</code> over HTTPS rather than this box’s resolver, deliberately:
            pi-hole short-circuits <code>*.toscanini.me</code> to the LAN address, which is right and
            would make this check answer itself.
          </p>

          {/* The failure that has no other symptom. Counted from the log
              because the unit exits 0 either way. */}
          {(d.lookupFailures.month ?? 0) > 0 && (
            <p className="rejected">
              ddclient could not work out this house’s address{' '}
              <b>{num(d.lookupFailures.day)}</b> times in the last day,{' '}
              <b>{num(d.lookupFailures.week)}</b> in the week and{' '}
              <b>{num(d.lookupFailures.month)}</b> in the month — its lookup against{' '}
              <code>cloudflare.com/cdn-cgi/trace</code> got no answer. Each run that fails publishes
              nothing, so a real address change during one would not be noticed until the next
              success.{' '}
              {d.monitored ?
                'It is in fleet.monitoredJobs, so a failure mails you.'
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
          {d.needs.length === 0 ?
            <p className="viz-empty">nothing declares a direct port</p>
          : <ul className="itemlist">
              {d.needs.map((n) => (
                <li key={n.name} title={n.note}>
                  <Chip tone="info">{n.proto}</Chip>
                  <span className="item-main">{n.name}</span>
                  <span className="item-side mono">{n.port}</span>
                </li>
              ))}
            </ul>
          }
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
          {d.history.length === 0 ?
            <p className="viz-empty">no change recorded in the log window</p>
          : <ul className="itemlist">
              {d.history.map((h) => (
                <li key={h.at}>
                  <span className="item-main mono">{h.ip}</span>
                  <span className="item-side">
                    {h.heldDays === null ?
                      'current'
                    : `held ${String(h.heldDays)}d`}{' '}
                    · {new Date(h.at).toLocaleDateString('en-CA')}
                  </span>
                </li>
              ))}
            </ul>
          }
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

        <Board title="Logs" icon="≡" span={12}>
          <GrafanaLogs
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
        </Board>
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
      {left === null ?
        'soon'
        // Overdue is a real state worth showing rather than clamping away: the
        // timer fires a little late, and a run that is genuinely stuck reads
        // as a countdown that sat at zero.
      : left === 0 ? 'due now'
      : <span className="mono">
          {String(Math.floor(left / 60)).padStart(2, '0')}:{String(left % 60).padStart(2, '0')}
        </span>
      }
    </span>
  )
}

// ── Domains ────────────────────────────────────────────────────────────────

type Domains = Extract<NetworkData, { tab: 'domains' }>

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
function DomainsView({ data }: { data: Domains }) {
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

      {side === 'zone' ?
        <ZoneView d={zone} />
      : <ResolverView d={resolver} lan={data.lan} />}
    </>
  )
}

// ── Domains: the resolver ──────────────────────────────────────────────────

/** The four ways a query ends, in the order they are tried. */
const SOURCES = [
  { k: 'cached' as const, label: 'From cache', tone: 'ok' as Tone },
  { k: 'local' as const, label: 'Answered here', tone: 'accent' as Tone },
  { k: 'forwarded' as const, label: 'Forwarded', tone: 'info' as Tone },
  { k: 'blocked' as const, label: 'Blocked', tone: 'warn' as Tone },
]

function ResolverView({ d, lan }: { d: Domains['resolver']; lan: Domains['lan'] }) {
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
              d.gap.latest === null ? 'GitHub did not answer'
              : d.gap.behind.length === 0 ? 'this is what is running'
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
            {d.clients.total === null ? 'LAN' : `${num(d.clients.total)} clients`} it has seen, hands
            out the addresses they use, and forwards whatever it cannot answer itself.
          </>
        }
        actions={
          <a
            className="btn btn-primary"
            href="https://pihole.toscanini.me/admin/"
            target="_blank"
            rel="noreferrer"
          >
            Open the admin ↗
          </a>
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
            {unserved.length === 0 ?
              ' Everything pointed at this box has a traefik router behind it.'
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
                  d.blocking.on === null ? DASH
                  : d.blocking.on ? 'on'
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

        <Board
          title="Addresses we hand out"
          icon="⊞"
          span={8}
          aside={
            <span className="board-note">
              {d.dhcp.active ? `${d.dhcp.start} – ${d.dhcp.end}` : 'DHCP is off'}
            </span>
          }
        >
          <ul className="dhcp">
            {d.dhcp.reservations.map((r) => (
              <li key={r.mac}>
                <span className="dhcp-ip mono">{r.ip}</span>
                <span className="dhcp-name">{r.name}</span>
                <span className="dhcp-mac mono">{r.mac}</span>
              </li>
            ))}
          </ul>
          <p className="board-foot">
            The resolver is the DHCP server too, so addresses on this LAN are decided here rather
            than by the router. These {d.dhcp.reservations.length} are fixed in nix — a device with
            a reservation is one something else on this box is allowed to name by address, which is
            why they are declared and not clicked in. Everything else gets whatever is free in{' '}
            <span className="mono">
              {d.dhcp.start} – {d.dhcp.end}
            </span>{' '}
            for {d.dhcp.leaseTime} at a time, with{' '}
            <span className="mono">{d.dhcp.router}</span> as its gateway.
          </p>
        </Board>

        <Board
          title="Leases"
          icon="⇌"
          span={4}
          aside={<span className="board-note">since FTL started</span>}
        >
          <Facts
            rows={[
              { k: 'Offers made', v: num(d.dhcp.counters.offers) },
              { k: 'Accepted', v: num(d.dhcp.counters.acks) },
              {
                k: 'Declined',
                v:
                  d.dhcp.counters.declines === null ? DASH
                  : d.dhcp.counters.declines === 0 ?
                    <span className="ok-text">0</span>
                  : <span className="warn-text">{num(d.dhcp.counters.declines)}</span>,
              },
              {
                k: 'Refused',
                v:
                  d.dhcp.counters.nak === null ? DASH
                  : d.dhcp.counters.nak === 0 ?
                    <span className="ok-text">0</span>
                  : <span className="warn-text">{num(d.dhcp.counters.nak)}</span>,
              },
            ]}
          />
          <p className="board-foot">
            Offers vastly outnumber acceptances and that is normal — a device wakes, is offered an
            address, and often already has one it is happy with. The two to watch are the bottom
            pair: a <b>decline</b> means a client found the address already in use, a{' '}
            <b>refusal</b> means it asked for one this server would not give it. Both are zero on a
            LAN with one DHCP server, and non-zero is usually a second one.
          </p>
        </Board>

        <Changelog gap={d.gap} span={12} />

        <Board title="Logs" icon="≣" span={12}>
          <GrafanaLogs
            source={{ unit: "pihole-ftl.service" }}
            title="pihole-FTL logs"
            foot={
              <p className="board-foot">
                Not the journal. FTL is the one service on this box that keeps its own log file,
                and the only journal lines about the unit come from systemd — so these are shipped
                out of <span className="mono">/var/log/pihole/FTL.log</span> by alloy. Startup,
                gravity runs, DHCP leases, NTP and upstream trouble. Individual queries are not
                here and deliberately never will be: that log is two gigabytes of every domain
                every device in the house asked for.
              </p>
            }
          />
        </Board>
      </BoardGrid>
    </>
  )
}

// ── Domains: the zone ──────────────────────────────────────────────────────

/** Under a month is the point at which an expiry stops being a date. */
const EXPIRY_WARN_DAYS = 45

function expiryVerdict(r: Domains['zone']['registration']): { label: string; tone: Tone } {
  if (r.expiresIn === null) return { label: 'unknown', tone: 'muted' }
  const days = Math.floor(r.expiresIn / 86400)
  if (days < 0) return { label: 'expired', tone: 'bad' }
  if (days < EXPIRY_WARN_DAYS) return { label: `${String(days)} days left`, tone: 'warn' }
  return { label: `${String(days)} days left`, tone: 'ok' }
}

function ZoneView({ d }: { d: Domains['zone'] }) {
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
    d.cf.records === null ? 0 : d.cf.records - d.names.length - d.elsewhere.length - d.leftovers.length

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
          { label: 'RDAP record', href: `https://rdap.identitydigital.services/rdap/domain/${d.domain}` },
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
                  reg.expiresIn === null ? DASH
                  : <span className={expiryVerdict(reg).tone === 'ok' ? 'ok-text' : 'warn-text'}>
                      {until(reg.expiresIn)}
                    </span>,
              },
              { k: 'Held since', v: reg.registeredAgo === null ? DASH : `${since(reg.registeredAgo)}` },
              {
                k: 'Transfer lock',
                v:
                  reg.status.length === 0 ? DASH
                  : locked ?
                    <span className="ok-text">on</span>
                  : <span className="warn-text">off</span>,
              },
              {
                k: 'DNSSEC',
                v:
                  reg.signed === null ? DASH
                  : reg.signed ?
                    <span className="ok-text">signed</span>
                  : <span className="muted-text">not signed</span>,
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
          {d.mail.length === 0 ?
            <p className="viz-empty">no MX records in this zone</p>
          : d.mail.map((m) => (
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
                        m.dkim === 0 ? 'missing'
                        : `${String(m.dkim)} selector${m.dkim === 1 ? '' : 's'}`,
                      tone: m.dkim === 0 ? 'bad' : 'ok',
                    },
                    {
                      k: 'DMARC',
                      v: m.dmarc === null ? 'missing' : (m.dmarc.policy ?? 'set'),
                      tone:
                        m.dmarc === null ? 'bad'
                        : m.dmarc.policy === 'reject' ? 'ok'
                        : 'info',
                    },
                    {
                      k: 'Forgeries',
                      v:
                        m.spf === null ? 'unchecked'
                        : m.spf.qualifier === '-' ? 'rejected'
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
          }
          <p className="board-foot">
            The {mailRecords} records behind this read as one policy: SPF says which servers may
            send as this domain, DKIM signs what they send, DMARC says what a receiver should do
            when neither holds. <b>quarantine</b> means spam folder rather than bounce, and{' '}
            <b>accepted, marked</b> is an SPF ending in <span className="mono">~all</span> — a
            forgery is flagged rather than refused. Both are the cautious settings, and both are
            worth tightening once nothing legitimate is being caught by them. Open a domain to
            check the reading against the records it came from.
          </p>
        </Board>

        <Board
          title="The rest of the zone"
          icon="≡"
          span={6}
          aside={
            d.leftovers.length > 0 ?
              <Chip tone="warn">{d.leftovers.length} leftover</Chip>
            : <span className="board-note">{d.elsewhere.length} records</span>
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
            {d.tally.total === null ?
              'The zone could not be read.'
            : <>
                All {d.tally.total} records in the zone are on this page: {d.tally.house} pointing
                back here, {d.tally.mail} for mail, {d.tally.elsewhere} pointed elsewhere and{' '}
                {/* The tail is ONE expression on ONE line: JSX turns a newline
                    before an interpolation into a space, so splitting this
                    left the sentence ending in " ." */}
                {`${String(d.tally.leftovers)} left over${d.tally.unclassified > 0 ? `, plus ${String(d.tally.unclassified)} unclassified` : ''}.`}{' '}
                The count is Cloudflare’s and the groups are computed from it, so a record that
                stopped matching its rule shows up above rather than going missing.
              </>
            }
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
            changed but keeps no history of what it changed from, so this says when — never what, and
            never who.
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
  records: Domains['zone']['elsewhere']
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
