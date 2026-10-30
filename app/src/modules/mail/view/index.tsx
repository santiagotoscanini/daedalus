import { defineViews } from '../../../lib/modules/tabs'
import type { Tabs } from '../data'
import { manifest } from '../manifest'
import { ProtonView } from './proton'
import { RelayView } from './relay'

// The Email page: the relay every box has, and Proton Mail Bridge where the
// box runs it (../manifest.ts).

export const views = defineViews<typeof manifest, Tabs>(manifest, {
  relay: ({ data }) => <RelayView data={data} />,
  proton: ({ data }) => <ProtonView data={data} />,
})
