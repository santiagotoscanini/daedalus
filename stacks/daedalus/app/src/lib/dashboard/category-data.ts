import type { CategoryName } from './nav'

// The compile-time contract between the three category records.
//
// TYPES ONLY, deliberately: this file is imported by the server loaders
// (server/category.ts), the client views (components/category/registry.tsx)
// and the route — value imports here would pull every category's node-builtin
// data graph into client chunks, which is the exact thing the split-module
// design exists to prevent. The type-only imports below erase at compile
// time.
//
// Adding a category is: the CategoryName union in nav.ts, an entry here, a
// loader in LOADERS and a view in VIEWS — and the compiler refuses to build
// until all four agree. The switches this replaced enforced none of that.

import type { AiData } from './categories/ai'
import type { GamingData } from './categories/gaming'
import type { HomeData } from './categories/home'
import type { MediaData } from './categories/media'
import type { MonitoringData } from './categories/monitoring'
import type { NetworkData } from './categories/network'
import type { SystemData } from './categories/system'

export type CategoryDataMap = {
  ai: AiData
  media: MediaData
  home: HomeData
  network: NetworkData
  system: SystemData
  monitoring: MonitoringData
  gaming: GamingData
}

/** What one boards request answers: the category it is for, and its data. */
export type CategoryPayload = {
  [K in CategoryName]: { kind: K; data: CategoryDataMap[K] }
}[CategoryName]
