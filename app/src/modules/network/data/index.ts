// The Network module's data half: everything between a packet and this box.
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

import { defineLoader, type TabPayload } from '../../../lib/modules/tabs'
import { manifest } from '../manifest'
import { type DhcpData, loadDhcp } from './dhcp'
import { type DnsData, loadDns } from './dns'
import { type GeneralData, loadGeneral } from './general'
import { loadOutbound, type OutboundData } from './outbound'
import { loadProxy, type TraefikData } from './proxy'
import { type InboundData, loadInbound } from './wireguard'

export type Tabs = {
  general: GeneralData
  wireguard: InboundData
  proxy: TraefikData
  dns: DnsData
  dhcp: DhcpData
  outbound: OutboundData
}
export type NetworkData = TabPayload<typeof manifest, Tabs>

export const load = defineLoader<typeof manifest, Tabs>(manifest, {
  general: loadGeneral,
  wireguard: loadInbound,
  proxy: loadProxy,
  dns: loadDns,
  dhcp: loadDhcp,
  outbound: loadOutbound,
})

export type { Protection } from './proxy'
