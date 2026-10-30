import { defineViews } from '../../../lib/modules/tabs'
import type { Tabs } from '../data'
import { manifest } from '../manifest'
import { MatrixView } from './matrix'
import { ProtonView } from './proton'
import { RelayView } from './relay'

// The Communications page: the relay every box has, Proton Mail Bridge and
// the Matrix homeserver where the box runs them (../manifest.ts).

export const views = defineViews<typeof manifest, Tabs>(manifest, {
  relay: ({ data }) => <RelayView data={data} />,
  proton: ({ data }) => <ProtonView data={data} />,
  matrix: ({ data }) => <MatrixView data={data} />,
})
