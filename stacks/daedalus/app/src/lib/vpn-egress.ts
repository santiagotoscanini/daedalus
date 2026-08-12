import { arrayOf, bool, num, obj, optional, str } from './contract/decode'
import { readEnvJson } from './contract/env'

// The gluetun tenancy map, as nix derived it from fleet.vpnEgress plus each
// tenant's own --network=container: flag (see the VPN_EGRESS binding in
// stacks/daedalus/daedalus.nix). Parsed in one place — server/category.ts and
// the network category previously each carried their own cast of the same
// variable, under two different local type names.

export type VpnEgress = {
  container: string
  exporter: string
  job: string
  controlPort: number
  subject: string
  provider: string
  keyExpiry: string
  runbook: string
  portForwarding: boolean
  tenants: string[]
}

const shape = arrayOf(
  obj({
    container: str,
    exporter: str,
    job: str,
    controlPort: num,
    subject: optional(str, ''),
    provider: optional(str, ''),
    keyExpiry: optional(str, ''),
    runbook: optional(str, ''),
    portForwarding: optional(bool, false),
    tenants: optional(arrayOf(str), []),
  }),
)

export function declaredVpnEgress(): VpnEgress[] {
  return readEnvJson('VPN_EGRESS', shape, [])
}
