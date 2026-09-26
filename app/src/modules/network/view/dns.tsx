import { useState } from 'react'
import { Segmented } from '../../../components/controls'
import type { NetworkData } from '../data'
import { ResolverView } from './dns-resolver'
import { ZoneView } from './dns-zone'
import { SWITCH_BAR, tone } from './shared'

// ── DNS ────────────────────────────────────────────────────────────────
//
// The tab and its resolver/zone switch. Each side is its own file —
// dns-resolver.tsx and dns-zone.tsx — with dns-records.tsx the record list
// both folds of the zone use.

type Dns = Extract<NetworkData, { tab: 'dns' }>

/**
 * How a name becomes an address, on both sides of the front door: pi-hole for
 * the house, the zone for the internet. Why they share a tab is in
 * ../data/dns.ts.
 */
export function DnsView({ data }: { data: Dns }) {
  const [side, setSide] = useState<'resolver' | 'zone'>('resolver')
  const { resolver, zone } = data

  return (
    <>
      <div className={SWITCH_BAR}>
        <Segmented
          value={side}
          onChange={setSide}
          label="Resolver or zone"
          options={[
            { value: 'resolver', label: 'Resolver', dot: tone(resolver.queries.total !== null) },
            {
              value: 'zone',
              label: zone.domain,
              // Whether the zone could be READ, which is all this dot can
              // honestly claim. A zone does not go down — Cloudflare serves it
              // from their edge and this box is not in that path at all.
              dot: tone(zone.cf.records !== null),
            },
          ]}
        />
      </div>

      {side === 'zone' ? (
        <ZoneView d={zone} />
      ) : (
        <ResolverView d={resolver} lan={data.lan} admin={data.admin} />
      )}
    </>
  )
}
