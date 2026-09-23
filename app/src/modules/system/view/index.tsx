import { ClaudeView, ShotterView } from '../../../components/claude'
import { defineViews } from '../../../lib/modules/tabs'
import type { Tabs } from '../data'
import { manifest } from '../manifest'
import { BackupsView } from './backups'
import { BuildView } from './build'
import { DisksView } from './disks'
import { HostView } from './host'
import { MemoryView } from './memory'
import { PoolsView } from './pools'
import { UpdatesView } from './updates'

// The System pages — a tab per layer of the machine.
//
// No ServiceHead on any of them, unlike Media and Home: there is no service
// to name, no version to compare and no UI to open. The subject is the box,
// so each tab opens straight into the panel that answers its question. That
// is declared per tab in the manifest (`head: false`) rather than merely
// omitted here, because the SKELETON has to know it before the data exists —
// see the note there. The shared postgres cluster, which was the exception,
// is the Database module.
//
// Half the tabs read prometheus and half read a snapshot the host publishes,
// and the pages say which where it matters — a SMART temperature is at most
// ten minutes old, a scrape is sixty seconds old, and on a page about failing
// hardware that difference is worth stating rather than hiding.

export const views = defineViews<typeof manifest, Tabs>(manifest, {
  host: ({ data }) => <HostView d={data} />,
  memory: ({ data }) => <MemoryView d={data} />,
  disks: ({ data }) => <DisksView d={data} />,
  pools: ({ data }) => <PoolsView d={data} />,
  build: ({ data }) => <BuildView d={data} />,
  updates: ({ data }) => <UpdatesView d={data} />,
  backups: ({ data }) => <BackupsView d={data} />,
  claude: ({ data }) => <ClaudeView data={data} />,
  shotter: ({ data }) => <ShotterView data={data} />,
})
