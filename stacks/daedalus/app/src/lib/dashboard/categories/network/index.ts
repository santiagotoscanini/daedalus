// The Network category: everything between a packet and this box.
//
// Ordered the way traffic actually arrives — the WAN link, then the two ways
// in (Cloudflare tunnel from outside, WireGuard for us), then the proxy that
// terminates it, then the resolver every device on the LAN depends on, and
// finally the VPN the download stack exits through.
//
// Two readings here come from prometheus rather than the service's own API,
// and in both cases that is the better source rather than a fallback: MySpeed
// already exports its last test, and wg-easy v2 requires TOTP on /api/session
// so a credential login cannot work unattended at all.

import { type DhcpData, loadDhcp } from './dhcp'
import { type DnsData, loadDns } from './dns'
import { type GeneralData, loadGeneral } from './general'
import { loadOutbound, type OutboundData } from './outbound'
import { loadProxy, type TraefikData } from './proxy'
import { type InboundData, loadInbound } from './wireguard'

export type NetworkData =
  | ({ tab: 'general' } & GeneralData)
  | ({ tab: 'wireguard' } & InboundData)
  | ({ tab: 'proxy' } & TraefikData)
  | ({ tab: 'outbound' } & OutboundData)
  | ({ tab: 'dns' } & DnsData)
  | ({ tab: 'dhcp' } & DhcpData)

export async function loadNetwork(
  tab: string,
  ctx: { base: (app: string) => string; hc: string },
): Promise<NetworkData> {
  switch (tab) {
    case 'wireguard':
      return { tab: 'wireguard', ...(await loadInbound(ctx)) }
    case 'proxy':
      return { tab: 'proxy', ...(await loadProxy(ctx)) }
    case 'outbound':
      return { tab: 'outbound', ...(await loadOutbound(ctx)) }
    case 'dns':
      return { tab: 'dns', ...(await loadDns(ctx)) }
    case 'dhcp':
      return { tab: 'dhcp', ...(await loadDhcp()) }
    default:
      return { tab: 'general', ...(await loadGeneral()) }
  }
}

export type { Protection } from './proxy'
