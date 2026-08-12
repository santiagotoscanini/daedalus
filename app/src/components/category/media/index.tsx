import type { MediaData } from '../../../lib/dashboard/categories/media'
import { CalibreView } from './calibre'
import { CleanupView } from './cleanup'
import { DownloadersView } from './downloaders'
import { ProwlarrView } from './indexer'
import { JellyfinView } from './jellyfin'
import { WantedView } from './wanted'

// The Media pages — a tab per job, and a switch inside the page for the
// services that share one.
//
// Every service page opens the way the AI and Gaming tabs do: artwork, the
// name, the version running, the verdict on whether that version is current,
// one sentence saying where this service sits in the chain, and the link you
// came to click. Sixteen containers whose UIs look nothing alike become pages
// that are read the same way.
//
// ── why some tabs hold three services ─────────────────────────────────────
//
// Because the split between them is the software's, not the reader's. Seerr,
// Sonarr and Radarr answer one question — what should be here that isn't —
// and a tab each meant reassembling that answer from three pages. The switch
// is the same one Network uses for its three ways in, down to the health dot
// riding the button that selects each option, which is the only place that dot
// can be read without first selecting the thing it belongs to.

export function MediaView({ data }: { data: MediaData }) {
  switch (data.tab) {
    case 'jellyfin':
      return <JellyfinView d={data} />
    case 'calibre':
      return <CalibreView d={data} />
    case 'wanted':
      return <WantedView d={data} />
    case 'indexer':
      return <ProwlarrView d={data} />
    case 'downloaders':
      return <DownloadersView d={data} />
    case 'cleanup':
      return <CleanupView d={data} />
  }
}
