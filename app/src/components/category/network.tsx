import { useState } from 'react'

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
import { ReleaseNotes, UpgradeChain } from '../release-notes'
import { LinkRow, ServiceHead } from '../service-head'
import { Segmented } from '../ui'
import { Topology, type TopoEdge, type TopoStage } from '../topology'
import { DASH, bytes, flag, num, pct, since, until } from '../../lib/dashboard/format'
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
      return <WireguardView data={data} />
    case 'outbound':
      return <OutboundView data={data} />
    default:
      return <GeneralView data={data} />
  }
}

function GeneralView({ data }: { data: Extract<NetworkData, { tab: 'general' }> }) {
  const { wan, proxy, dns, tunnel, certs } = data

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
          fill
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
          fill
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
              // The WireGuard peer count used to be here, in a board about
              // Cloudflare, because there was nowhere better. There is now.
              {
                k: 'Certificate',
                v:
                  certs.soonestDays === null ? DASH
                  : certs.soonestDays < 14 ?
                    <span className="text-bad">{certs.soonestDays.toFixed(0)}d left</span>
                  : `${certs.soonestDays.toFixed(0)}d left`,
              },
            ]}
          />
          {/* One entrypoint-level wildcard covers every hostname, so these all
              move together — the soonest expiry IS the estate's expiry. */}
          <p className="board-foot">
            One wildcard certificate covers every hostname, so they renew together.
          </p>
        </Board>

        <Board
          title="Through the proxy"
          icon="⇄"
          span={6}
          fill
          aside={<span className="board-note">requests/min, 10 min average</span>}
        >
          <BarList
            items={proxy.byService.map((s) => ({
              label: s.label,
              value: s.value,
              display: s.value.toFixed(1),
            }))}
            empty="no traffic"
          />
          <h4 className="board-sub">Response codes</h4>
          <BarList
            items={proxy.byCode.map((c) => ({
              label: c.label,
              value: c.value,
              display: c.value.toFixed(1),
              tone: codeTone(c.label),
            }))}
            empty="no traffic"
          />
          <Facts
            rows={[
              { k: 'Routers', v: num(proxy.routers) },
              { k: 'Services', v: num(proxy.services) },
              { k: 'Open connections', v: num(proxy.openConnections) },
            ]}
          />
          {/* rootlessport rewrites the client address on published ports, so
              every LAN and WireGuard request arrives as a bridge address. */}
          <p className="board-foot">
            Client addresses here are bridge addresses — published ports rewrite the source IP.
          </p>
        </Board>

        <Board title="DNS" icon="◎" span={6} fill>
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

        <Board title="Certificates" icon="⌸" span={12}>
          <ul className="certs">
            {certs.expiring.map((c) => (
              <li key={c.name} className="certs-row">
                <span className="certs-name">{c.name}</span>
                {/* 90 days is Let's Encrypt's full lifetime, so the bar reads
                    as "how much of this certificate is left". */}
                <Progress
                  pct={Math.min(100, (c.days / 90) * 100)}
                  tone={c.days < 14 ? 'bad' : c.days < 30 ? 'warn' : 'ok'}
                />
                <span className="certs-days">{c.days.toFixed(0)}d</span>
              </li>
            ))}
          </ul>
          {certs.expiring.length === 0 && <p className="viz-empty">no probes reporting a certificate</p>}
          <p className="board-foot">
            Soonest five, from the outside — this is what a browser sees, not what is on disk.{' '}
            <Chip tone="muted">gatus</Chip>
          </p>
        </Board>
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
  const { tunnel, wireguard, proxy, certs, dns } = data
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
            { k: 'cert', v: certs.soonestDays === null ? DASH : `${certs.soonestDays.toFixed(0)}d` },
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
          facts: [{ k: 'upstreams', v: num(proxy.services) }],
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

// ── Coming in: WireGuard ───────────────────────────────────────────────────

/**
 * The way back into the house.
 *
 * One question, really: can I get in, and is anything configured that should
 * not be. So the peer list is the page — every peer, whether or not it has
 * ever connected, with the handshake that is the only liveness WireGuard has.
 * A peer that exists and has never handshaken is a credential somebody was
 * issued and never used, which is worth seeing on a list of two.
 */
