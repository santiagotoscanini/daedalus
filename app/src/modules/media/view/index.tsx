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
// came to click. Containers whose UIs look nothing alike become pages that are
// read the same way.
//
// Why some tabs hold several services is written on `Tabs` in ../data. The
// switch carries each option's health dot on its button, as Network's does —
// the only place a dot can be read without first selecting its service.

export const views = defineViews<typeof manifest, Tabs>(manifest, {
  jellyfin: ({ data }) => <JellyfinView d={data} />,
  calibre: ({ data }) => <CalibreView d={data} />,
  wanted: ({ data }) => <WantedView d={data} />,
  indexer: ({ data }) => <ProwlarrView d={data} />,
  downloaders: ({ data }) => <DownloadersView d={data} />,
  cleanup: ({ data }) => <CleanupView d={data} />,
})
