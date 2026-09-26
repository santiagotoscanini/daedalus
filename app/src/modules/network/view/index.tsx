import { defineViews } from '../../../lib/modules/tabs'
import type { Tabs } from '../data'
import { manifest } from '../manifest'
import { DhcpView } from './dhcp'
import { DnsView } from './dns'
import { GeneralView } from './general'
import { OutboundView } from './outbound'
import { TraefikView } from './proxy'
import { InboundView } from './wireguard'

// The Network module's views, one per tab. Why the tabs are cut the way they
// are is written on each tab in ../manifest.ts.

export const views = defineViews<typeof manifest, Tabs>(manifest, {
  general: GeneralView,
  wireguard: InboundView,
  proxy: TraefikView,
  dns: DnsView,
  dhcp: DhcpView,
  outbound: OutboundView,
})
