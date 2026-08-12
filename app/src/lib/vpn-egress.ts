import { type PublishingFacts, publishingFacts } from './contract/domains/publishing'

// The gluetun tenancy map, as nix derived it from fleet.vpnEgress plus each
// tenant's own --network=container: flag (the derivation lives in
// stacks/daedalus/daedalus.nix, contributed into the publishing domain).
// Read in one place — server/category.ts and the network category previously
// each carried their own cast of the same env blob.

export type VpnEgress = PublishingFacts['vpnEgress'][number]

export async function declaredVpnEgress(): Promise<VpnEgress[]> {
  return (await publishingFacts()).vpnEgress
}
