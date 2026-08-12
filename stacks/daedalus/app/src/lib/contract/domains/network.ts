import { join } from 'node:path'
import { arrayOf, bool, obj, optional, str } from '../decode'
import { readSnapshot } from '../snapshot'

// /export/network.json — the resolver facts, contributed by the pihole stack
// that owns the settings (see the note there on why lanHosts reads FTL's
// merged config rather than fleet.dnsHosts).

export type NetworkFacts = {
  lanHosts: { ip: string; host: string }[]
  dnsUpstreams: string[]
  dhcp: {
    active: boolean
    router: string
    start: string
    end: string
    leaseTime: string
    hosts: string[]
  }
}

const shape = obj({
  lanHosts: optional(arrayOf(obj({ ip: str, host: str })), []),
  dnsUpstreams: optional(arrayOf(str), []),
  dhcp: optional(
    obj({
      active: optional(bool, false),
      router: optional(str, ''),
      start: optional(str, ''),
      end: optional(str, ''),
      leaseTime: optional(str, ''),
      hosts: optional(arrayOf(str), []),
    }),
    { active: false, router: '', start: '', end: '', leaseTime: '', hosts: [] },
  ),
})

const EMPTY: NetworkFacts = {
  lanHosts: [],
  dnsUpstreams: [],
  dhcp: { active: false, router: '', start: '', end: '', leaseTime: '', hosts: [] },
}

export async function networkFacts(): Promise<NetworkFacts> {
  const r = await readSnapshot({
    path: join(process.env.EXPORT_DIR ?? '/export', 'network.json'),
    decoder: shape,
    fallback: EMPTY,
    acceptVersions: [1],
  })
  return r.data
}
