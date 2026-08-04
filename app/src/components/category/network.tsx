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
