import { defineViews } from '../../../lib/modules/tabs'
import type { Tabs } from '../data'
import { manifest } from '../manifest'
import { PostgresView } from './postgres'

// The Database page — one tab, with a ServiceHead like Media's and Home's.
//
// Its subject is postgres, which has a version, a release cycle and minors
// that are almost entirely security and data-corruption fixes. It sat on
// System as the one tab there with a head, and treating the process every
// app depends on as a layer of the machine is what had kept the cluster's
// own upgrade state off this dashboard entirely.

export const views = defineViews<typeof manifest, Tabs>(manifest, {
  postgres: ({ data }) => <PostgresView d={data} />,
})
