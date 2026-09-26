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
 * How a name becomes an address, on both sides of the front door.
 *
 * Two halves of one sentence rather than two subjects: pi-hole answers
 * everything asked from inside the house, the base domain's zone answers
 * everything asked from outside it, and neither is legible alone. The zone
 * cannot explain why a name works on the sofa and not on mobile data; the
 * resolver cannot explain what the internet is told. The tables on both sides
 * are joined on the same list of published names.
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
