import { useState } from 'react'
import { Segmented } from '../../../../components/controls'
import type { NetworkData } from '../../data'
import { SWITCH_BAR, tone } from '../shared'
import { DdnsView } from './ddns'
import { CfTunnelView } from './tunnel'
import { WireguardView } from './wireguard'

// ── Coming in ──────────────────────────────────────────────────────────────

export type Inbound = Extract<NetworkData, { tab: 'wireguard' }>

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
 * fit none of them. What IS shared is the switch, whose buttons say which of
 * the three is working, all at once, so a broken one is visible without
 * visiting it. That is the whole reason they live on one tab instead of three.
 */
export function InboundView({ data }: { data: Inbound }) {
  // Direct first and selected by default: it is the plainest of the three —
  // a name resolving to this house's address, no proxy and no tunnel — and
  // the other two are each a layer added on top of it.
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
      {/* Each route's health rides the button that selects it — said once,
          in the only place it can be read without selecting the route. A
          separate status row would print each name twice. */}
      <div className={SWITCH_BAR}>
        <Segmented
          value={route}
          onChange={setRoute}
          label="Route"
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
