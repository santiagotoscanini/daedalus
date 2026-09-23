import { defineViews } from '../../../lib/modules/tabs'
import type { Tabs } from '../data'
import { manifest } from '../manifest'
import { ConsumersView } from './consumers'
import { GatewayView } from './gateway'
import { ProvidersView } from './providers'

// The AI pages, one per link of the chain.
//
// Providers is the one tab whose subject is several machines, so it carries
// its own picker and no ServiceHead. Gateway and Consumers open the way every
// service page here does — artwork, name, the version running, the verdict —
// because those are services on this box.

export const views = defineViews<typeof manifest, Tabs>(manifest, {
  providers: ({ data }) => <ProvidersView data={data} />,
  gateway: ({ data }) => <GatewayView data={data} />,
  consumers: ({ data }) => <ConsumersView data={data} />,
})
