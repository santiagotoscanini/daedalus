import { useState } from 'react'
import { ServiceBar, tone } from '../shared'
import { ArrPage } from './arr'
import { BazarrPage } from './bazarr'
import { RecyclarrPage } from './recyclarr'
import { SeerrPage } from './seerr'
import type { Wanted } from './shared'

/* ── Wanted: Seerr, Sonarr, Radarr, Recyclarr, Bazarr ─────────────────── */

export function WantedView({ d }: { d: Wanted }) {
  // Seerr first: it is where a title enters the system, and the rest are what
  // happens to it afterwards, in the order the work flows.
  const [who, setWho] = useState<'seerr' | 'sonarr' | 'radarr' | 'recyclarr' | 'bazarr'>('seerr')

  return (
    <>
      <ServiceBar
        value={who}
        onChange={setWho}
        options={[
          { value: 'seerr', label: 'Seerr', dot: tone(d.seerr.version !== null) },
          { value: 'sonarr', label: 'Sonarr', dot: tone(d.sonarr.version !== null) },
          { value: 'radarr', label: 'Radarr', dot: tone(d.radarr.version !== null) },
          // Recyclarr sits with the two it configures rather than with the
          // cleaners. Its dot is its last run, not its reachability — it is
          // not a running process between runs, so there is nothing to reach.
          {
            value: 'recyclarr',
            label: 'Recyclarr',
            dot: d.recyclarr.lastRun === null ? null : tone(d.recyclarr.lastRun.ok),
          },
          { value: 'bazarr', label: 'Bazarr', dot: tone(d.bazarr.version !== null) },
        ]}
      />

      {who === 'seerr' ? (
        <SeerrPage d={d.seerr} />
      ) : who === 'recyclarr' ? (
        <RecyclarrPage d={d.recyclarr} />
      ) : who === 'bazarr' ? (
        <BazarrPage d={d.bazarr} />
      ) : (
        <ArrPage d={who === 'sonarr' ? d.sonarr : d.radarr} />
      )}
    </>
  )
}
