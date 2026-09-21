import { defineViews } from '../../../lib/modules/tabs'
import type { Tabs } from '../data'
import { manifest } from '../manifest'
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

export const views = defineViews<typeof manifest, Tabs>(manifest, {
  jellyfin: ({ data }) => <JellyfinView d={data} />,
  calibre: ({ data }) => <CalibreView d={data} />,
  wanted: ({ data }) => <WantedView d={data} />,
  indexer: ({ data }) => <ProwlarrView d={data} />,
  downloaders: ({ data }) => <DownloadersView d={data} />,
  cleanup: ({ data }) => <CleanupView d={data} />,
})
