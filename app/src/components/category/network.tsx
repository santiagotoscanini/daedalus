import {
  BarList,
  Board,
  BoardGrid,
  BigStat,
  Chip,
  Facts,
  Progress,
  Pulse,
  Ring,
  StatBand,
  Trend,
} from '../viz'
import { Topology, type TopoEdge, type TopoStage } from '../topology'
import { DASH, bytes, flag, num, since } from '../../lib/dashboard/format'
import type { NetworkData } from '../../server/category'

// The Network page, ordered the way traffic arrives: the WAN link, the two
// ways in (Cloudflare tunnel from outside, WireGuard for us), the proxy that
// terminates everything, the resolver every device depends on, and the VPN
// the download stack exits through.

export function NetworkView({ data }: { data: NetworkData }) {
  const { wan, proxy, dns, tunnel, wireguard, vpn, certs } = data

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
              { k: 'WireGuard peers', v: `${num(wireguard.connected)} of ${num(wireguard.total)}` },
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

        <Board title="WireGuard" icon="⚿" span={6}>
          {wireguard.peers.length === 0 ?
            <p className="viz-empty">no peers configured</p>
          : <ul className="peers">
              {wireguard.peers.map((p) => {
                // Under two minutes since the last handshake is the practical
                // definition of "connected" for WireGuard — the protocol is
                // silent otherwise, so there is nothing else to go on.
                const live = p.handshakeAgo !== null && p.handshakeAgo < 180
                return (
                  <li key={p.name} className="peers-row">
                    <span className="peers-name">
                      <Pulse on={live} tone="ok" />
                      {p.name}
                    </span>
                    <span className="peers-when">
                      {p.handshakeAgo === null ? 'never' : since(p.handshakeAgo)}
                    </span>
                    <span className="peers-bytes">
                      ↓{bytes(p.rx)} ↑{bytes(p.tx)}
                    </span>
                  </li>
                )
              })}
            </ul>
          }
          <Facts
            rows={[
              { k: 'Connected', v: num(wireguard.connected) },
              { k: 'Enabled', v: num(wireguard.enabled) },
              { k: 'Configured', v: num(wireguard.total) },
            ]}
          />
        </Board>

        <Board title="Download VPN" icon="⛨" span={6}>
          <div className="vpn-state">
            <Pulse on={vpn.up === true} tone={vpn.up === true ? 'ok' : 'bad'} />
            <strong>{vpn.up === null ? 'unknown' : vpn.up ? 'connected' : 'down'}</strong>
          </div>
          <Facts
            rows={[
              { k: 'Exit', v: flag(vpn.country) },
              { k: 'City', v: vpn.city ?? DASH },
              { k: 'Public IP', v: <span className="mono">{vpn.ip ?? DASH}</span> },
              {
                k: 'Forwarded port',
                v:
                  vpn.port === null ?
                    <span className="text-bad">not forwarded</span>
                  : <span className="mono">{vpn.port}</span>,
              },
            ]}
          />
        </Board>

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
function inboundStages(data: NetworkData): TopoStage[] {
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

function inboundEdges(data: NetworkData): TopoEdge[] {
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
function egressStages(data: NetworkData): TopoStage[] {
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

function egressEdges(data: NetworkData): TopoEdge[] {
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
