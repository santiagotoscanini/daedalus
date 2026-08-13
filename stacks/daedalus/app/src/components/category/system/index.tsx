import type { SystemData } from '../../../lib/dashboard/categories/system'
import { BackupsView } from './backups'
import { BuildView } from './build'
import { DatabaseView } from './database'
import { DisksView } from './disks'
import { HostView } from './host'
import { MemoryView } from './memory'
import { PoolsView } from './pools'
import { UpdatesView } from './updates'

// The System pages — a tab per layer of the machine.
//
// No ServiceHead on five of the six, unlike Media and Home: there is no
// service to name, no version to compare and no UI to open. The subject is the
// box, so each tab opens straight into the panel that answers its question.
// That is declared per tab in lib/dashboard/nav.ts (`head: false`) rather than
// merely omitted here, because the SKELETON has to know it before the data
// exists — see the note there.
//
// Database is the exception, and a real one rather than an inconsistency: its
// subject is postgres, which has a version, a release cycle, and minors that
// are almost entirely security and data-corruption fixes. Treating the one
// process every app on this box depends on as a "layer of the machine" is what
// kept the cluster's own upgrade state off this dashboard entirely.
//
// Half the tabs read prometheus and half read a snapshot the host publishes,
// and the pages say which where it matters — a SMART temperature is at most
// ten minutes old, a scrape is sixty seconds old, and on a page about failing
// hardware that difference is worth stating rather than hiding.

export function SystemView({ data }: { data: SystemData }) {
  switch (data.tab) {
    case 'host':
      return <HostView d={data} />
    case 'memory':
      return <MemoryView d={data} />
    case 'disks':
      return <DisksView d={data} />
    case 'pools':
      return <PoolsView d={data} />
    case 'build':
      return <BuildView d={data} />
    case 'database':
      return <DatabaseView d={data} />
    case 'updates':
      return <UpdatesView d={data} />
    case 'backups':
      return <BackupsView d={data} />
  }
}
