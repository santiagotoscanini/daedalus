import type { NetworkData } from '../../../lib/dashboard/categories/network'
import { DhcpView } from './dhcp'
import { DnsView } from './dns'
import { GeneralView } from './general'
import { OutboundView } from './outbound'
import { TraefikView } from './proxy'
import { InboundView } from './wireguard'

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
    case 'proxy':
      return <TraefikView d={data} />
    case 'outbound':
      return <OutboundView data={data} />
    case 'dns':
      return <DnsView data={data} />
    case 'dhcp':
      return <DhcpView data={data} />
    default:
      return <GeneralView data={data} />
  }
}
