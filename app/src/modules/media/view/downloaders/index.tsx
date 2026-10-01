import { useState } from 'react'
import { ServiceBar, tone } from '../shared'
import { MetubePage } from './metube'
import { NzbPage } from './nzbget'
import { QbtPage } from './qbittorrent'
import type { Downloaders } from './shared'
import { ShelfmarkPage } from './shelfmark'

/* ── Downloaders: qBittorrent, NZBGet, MeTube, Shelfmark ──────────────── */

export function DownloadersView({ d }: { d: Downloaders }) {
  // qBittorrent first: it is the one the *arrs reach for by default and the
  // only one of the four whose state changes minute to minute.
  const [which, setWhich] = useState<'qbt' | 'nzb' | 'metube' | 'shelfmark'>('qbt')

  return (
    <>
      <ServiceBar
        value={which}
        onChange={setWhich}
        options={[
          { value: 'qbt', label: 'qBittorrent', dot: tone(d.qbt.reachable) },
          { value: 'nzb', label: 'NZBGet', dot: tone(d.nzb.version !== null) },
          { value: 'metube', label: 'MeTube', dot: tone(d.metube.done !== null) },
          // Here rather than beside the shelf it fills — the manifest says why.
          { value: 'shelfmark', label: 'Shelfmark', dot: tone(d.shelfmark.counts !== null) },
        ]}
      />

      {which === 'qbt' ? (
        <QbtPage d={d} />
      ) : which === 'nzb' ? (
        <NzbPage d={d} />
      ) : which === 'shelfmark' ? (
        <ShelfmarkPage d={d} />
      ) : (
        <MetubePage d={d.metube} />
      )}
    </>
  )
}
