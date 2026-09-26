import { defineViews } from '../../../lib/modules/tabs'
import type { Tabs } from '../data'
import { manifest } from '../manifest'
import { PostgresView } from './postgres'

// The Database page — one tab, opening with a ServiceHead. Why it is its
// own module rather than a System tab: ../manifest.ts.

export const views = defineViews<typeof manifest, Tabs>(manifest, {
  postgres: ({ data }) => <PostgresView d={data} />,
})