function WireguardView({ data }: { data: Extract<NetworkData, { tab: 'wireguard' }> }) {
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
          <a className="btn btn-primary" href="https://wg.toscanini.me" target="_blank" rel="noreferrer">
            Open wg-easy ↗
          </a>
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
          fill
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
          fill
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

        <Board
          title={gap.behind.length === 0 ? 'Release notes' : `${String(gap.behind.length)} to apply`}
          icon="≡"
          span={12}
          aside={<span className="board-note">github releases</span>}
        >
          <UpgradeChain behind={gap.behind} />
          <ReleaseNotes
            releases={gap.releases}
            running={gap.installed}
            empty={gap.note ?? 'no published notes for this version'}
          />
        </Board>

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
        name={t.subject}
        // The exit address, not the version — there is no version to show
        // (gluetun's /v1/version is not in this instance's control-API allow
        // list) and the address is the more identifying fact anyway: it is
        // what the far side of every connection sees instead of this house.
        version={t.exit.ip}
        versionNote={`${flag(t.exit.country)} — where it comes out today`}
        verdict={
          t.up === null ? { label: 'unknown', tone: 'muted' }
          : t.up ? { label: 'up', tone: 'ok' }
          : { label: 'down', tone: 'bad' }
        }
        compare={[
          { k: 'Exit address', v: t.exit.ip, note: 'what the far side sees instead of this house' },
          { k: 'Carrier', v: t.exit.org, note: 'the provider’s own network, not ours' },
        ]}
        lede={
          <>
            gluetun holds a ProtonVPN WireGuard tunnel and owns a network namespace;{' '}
            <b>{t.tenants.length}</b> containers borrow it outright rather than having interfaces of
            their own. It is fail-closed, so a tunnel that drops takes their internet with it —
            which is the point, and the reason this page exists.
          </>
        }
        actions={
          data.tunnels.length > 1 ?
            <Segmented
              value={t.key}
              onChange={setSelected}
              options={data.tunnels.map((x) => ({ value: x.key, label: x.container.replace(/^gluetun-?/, '') || 'downloads' }))}
            />
          : undefined
        }
      />
      <LinkRow
        links={[
          { label: 'gluetun', href: 'https://github.com/qdm12/gluetun' },
          { label: 'ProtonVPN account', href: 'https://account.protonvpn.com/downloads' },
        ]}
      />

      <BoardGrid>
        <Board
          title="Staying up"
          icon="⛨"
          span={8}
          // Both halves of a pair fill, not just the shorter one. `fill` is
          // align-self:stretch, so whichever of the two turns out to be taller
          // sets the row height and the other grows into it — and which one
          // that is depends on data (ten tenants here, two on the other
          // tunnel), so it cannot be decided at write time.
          fill
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
          fill
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

        <Board
          title={
            t.build.behind.length === 0 ?
              'This build'
            : `${String(t.build.behind.length)} commits since this build`
          }
          icon="≡"
          span={12}
          aside={
            <span className="board-note">
              {t.build.running === null ?
                'gluetun master'
              : <span className="mono">{t.build.running}</span>}
              {t.build.builtOn !== null && ` · built ${t.build.builtOn}`}
            </span>
          }
        >
          {t.build.behind.length === 0 ?
            <p className="viz-empty">
              {t.build.note ?? t.build.running === null ?
                'gluetun states its build in its startup banner; nothing matching is in the log window.'
              : 'Nothing new on master since this image was built.'}
            </p>
          : <ul className="commits">
              {t.build.behind.map((c) => (
                <li key={c.sha}>
                  <a className="mono" href={c.url} target="_blank" rel="noreferrer">
                    {c.sha}
                  </a>
                  <span className="commit-subject">{c.subject}</span>
                  <span className="commit-date">{c.date}</span>
                </li>
              ))}
            </ul>
          }
          <p className="board-foot">
            {/* Why this is not the release-notes board every other service
                gets — and it is a correctness point, not a shortcut. */}
            Commits, not releases, and deliberately: this image is a digest-pinned{' '}
            <code>:latest</code>, which is master, and master has <b>diverged</b> from the v3.41.x
            release line — v3.41.2 ships an acknowledged port-forwarding deadlock that this box
            would trip, because it sets <code>VPN_PORT_FORWARDING_UP_COMMAND</code>. A release list
            here would advise a downgrade into a known bug. This is what a re-pull would actually
            bring. The build is read out of gluetun’s own startup banner in Loki, since its
            <code>/v1/version</code> endpoint is not in this instance’s control-server allow list.
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
