import { type PublishingFacts, publishingFacts } from './contract/domains/publishing'

// The gluetun tenancy map, as nix derived it from fleet.vpnEgress plus each
// tenant's own --network=container: flag (the derivation lives in
// nix/stacks/daedalus/daedalus.nix, contributed into the publishing domain).
// The one reader: server/tab-status.ts and the network module's Outbound tab
// both come through here.

export type VpnEgress = PublishingFacts['vpnEgress'][number]

export async function declaredVpnEgress(): Promise<VpnEgress[]> {
  return (await publishingFacts()).vpnEgress
}
