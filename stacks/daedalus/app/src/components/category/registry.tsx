import type React from 'react'
import type { ReactNode } from 'react'
import type { CategoryDataMap, CategoryPayload } from '../../lib/dashboard/category-data'
import type { CategoryName } from '../../lib/dashboard/nav'
import { AiView } from './ai'
import { GamingView } from './gaming'
import { HomeView } from './home'
import { MediaView } from './media'
import { MonitoringView } from './monitoring'
import { NetworkView } from './network'
import { SystemView } from './system'

// The client half of the category registry — see lib/dashboard/category-data
// for the contract and server/category.ts for the loaders.
//
// STATIC imports, where the loaders are dynamic: these are React components
// with no server-only reach, and the route bundles them anyway. What must NOT
// appear here is a value import of anything under lib/dashboard/categories —
// that is the node-builtin data graph the client/server split keeps out of
// browser chunks.

const VIEWS: { [K in CategoryName]: (props: { data: CategoryDataMap[K] }) => ReactNode } = {
  ai: AiView,
  media: MediaView,
  home: HomeView,
  network: NetworkView,
  system: SystemView,
  monitoring: MonitoringView,
  gaming: GamingView,
}

export function CategoryBoards({ payload }: { payload: CategoryPayload }) {
  // TS cannot correlate an indexed record lookup with the union member the
  // same key selects; the cast carries what the mapped type already proved —
  // VIEWS[k] was declared against exactly CategoryDataMap[k]. Rendered as an
  // element, not called: a view is a component and may hold hooks.
  const View = VIEWS[payload.kind] as React.ComponentType<{ data: unknown }>
  return <View data={payload.data} />
}
